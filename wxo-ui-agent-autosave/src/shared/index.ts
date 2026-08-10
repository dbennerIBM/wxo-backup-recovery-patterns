/**
 * Shared types, constants, and utilities.
 *
 * Sub-Task 1: Scaffold with core type stubs.
 * These will be expanded as each sub-task is implemented.
 */

// ─── Message types ────────────────────────────────────────────────────────────

export type MessageType =
  | "AGENT_CAPTURED"
  | "TOOL_CAPTURED"
  | "CONNECTION_CAPTURED"
  | "KB_META_CAPTURED"
  | "KB_FILE_CAPTURED"
  | "SNAPSHOT_READY";

export interface ExtensionMessage {
  type: MessageType;
  payload: unknown;
}

// ─── Snapshot types (stubs — fully defined in Sub-Task 3) ─────────────────────

export interface ConnectionMeta {
  app_id: string;
  kind: string;
  server_url?: string;
}

export interface AgentSnapshot {
  schemaVersion: string;
  capturedAt: string;
  tenant: string;
  agent: object;
  tools: object[];
  knowledgeBases: object[];
  connections: ConnectionMeta[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const PROXY_DEFAULT_PORT = 7878;
export const DEBOUNCE_DEFAULT_MS = 3000;
export const SCHEMA_VERSION = "1.0.0";

/** wxO SaaS hostname pattern */
export const WXO_HOSTNAME = "*.watson-orchestrate.ibm.com";
