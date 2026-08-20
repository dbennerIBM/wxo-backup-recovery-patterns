/**
 * Pure capture helpers shared by the background assembler (and its tests).
 *
 * No browser or chrome.* dependencies. The MAIN-world content script cannot
 * import this module (see src/content/index.ts) and carries its own inline
 * copies where needed; keep the two in sync.
 *
 * Shapes here were confirmed live on dl.watson-orchestrate.ibm.com (Aug 2026):
 *
 *   PATCH /v1/builder/orchestrate/agents/{uuid}
 *     request body : { name, display_name, tools: [uuid], toolsSelected: [], knowledge_base: [uuid], … }
 *     response     : 204 No Content   ← no body; the agent uuid is only in the URL
 *   GET   /v1/builder/orchestrate/agents/{uuid}
 *     response     : { id, name, tools: [uuid], toolsSelected: [{ id, name, binding… }], knowledge_base, … }
 *     (no tenant_id on this tenant)
 *   GET   /v2/builder/tools?ids=…&limit=&offset=
 *     response     : { data: [ { id, tenant_id, name, binding, … } ], total, limit, offset, result_count }
 *   GET   /v1/orchestrate/connections/applications
 *     response     : { tenant_id, page, limit, total, applications: [ { app_id, security_scheme, server_url, … } ] }
 */

import type { SnapshotFile, SnapshotTool } from "./index";

// ─── URL helpers ──────────────────────────────────────────────────────────────

const AGENT_DETAIL_URL_RE =
  /\/mfe_builder\/api\/v1\/builder\/orchestrate\/agents\/([^/?#]+)(?:[?#]|$)/;

/**
 * Extract the agent uuid from an agent-detail URL
 * (`…/v1/builder/orchestrate/agents/{uuid}`), or null if the URL does not match.
 * Used when the captured payload lacks an `id` (PATCH request bodies).
 */
export function agentIdFromUrl(url: string): string | null {
  const m = AGENT_DETAIL_URL_RE.exec(url);
  return m?.[1] ?? null;
}

// ─── Tenant ───────────────────────────────────────────────────────────────────

/** Name of the wxO session cookie that carries the tenant identifier. */
export const TENANT_COOKIE_NAME = "x-ibm-wo-tenant-id";

/**
 * Parse a `document.cookie` string and return the wxO tenant id, or null.
 * The value is an opaque identifier (not a credential); it is used only to
 * scope the snapshot storage path.
 */
export function tenantFromCookie(cookieString: string): string | null {
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== TENANT_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    if (value !== "") return decodeURIComponent(value);
  }
  return null;
}

/**
 * Pick the best available tenant identifier from, in order of preference:
 *  1. `tenant_id` on the payload itself (present on tool objects and the
 *     connections envelope; absent on agent payloads for some tenants),
 *  2. the tenant already recorded on the snapshot,
 *  3. a hint supplied by the content script (session cookie, else hostname).
 * Never returns an empty string; falls back to `"unknown-tenant"` so storage
 * keys are never rooted at `/`.
 */
export function pickTenant(
  payloadTenantId: unknown,
  currentTenant: string,
  hint: string | undefined,
): string {
  if (typeof payloadTenantId === "string" && payloadTenantId !== "") return payloadTenantId;
  if (currentTenant !== "" && currentTenant !== UNKNOWN_TENANT) return currentTenant;
  if (typeof hint === "string" && hint !== "") return hint;
  return currentTenant || UNKNOWN_TENANT;
}

export const UNKNOWN_TENANT = "unknown-tenant";

// ─── Tools ────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Convert one raw tool object into the SnapshotTool shape (id + name required). */
export function toSnapshotTool(data: Record<string, unknown>): SnapshotTool | null {
  if (typeof data["id"] !== "string" || typeof data["name"] !== "string") {
    return null;
  }
  const tool: SnapshotTool = { id: data["id"], name: data["name"] };
  if (typeof data["description"] === "string") tool.description = data["description"];
  if (data["binding"] !== undefined) tool.binding = data["binding"];
  return tool;
}

/**
 * Extract tool objects from any of the response/request shapes we see:
 *  - agent payloads      → `toolsSelected: [...]`
 *  - GET /v2/builder/tools → `{ data: [...] }` (paginated envelope, confirmed live)
 *  - bare JSON arrays wrapped by the content script → `{ items: [...] }`
 *  - legacy / other      → `{ tools: [...] }` when elements are objects
 *  - a single tool object
 */
export function extractToolsFromPayload(data: Record<string, unknown>): SnapshotTool[] {
  for (const key of ["toolsSelected", "data", "items", "tools"] as const) {
    const arr = data[key];
    if (Array.isArray(arr) && arr.some(isRecord)) {
      return arr
        .filter(isRecord)
        .map(toSnapshotTool)
        .filter((tool): tool is SnapshotTool => tool !== null);
    }
  }
  const single = toSnapshotTool(data);
  return single === null ? [] : [single];
}

/**
 * Extract tool objects from an AGENT payload's `toolsSelected[]` only.
 *
 * Agent captures must not fall through to `extractToolsFromPayload`'s
 * single-object fallback: an agent payload has `id` + `name` too, so the
 * fallback would record the agent itself as a tool (observed live as a stray
 * `tools/{agent_name}/tool.json` in snapshots).
 */
export function extractSelectedTools(data: Record<string, unknown>): SnapshotTool[] {
  const arr = data["toolsSelected"];
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(isRecord)
    .map(toSnapshotTool)
    .filter((tool): tool is SnapshotTool => tool !== null);
}

/**
 * The agent's referenced tool ids. Agent payloads carry `tools: [uuid, …]`
 * even when `toolsSelected` is empty (PATCH request bodies).
 */
export function extractToolIds(data: Record<string, unknown>): string[] {
  const arr = data["tools"];
  if (!Array.isArray(arr)) return [];
  return arr.filter((v): v is string => typeof v === "string");
}

/** First `tenant_id` found on any tool object in a tools payload, else null. */
export function tenantFromToolsPayload(data: Record<string, unknown>): string | null {
  if (typeof data["tenant_id"] === "string" && data["tenant_id"] !== "") return data["tenant_id"];
  for (const key of ["data", "items", "tools", "toolsSelected"] as const) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (isRecord(item) && typeof item["tenant_id"] === "string" && item["tenant_id"] !== "") {
        return item["tenant_id"];
      }
    }
  }
  return null;
}

// ─── Files ────────────────────────────────────────────────────────────────────

/** Two captured files are the same upload if filename and byte length match. */
export function sameFile(a: SnapshotFile, b: SnapshotFile): boolean {
  return a.filename === b.filename && a.bytes.length === b.bytes.length;
}

/**
 * Append `incoming` to `existing`, skipping any file already present
 * (by filename + byte length). Guards against one upload being observed on
 * more than one capture path (fetch interceptor, XHR interceptor, webRequest).
 */
export function dedupFiles(existing: SnapshotFile[], incoming: SnapshotFile[]): SnapshotFile[] {
  const out = [...existing];
  for (const file of incoming) {
    if (!out.some((f) => sameFile(f, file))) out.push(file);
  }
  return out;
}

// ─── Knowledge bases ──────────────────────────────────────────────────────────

/**
 * The KB uuid returned by the KB-create response
 * (`POST /v1/orchestrate/knowledge-bases/documents` → 201 `{ knowledge_base: "<uuid>", … }`)
 * or by an add-documents response (`PUT …/{uuid}/documents` → `{ knowledge_base, documents }`).
 */
export function kbIdFromUploadResponse(data: Record<string, unknown>): string | null {
  const v = data["knowledge_base"];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Agent uuids referenced by a KB-detail payload's `agent_references[]`.
 *
 * When an *existing* KB is attached to an agent, the association is recorded
 * on the KB side (`agent_references: [{ id, display_name }]`) — the agent
 * payload may never list the KB. This is the ownership signal for that flow.
 */
export function agentIdsFromKbMeta(data: Record<string, unknown>): string[] {
  const refs = data["agent_references"];
  if (!Array.isArray(refs)) return [];
  return refs
    .filter(isRecord)
    .map((ref) => ref["id"])
    .filter((id): id is string => typeof id === "string" && id !== "");
}
