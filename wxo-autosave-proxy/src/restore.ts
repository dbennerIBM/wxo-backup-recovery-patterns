/**
 * Restore logic — unpacks a snapshot zip and runs ADK CLI commands in
 * dependency order (FR-5.3 → FR-5.10).
 *
 * Restore order: connections → tools → knowledge_bases → agent (FR-5.4).
 *
 * Each artefact produces a { artefact, status, message } log entry so the
 * popup can stream per-item progress.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  listConnectionNames,
  listToolNames,
  listKbIds,
  listKbDocuments,
  readConnectionMeta,
  readToolMeta,
  readKbDocument,
  readToolSource,
} from "./zip.js";
import type { ParsedZip } from "./zip.js";
import { toAdkAgentSpec, toAdkConnectionSpec, toAdkKnowledgeBaseSpec } from "./transform.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RestoreStatus = "ok" | "skipped" | "error";

export interface RestoreLogEntry {
  artefact: string;
  status:   RestoreStatus;
  message:  string;
}

// ─── ADK CLI helper ───────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

/**
 * Extract a human-readable failure reason from an execFile error.
 *
 * Exported for tests. Beware: `stderr` is an empty *string* (not undefined)
 * on spawn failures such as ENOENT, and some CLIs print errors to stdout —
 * so pick the first non-empty of stderr / stdout / message. Long CLI output
 * is trimmed to its tail, where the actual error line lives.
 */
export function extractAdkErrorDetail(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const detail =
    [e.stderr, e.stdout, e.message]
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .find((s) => s.length > 0) ?? String(err);
  const MAX = 600;
  return detail.length > MAX ? `…${detail.slice(-MAX)}` : detail;
}

/**
 * Run an ADK CLI command asynchronously (so the server can stream progress
 * between artefacts instead of blocking the event loop).
 * Returns stdout on success, throws with the CLI's error output on failure.
 */
async function runAdkCommand(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("orchestrate", args, {
      encoding: "utf-8",
      timeout:  60_000,   // 60 s per artefact
    });
    return stdout;
  } catch (err) {
    const detail = extractAdkErrorDetail(err);
    console.error(`[wxo-proxy] ADK command failed: orchestrate ${args.join(" ")}\n${detail}`);
    throw new Error(detail);
  }
}

// ─── Temp directory helpers ───────────────────────────────────────────────────

function createTempDir(): string {
  const dir = join(tmpdir(), `wxo-restore-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTempFile(dir: string, filename: string, contents: Uint8Array | string): string {
  const path = join(dir, filename);
  writeFileSync(path, contents);
  return path;
}

/** Decode and JSON-parse a zip entry (snapshot .yaml files are JSON-encoded). */
function readEntryJson(
  entries: ParsedZip["entries"],
  path: string,
): Record<string, unknown> | null {
  const data = entries[path];
  if (!data) return null;
  try {
    return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Per-artefact restore functions ───────────────────────────────────────────

async function restoreConnection(
  entries: ParsedZip["entries"],
  name: string,
  tempDir: string,
): Promise<RestoreLogEntry> {
  const meta = readConnectionMeta(entries, name);
  if (!meta) {
    return { artefact: `connection:${name}`, status: "error", message: "Could not read connection metadata from zip" };
  }

  const spec = toAdkConnectionSpec(meta);

  // Unknown auth scheme (e.g. MCP toolkit connections, captured kind "") —
  // no import spec can express it, but `connections add` still recreates the
  // app_id so dependent tool imports succeed.
  if (!spec) {
    try {
      await runAdkCommand(["connections", "add", "--app-id", meta.app_id]);
      return {
        artefact: `connection:${meta.app_id}`,
        status: "ok",
        message: "Created without auth configuration (unknown auth scheme) — configure the connection and re-enter credentials in wxO",
      };
    } catch (err) {
      // `connections add` is not idempotent: a 409 means it already exists,
      // which is fine for restore purposes (FR-5.11).
      if (String(err).includes("already exists")) {
        return { artefact: `connection:${meta.app_id}`, status: "skipped", message: "Connection already exists" };
      }
      return { artefact: `connection:${meta.app_id}`, status: "error", message: String(err) };
    }
  }

  const yamlPath = writeTempFile(tempDir, `${name}.yaml`, JSON.stringify(spec, null, 2));
  try {
    await runAdkCommand(["connections", "import", "--file", yamlPath]);
    return { artefact: `connection:${meta.app_id}`, status: "ok", message: "Imported — re-enter credentials in wxO" };
  } catch (err) {
    return { artefact: `connection:${meta.app_id}`, status: "error", message: String(err) };
  }
}

async function restoreTool(
  entries: ParsedZip["entries"],
  toolName: string,
  tempDir: string,
): Promise<RestoreLogEntry> {
  const meta = readToolMeta(entries, toolName);
  const label = `tool:${meta?.name ?? toolName}`;

  if (meta?.sourceUnavailable === true) {
    return { artefact: label, status: "skipped", message: "sourceUnavailable — skipped" };
  }

  const source = readToolSource(entries, toolName);
  if (!source) {
    return { artefact: label, status: "skipped", message: "No source file in zip — skipped" };
  }

  // Per-tool subdirectory — every python tool's source is named source.py,
  // so writing them all into tempDir directly would collide.
  const toolDir = join(tempDir, `tool-${toolName}`);
  mkdirSync(toolDir, { recursive: true });
  const sourcePath = writeTempFile(toolDir, source.filename, source.bytes);

  // Write requirements.txt if present alongside source.py.
  const reqData = entries[`tools/${toolName}/requirements.txt`];
  const reqPath  = reqData ? writeTempFile(toolDir, "requirements.txt", reqData) : undefined;

  // source.py → python tool; spec.yaml → OpenAPI tool.
  const kind = source.filename === "spec.yaml" ? "openapi" : "python";
  const args = ["tools", "import", "--kind", kind, "--file", sourcePath];
  if (reqPath) {
    args.push("--requirements", reqPath);
  }
  if (meta?.app_id) {
    args.push("--app-id", meta.app_id);
  }

  try {
    await runAdkCommand(args);
    return { artefact: label, status: "ok", message: "Imported" };
  } catch (err) {
    return { artefact: label, status: "error", message: String(err) };
  }
}

async function restoreKnowledgeBase(
  entries: ParsedZip["entries"],
  kbId: string,
  tempDir: string,
): Promise<RestoreLogEntry[]> {
  const label = `knowledge_base:${kbId}`;

  const rawMeta = readEntryJson(entries, `knowledge_bases/${kbId}/kb.yaml`);
  if (!rawMeta) {
    return [{ artefact: label, status: "error", message: "Could not read kb.yaml from zip" }];
  }

  // Write the captured documents to disk first — the ADK imports a KB and its
  // documents in one step, from a spec whose `documents` lists file paths.
  const docDir = join(tempDir, `kb-${kbId}-docs`);
  mkdirSync(docDir, { recursive: true });
  const documentPaths: string[] = [];
  for (const filename of listKbDocuments(entries, kbId)) {
    const bytes = readKbDocument(entries, kbId, filename);
    if (!bytes) continue;
    documentPaths.push(writeTempFile(docDir, filename, bytes));
  }

  // A built-in (Milvus) KB cannot be imported without documents.
  if (documentPaths.length === 0) {
    return [{ artefact: label, status: "skipped", message: "No captured documents — built-in knowledge bases cannot be imported empty" }];
  }

  try {
    const { spec } = toAdkKnowledgeBaseSpec(rawMeta, documentPaths);
    const kbYamlPath = writeTempFile(tempDir, `${kbId}-kb.yaml`, JSON.stringify(spec, null, 2));
    await runAdkCommand(["knowledge-bases", "import", "--file", kbYamlPath]);
    return [{ artefact: label, status: "ok", message: `Imported with ${documentPaths.length} document(s)` }];
  } catch (err) {
    return [{ artefact: label, status: "error", message: String(err) }];
  }
}

async function restoreAgent(
  entries: ParsedZip["entries"],
  tempDir: string,
): Promise<RestoreLogEntry> {
  const rawAgent = readEntryJson(entries, "agent/agent.yaml");
  if (!rawAgent) {
    return { artefact: "agent", status: "error", message: "agent/agent.yaml not found in zip" };
  }

  // The captured payload references tools and KBs by uuid; the ADK spec wants
  // names. Build the uuid → name maps from the zip's own metadata files.
  const toolIdToName = new Map<string, string>();
  for (const toolName of listToolNames(entries)) {
    const meta = readToolMeta(entries, toolName);
    if (meta?.id && meta.name) toolIdToName.set(meta.id, meta.name);
  }
  const kbIdToName = new Map<string, string>();
  for (const kbId of listKbIds(entries)) {
    const meta = readEntryJson(entries, `knowledge_bases/${kbId}/kb.yaml`);
    const kbName = typeof meta?.["name"] === "string" ? (meta["name"] as string) : null;
    if (kbName) kbIdToName.set(kbId, kbName);
  }

  try {
    const { spec, warnings } = toAdkAgentSpec(rawAgent, toolIdToName, kbIdToName);
    const yamlPath = writeTempFile(tempDir, "agent.yaml", JSON.stringify(spec, null, 2));
    await runAdkCommand(["agents", "import", "--file", yamlPath]);
    const message = warnings.length ? `Imported (${warnings.join("; ")})` : "Imported";
    return { artefact: "agent", status: "ok", message };
  } catch (err) {
    return { artefact: "agent", status: "error", message: String(err) };
  }
}

// ─── restoreFromZip ───────────────────────────────────────────────────────────

/**
 * Execute the full restore from an unpacked zip, in dependency order.
 * Returns a structured log entry per artefact (FR-5.10).
 *
 * When `onEntry` is provided it is invoked with each log entry as soon as its
 * artefact finishes, so the server can stream live progress to the popup.
 */
export async function restoreFromZip(
  zip: ParsedZip,
  onEntry?: (entry: RestoreLogEntry) => void,
): Promise<RestoreLogEntry[]> {
  const { entries } = zip;
  const log: RestoreLogEntry[] = [];
  const tempDir = createTempDir();

  const record = (entry: RestoreLogEntry): void => {
    log.push(entry);
    onEntry?.(entry);
  };

  try {
    // 1. Connections
    for (const name of listConnectionNames(entries)) {
      record(await restoreConnection(entries, name, tempDir));
    }

    // 2. Tools
    for (const toolName of listToolNames(entries)) {
      record(await restoreTool(entries, toolName, tempDir));
    }

    // 3. Knowledge bases
    for (const kbId of listKbIds(entries)) {
      for (const entry of await restoreKnowledgeBase(entries, kbId, tempDir)) {
        record(entry);
      }
    }

    // 4. Agent
    record(await restoreAgent(entries, tempDir));

  } finally {
    // Always clean up temp files.
    rmSync(tempDir, { recursive: true, force: true });
  }

  return log;
}
