/**
 * Typed internal message schema for all extension-internal communication.
 *
 * All messages flow from the content script to the background service worker
 * via chrome.runtime.sendMessage.
 */

// ─── Payload types ────────────────────────────────────────────────────────────

/** Raw JSON body of a GET /agents or GET /agents/{id} response. */
export interface AgentPayload {
  /** The raw API response object (already credential-scrubbed). */
  data: Record<string, unknown>;
  /** The full URL the response came from, for extracting tenant/agent info. */
  sourceUrl: string;
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

/** Binary file extracted from a multipart POST to /knowledge-bases/{id}/documents
 *  or a multipart POST /tools (OpenAPI spec). */
export interface KBFilePayload {
  /** Knowledge base ID extracted from the URL (empty string for tool spec uploads). */
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
      "KB_META_CAPTURED",
      "KB_FILE_CAPTURED",
      "TOOL_FILE_CAPTURED",
      "BEARER_TOKEN_OBSERVED",
    ].includes(obj["type"])
  );
}
