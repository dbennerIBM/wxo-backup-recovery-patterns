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

  // ── tools/{name}/tool.json ────────────────────────────────────────────────
  for (const tool of snapshot.tools) {
    const dir = `tools/${safeName(tool.name)}`;
    files[`${dir}/tool.json`] = [jsonBytes(tool), opts];
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
