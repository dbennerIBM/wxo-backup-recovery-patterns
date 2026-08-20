/**
 * Zip serialiser — Sub-Task 4.
 *
 * Produces a deterministic, self-contained zip archive from an `AgentSnapshot`.
 * Uses `fflate` (pure JS, browser + Node compatible, no native APIs required).
 *
 * Zip layout
 * ──────────
 *   manifest.json
 *   agent/
 *     agent.yaml
 *   tools/
 *     {tool-name}/
 *       tool.json
 *   knowledge_bases/
 *     {kb-id}/
 *       kb.yaml
 *       documents/
 *         {filename}
 *   connections/
 *     {app_id}.yaml
 */

import { strToU8, strFromU8, zipSync, unzipSync, type Zippable, type ZipOptions } from "fflate";
import type { AgentSnapshot } from "./index";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sanitise a string for safe use as a zip path segment.
 * Strips leading/trailing whitespace and replaces characters that would be
 * interpreted as path separators or cause issues on Windows.
 */
function safeName(name: string): string {
  return name.trim().replace(/[/\\:*?"<>|]/g, "_") || "_unnamed";
}

/**
 * Build a per-file ZipOptions with a fixed mtime so the archive is
 * deterministic: identical snapshots always produce identical bytes.
 */
function fileOpts(mtime: Date): ZipOptions {
  return { level: 6, mtime };
}

/** Encode a value as compact JSON bytes (UTF-8). */
function jsonBytes(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value, null, 2));
}

// ─── buildZip ─────────────────────────────────────────────────────────────────

/**
 * Serialise an `AgentSnapshot` into a deterministic zip archive.
 *
 * All timestamps inside the zip are pinned to `snapshot.capturedAt` so that
 * identical snapshots produce identical byte sequences (useful for dedup).
 *
 * @returns Raw zip bytes as a `Uint8Array`.
 */
export function buildZip(snapshot: AgentSnapshot): Uint8Array {
  const mtime = new Date(snapshot.capturedAt);
  const opts = fileOpts(mtime);

  const files: Zippable = {};

  // ── manifest.json ──────────────────────────────────────────────────────────
  const manifest = {
    schemaVersion: snapshot.schemaVersion,
    capturedAt: snapshot.capturedAt,
    tenant: snapshot.tenant,
    agentId: snapshot.agent.id,
    agentName: snapshot.agent.display_name || snapshot.agent.name,
  };
  files["manifest.json"] = [jsonBytes(manifest), opts];

  // ── agent/agent.yaml ───────────────────────────────────────────────────────
  // JSON is valid YAML; the ADK CLI accepts JSON-encoded .yaml files.
  files["agent/agent.yaml"] = [jsonBytes(snapshot.agent), opts];

  // ── tools/{name}/tool.json (+ source.py | spec.yaml, requirements.txt) ────
  for (const tool of snapshot.tools) {
    const dir = `tools/${safeName(tool.name)}`;
    // Captured upload bytes go in their own files (the names the restore path
    // reads), never inside tool.json.
    const { sourceFile, requirementsFile, ...meta } = tool;
    files[`${dir}/tool.json`] = [jsonBytes(meta), opts];
    if (sourceFile) {
      const isSpec = /\.(ya?ml|json)$/i.test(sourceFile.filename);
      files[`${dir}/${isSpec ? "spec.yaml" : "source.py"}`] =
        [new Uint8Array(sourceFile.bytes), opts];
    }
    if (requirementsFile) {
      files[`${dir}/requirements.txt`] = [new Uint8Array(requirementsFile.bytes), opts];
    }
  }

  // ── knowledge_bases/{kb-id}/kb.yaml + documents/ ─────────────────────────
  for (const kb of snapshot.knowledgeBases) {
    const dir = `knowledge_bases/${safeName(kb.id)}`;
    files[`${dir}/kb.yaml`] = [jsonBytes({ id: kb.id, ...kb.meta }), opts];
    for (const file of kb.files) {
      const docPath = `${dir}/documents/${safeName(file.filename)}`;
      files[docPath] = [new Uint8Array(file.bytes), opts];
    }
  }

  // ── connections/{app_id}.yaml ─────────────────────────────────────────────
  for (const conn of snapshot.connections) {
    const path = `connections/${safeName(conn.app_id)}.yaml`;
    files[path] = [jsonBytes(conn), opts];
  }

  return zipSync(files);
}

// ─── snapshotContentDigest ────────────────────────────────────────────────────

/**
 * Fixed timestamp used when digesting, so only real content changes the hash.
 * Must lie in 1980–2099: zip entries carry DOS-format mtimes and fflate
 * rejects dates outside that range.
 */
const DIGEST_EPOCH = "2000-01-01T00:00:00.000Z";

/**
 * SHA-256 digest of the snapshot's *content*, ignoring `capturedAt`.
 *
 * `buildZip` is deterministic (FR-3.2), but `capturedAt` is stamped into
 * manifest.json and every file's mtime — so two content-identical snapshots
 * still produce different bytes. Pinning `capturedAt` to a fixed epoch before
 * zipping yields a digest that changes only when the agent, tools, knowledge
 * bases, or connections actually change. Used by the assembler to skip
 * re-posting unchanged snapshots (dedup — the FR-3.2 rationale).
 */
export async function snapshotContentDigest(snapshot: AgentSnapshot): Promise<string> {
  const bytes = buildZip({ ...snapshot, capturedAt: DIGEST_EPOCH });
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── parseZip ─────────────────────────────────────────────────────────────────

/**
 * Parse a zip produced by `buildZip` back into the structured file map.
 * Returns a plain object keyed by the zip-internal path, with `Uint8Array`
 * values — identical to fflate's `Unzipped` type.
 *
 * Callers that want the full `AgentSnapshot` must re-construct it from the
 * individual files (this is intentionally the proxy's concern, not the
 * extension's).
 */
export function parseZip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

/**
 * Read a UTF-8 text file out of a parsed zip by path.
 * Returns `null` if the path is not present.
 */
export function readZipText(
  parsed: Record<string, Uint8Array>,
  path: string,
): string | null {
  const entry = parsed[path];
  if (!entry) return null;
  return strFromU8(entry);
}

/**
 * Read and JSON-parse a file out of a parsed zip.
 * Returns `null` if the path is absent or the JSON is malformed.
 */
export function readZipJson(
  parsed: Record<string, Uint8Array>,
  path: string,
): unknown {
  const text = readZipText(parsed, path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
