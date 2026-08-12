/**
 * Restore logic — unpacks a snapshot zip and runs ADK CLI commands in
 * dependency order (FR-5.3 → FR-5.10).
 *
 * Restore order: connections → tools → knowledge_bases → agent (FR-5.4).
 *
 * Each artefact produces a { artefact, status, message } log entry so the
 * popup can stream per-item progress.
 */

import { execFileSync } from "node:child_process";
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

// ─── Types ────────────────────────────────────────────────────────────────────

export type RestoreStatus = "ok" | "skipped" | "error";

export interface RestoreLogEntry {
  artefact: string;
  status:   RestoreStatus;
  message:  string;
}

// ─── ADK CLI helper ───────────────────────────────────────────────────────────

/**
 * Run an ADK CLI command synchronously.
 * Returns stdout on success, throws with stderr on failure.
 */
function runAdkCommand(args: string[]): string {
  try {
    const output = execFileSync("orchestrate", args, {
      encoding: "utf-8",
      timeout:  60_000,   // 60 s per artefact
    });
    return output;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(e.stderr ?? e.message ?? String(err));
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

// ─── Per-artefact restore functions ───────────────────────────────────────────

function restoreConnection(
  entries: ParsedZip["entries"],
  name: string,
  tempDir: string,
): RestoreLogEntry {
  const meta = readConnectionMeta(entries, name);
  if (!meta) {
    return { artefact: `connection:${name}`, status: "error", message: "Could not read connection metadata from zip" };
  }

  const yamlPath = writeTempFile(tempDir, `${name}.yaml`, JSON.stringify(meta, null, 2));
  try {
    runAdkCommand(["connections", "import", "--file", yamlPath]);
    return { artefact: `connection:${meta.app_id}`, status: "ok", message: "Imported" };
  } catch (err) {
    return { artefact: `connection:${meta.app_id}`, status: "error", message: String(err) };
  }
}

function restoreTool(
  entries: ParsedZip["entries"],
  toolName: string,
  tempDir: string,
): RestoreLogEntry {
  const meta = readToolMeta(entries, toolName);
  const label = `tool:${meta?.name ?? toolName}`;

  if (meta?.sourceUnavailable === true) {
    return { artefact: label, status: "skipped", message: "sourceUnavailable — skipped" };
  }

  const source = readToolSource(entries, toolName);
  if (!source) {
    return { artefact: label, status: "skipped", message: "No source file in zip — skipped" };
  }

  const sourcePath = writeTempFile(tempDir, source.filename, source.bytes);

  // Write requirements.txt if present alongside source.py.
  const reqData = entries[`tools/${toolName}/requirements.txt`];
  const reqPath  = reqData ? writeTempFile(tempDir, "requirements.txt", reqData) : undefined;

  const args = ["tools", "import", "--kind", "python", "--file", sourcePath];
  if (reqPath) {
    args.push("--requirements", reqPath);
  }
  if (meta?.app_id) {
    args.push("--app-id", meta.app_id);
  }

  try {
    runAdkCommand(args);
    return { artefact: label, status: "ok", message: "Imported" };
  } catch (err) {
    return { artefact: label, status: "error", message: String(err) };
  }
}

function restoreKnowledgeBase(
  entries: ParsedZip["entries"],
  kbId: string,
  tempDir: string,
): RestoreLogEntry[] {
  const log: RestoreLogEntry[] = [];
  const label = `knowledge_base:${kbId}`;

  // Import the KB spec.
  const kbYamlPath = writeTempFile(
    tempDir,
    `${kbId}-kb.yaml`,
    entries[`knowledge_bases/${kbId}/kb.yaml`] ?? new Uint8Array(),
  );

  try {
    runAdkCommand(["knowledge-bases", "import", "--file", kbYamlPath]);
    log.push({ artefact: label, status: "ok", message: "KB spec imported" });
  } catch (err) {
    log.push({ artefact: label, status: "error", message: String(err) });
    return log; // no point uploading documents if KB import failed
  }

  // Upload documents.
  const docs = listKbDocuments(entries, kbId);
  for (const filename of docs) {
    const bytes = readKbDocument(entries, kbId, filename);
    if (!bytes) continue;
    const docPath = writeTempFile(tempDir, filename, bytes);
    try {
      runAdkCommand(["knowledge-bases", "upload-document", "--kb-id", kbId, "--file", docPath]);
      log.push({ artefact: `${label}/document:${filename}`, status: "ok", message: "Uploaded" });
    } catch (err) {
      log.push({ artefact: `${label}/document:${filename}`, status: "error", message: String(err) });
    }
  }

  return log;
}

function restoreAgent(
  entries: ParsedZip["entries"],
  tempDir: string,
): RestoreLogEntry {
  const agentYaml = entries["agent/agent.yaml"];
  if (!agentYaml) {
    return { artefact: "agent", status: "error", message: "agent/agent.yaml not found in zip" };
  }
  const yamlPath = writeTempFile(tempDir, "agent.yaml", agentYaml);
  try {
    runAdkCommand(["agents", "import", "--file", yamlPath]);
    return { artefact: "agent", status: "ok", message: "Imported" };
  } catch (err) {
    return { artefact: "agent", status: "error", message: String(err) };
  }
}

// ─── restoreFromZip ───────────────────────────────────────────────────────────

/**
 * Execute the full restore from an unpacked zip, in dependency order.
 * Returns a structured log entry per artefact (FR-5.10).
 */
export async function restoreFromZip(zip: ParsedZip): Promise<RestoreLogEntry[]> {
  const { entries } = zip;
  const log: RestoreLogEntry[] = [];
  const tempDir = createTempDir();

  try {
    // 1. Connections
    for (const name of listConnectionNames(entries)) {
      log.push(restoreConnection(entries, name, tempDir));
    }

    // 2. Tools
    for (const toolName of listToolNames(entries)) {
      log.push(restoreTool(entries, toolName, tempDir));
    }

    // 3. Knowledge bases
    for (const kbId of listKbIds(entries)) {
      log.push(...restoreKnowledgeBase(entries, kbId, tempDir));
    }

    // 4. Agent
    log.push(restoreAgent(entries, tempDir));

  } finally {
    // Always clean up temp files.
    rmSync(tempDir, { recursive: true, force: true });
  }

  return log;
}
