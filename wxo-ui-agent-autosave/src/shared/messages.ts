/**
 * Typed internal message schema for all extension-internal communication.
 *
 * All messages flow from the content script to the background service worker
 * via chrome.runtime.sendMessage.
 */

// ─── Payload types ────────────────────────────────────────────────────────────

/**
 * Agent payload — the JSON body of `GET /agents/{id}` (response) or of
 * `PATCH /agents/{id}` (request body; the response is 204 No Content).
 */
export interface AgentPayload {
  /** The raw API object (already credential-scrubbed). May lack `id` when it
   *  came from a PATCH request body — the assembler falls back to `sourceUrl`. */
  data: Record<string, unknown>;
  /** The full request URL, for extracting the agent uuid. */
  sourceUrl: string;
  /**
   * Tenant hint from the content script: the `x-ibm-wo-tenant-id` session
   * cookie value, else the page hostname. Used only when the payload itself has
   * no `tenant_id` (true on some tenants). Never a credential.
   */
  tenantHint?: string;
}

/** Raw JSON body of a GET /tools, GET /tools/{id}, or POST /tools response. */
export interface ToolPayload {
  /** The raw API response object (already credential-scrubbed). */
  data: Record<string, unknown>;
  sourceUrl: string;
}

/** Scrubbed metadata from GET /connections or GET /connections/{id}. */
export interface ConnectionPayload {
  /** Only app_id, kind, and server_url — all other fields stripped. */
  app_id: string;
  kind: string;
  server_url?: string;
}

/** Raw JSON body of a GET /knowledge-bases or GET /knowledge-bases/{id} response. */
export interface KBMetaPayload {
  data: Record<string, unknown>;
  sourceUrl: string;
}

/** Binary file captured from a KB document upload (`POST …/knowledge-bases/documents`
 *  create+first-doc, or `PUT …/knowledge-bases/{id}/documents`). */
export interface KBFilePayload {
  /** Knowledge base uuid — from the URL (PUT) or from the create response's
   *  `knowledge_base` field. Empty string only when the capturing path could not
   *  observe the response; the assembler then buffers the file until the KB is known. */
  kbId: string;
  filename: string;
  contentType: string;
  /** Raw file bytes. */
  bytes: number[];
}

/** A single file extracted from a multipart request (tool OpenAPI spec upload). */
export interface ToolFilePayload {
  filename: string;
  contentType: string;
  bytes: number[];
}

// ─── Discriminated union ──────────────────────────────────────────────────────

export type ExtensionMessage =
  | { type: "AGENT_CAPTURED"; payload: AgentPayload }
  | { type: "TOOL_CAPTURED"; payload: ToolPayload }
  | { type: "CONNECTION_CAPTURED"; payload: ConnectionPayload }
  /** All connections from one connections/applications response, in a single message. */
  | { type: "CONNECTION_BATCH_CAPTURED"; payload: ConnectionPayload[] }
  | { type: "KB_META_CAPTURED"; payload: KBMetaPayload }
  | { type: "KB_FILE_CAPTURED"; payload: KBFilePayload }
  | { type: "TOOL_FILE_CAPTURED"; payload: ToolFilePayload }
  | { type: "BEARER_TOKEN_OBSERVED"; payload: { token: string } };

// ─── Type guard helpers ───────────────────────────────────────────────────────

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["type"] === "string" &&
    [
      "AGENT_CAPTURED",
      "TOOL_CAPTURED",
      "CONNECTION_CAPTURED",
      "CONNECTION_BATCH_CAPTURED",
      "KB_META_CAPTURED",
      "KB_FILE_CAPTURED",
      "TOOL_FILE_CAPTURED",
      "BEARER_TOKEN_OBSERVED",
    ].includes(obj["type"])
  );
}
