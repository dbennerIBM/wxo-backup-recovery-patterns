/**
 * Zip parsing helpers for the proxy.
 *
 * The proxy never builds zips (that's the extension's job) — it only unpacks
 * them to read manifest.json, tool.json files, and connection yamls.
 *
 * Uses fflate (same library as the extension) for consistency.
 * SEC-6: path traversal validation is applied to every entry before use.
 */

import { unzipSync, strFromU8 } from "fflate";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ZipManifest {
  schemaVersion: string;
  capturedAt: string;
  tenant: string;
  agentId: string;
  agentName: string;
}

export interface ZipToolMeta {
  name: string;
  id?: string;
  app_id?: string;
  sourceUnavailable?: boolean;
  expectedCredentials?: Array<{ app_id: string; type: string | string[] }>;
}

export interface ZipConnectionMeta {
  app_id: string;
  kind: string;
  server_url?: string;
}

export interface ParsedZip {
  /** Raw fflate unzip result — every entry keyed by its internal path. */
  entries: Record<string, Uint8Array>;
  manifest: ZipManifest;
}

// ─── Path traversal guard ─────────────────────────────────────────────────────

/**
 * Reject any zip entry path that contains directory traversal sequences.
 * SEC-6: validate structure of every received zip before unpacking.
 */
function isSafePath(path: string): boolean {
  // Reject absolute paths, Windows drive letters, and any traversal segment.
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  for (const segment of path.split("/")) {
    if (segment === ".." || segment === ".") return false;
  }
  return true;
}

// ─── Core unzip ───────────────────────────────────────────────────────────────

/**
 * Unzip raw bytes, apply path-traversal validation, and parse manifest.json.
 * Throws if the zip is malformed, manifest is absent, or any path is unsafe.
 */
export function unpackZip(bytes: Uint8Array): ParsedZip {
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes);
  } catch (err) {
    throw new Error(`Failed to unzip payload: ${String(err)}`);
  }

  // Validate all paths before touching any content (SEC-6).
  const entries: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(raw)) {
    if (!isSafePath(path)) {
      throw new Error(`Zip contains unsafe path: "${path}"`);
    }
    entries[path] = data;
  }

  // Parse manifest.json
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes) throw new Error("Zip is missing manifest.json");

  let manifest: ZipManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as ZipManifest;
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }

  if (!manifest.tenant || !manifest.agentName || !manifest.capturedAt) {
    throw new Error("manifest.json is missing required fields (tenant, agentName, capturedAt)");
  }

  return { entries, manifest };
}

// ─── Entry readers ────────────────────────────────────────────────────────────

function readText(entries: Record<string, Uint8Array>, path: string): string | null {
  const data = entries[path];
  return data ? strFromU8(data) : null;
}

function readJson<T>(entries: Record<string, Uint8Array>, path: string): T | null {
  const text = readText(entries, path);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ─── Zip content accessors ────────────────────────────────────────────────────

/** Return all tool names found in the zip (tools/{name}/tool.json). */
export function listToolNames(entries: Record<string, Uint8Array>): string[] {
  const names: string[] = [];
  for (const path of Object.keys(entries)) {
    const m = /^tools\/([^/]+)\/tool\.json$/.exec(path);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

/** Read a tool's metadata from tools/{name}/tool.json. */
export function readToolMeta(
  entries: Record<string, Uint8Array>,
  toolName: string,
): ZipToolMeta | null {
  return readJson<ZipToolMeta>(entries, `tools/${toolName}/tool.json`);
}

/** Return all KB IDs found in the zip (knowledge_bases/{id}/kb.yaml). */
export function listKbIds(entries: Record<string, Uint8Array>): string[] {
  const ids: string[] = [];
  for (const path of Object.keys(entries)) {
    const m = /^knowledge_bases\/([^/]+)\/kb\.yaml$/.exec(path);
    if (m?.[1]) ids.push(m[1]);
  }
  return ids;
}

/** Return all connection app_ids (connections/{app_id}.yaml). */
export function listConnectionNames(entries: Record<string, Uint8Array>): string[] {
  const names: string[] = [];
  for (const path of Object.keys(entries)) {
    const m = /^connections\/([^/]+)\.yaml$/.exec(path);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

/** Read a connection's metadata from connections/{app_id}.yaml. */
export function readConnectionMeta(
  entries: Record<string, Uint8Array>,
  name: string,
): ZipConnectionMeta | null {
  return readJson<ZipConnectionMeta>(entries, `connections/${name}.yaml`);
}

/** List document filenames under knowledge_bases/{kbId}/documents/. */
export function listKbDocuments(
  entries: Record<string, Uint8Array>,
  kbId: string,
): string[] {
  const prefix = `knowledge_bases/${kbId}/documents/`;
  return Object.keys(entries)
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .filter((name) => name.length > 0);
}

/** Read raw bytes for a KB document. */
export function readKbDocument(
  entries: Record<string, Uint8Array>,
  kbId: string,
  filename: string,
): Uint8Array | null {
  return entries[`knowledge_bases/${kbId}/documents/${filename}`] ?? null;
}

/** Read raw bytes for a tool source file (source.py or spec.yaml). */
export function readToolSource(
  entries: Record<string, Uint8Array>,
  toolName: string,
): { filename: string; bytes: Uint8Array } | null {
  for (const candidate of ["source.py", "spec.yaml", "requirements.txt"]) {
    const path = `tools/${toolName}/${candidate}`;
    const data = entries[path];
    if (data) return { filename: candidate, bytes: data };
  }
  return null;
}
