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

// ─── Snapshot types ────────────────────────────────────────────────────────────

export interface ConnectionMeta {
  app_id: string;
  kind: string;
  server_url?: string;
}

export interface SnapshotReadyPayload {
  agentId: string;
  snapshot: AgentSnapshot;
}

export interface SnapshotAgent {
  id: string;
  name: string;
  display_name?: string;
  description?: string;
  instructions?: string;
  llm?: string;
  style?: string;
  guidelines: unknown[];
  knowledge_base: string[];
  collaborators: unknown[];
  tags: unknown;
  structured_output: unknown;
}

export interface SnapshotTool {
  id: string;
  name: string;
  description?: string;
  binding?: unknown;
}

export interface SnapshotFile {
  filename: string;
  contentType: string;
  bytes: number[];
}

export interface SnapshotKnowledgeBase {
  id: string;
  meta: Record<string, unknown>;
  files: SnapshotFile[];
}

export interface AgentSnapshot {
  schemaVersion: string;
  capturedAt: string;
  tenant: string;
  agent: SnapshotAgent;
  tools: SnapshotTool[];
  knowledgeBases: SnapshotKnowledgeBase[];
  connections: ConnectionMeta[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const PROXY_DEFAULT_PORT = 7878;
export const DEBOUNCE_DEFAULT_MS = 3000;
export const SCHEMA_VERSION = "1.0.0";

/** wxO SaaS hostname pattern — CONFIRMED: cloud.ibm.com, not ibm.com */
export const WXO_HOSTNAME = "*.watson-orchestrate.cloud.ibm.com";

/** chrome.storage.local key for the recent-snapshot index. */
export const RECENT_SNAPSHOTS_KEY = "recentSnapshots";

/** Maximum number of entries kept in the recent-snapshot index. */
export const MAX_RECENT_SNAPSHOTS = 5;

// ─── Recent-snapshot index entry ─────────────────────────────────────────────

/** Lightweight index entry written to chrome.storage.local after each save. */
export interface RecentSnapshotEntry {
  agentId: string;
  agentName: string;
  tenant: string;
  capturedAt: string;
  proxyUrl: string;
}
