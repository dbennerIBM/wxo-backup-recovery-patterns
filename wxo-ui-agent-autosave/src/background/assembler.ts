/**
 * Snapshot assembler — Sub-Task 3.
 *
 * Stateful background module that coalesces captured agent/tool/connection/KB
 * events into per-agent versionable snapshots stored in chrome.storage.session.
 */

import type {
  AgentSnapshot,
  ConnectionMeta,
  SnapshotAgent,
  SnapshotFile,
  SnapshotKnowledgeBase,
  SnapshotTool,
} from "../shared";
import type {
  AgentPayload,
  ConnectionPayload,
  KBFilePayload,
  KBMetaPayload,
  ToolPayload,
} from "../shared/messages";
import { DEBOUNCE_DEFAULT_MS, SCHEMA_VERSION } from "../shared";

export type SnapshotEventType =
  | "AGENT_CAPTURED"
  | "TOOL_CAPTURED"
  | "CONNECTION_CAPTURED"
  | "KB_META_CAPTURED"
  | "KB_FILE_CAPTURED";

export interface SnapshotAssemblerEvents {
  on<T extends SnapshotEventType>(
    type: T,
    handler: (
      payload:
        T extends "AGENT_CAPTURED" ? AgentPayload
        : T extends "TOOL_CAPTURED" ? ToolPayload
        : T extends "CONNECTION_CAPTURED" ? ConnectionPayload
        : T extends "KB_META_CAPTURED" ? KBMetaPayload
        : KBFilePayload,
    ) => void,
  ): void;
}

const SNAPSHOT_STORAGE_KEY = "agentSnapshots";
const PENDING_KB_FILES_STORAGE_KEY = "pendingKbFiles";

type SnapshotMap = Record<string, AgentSnapshot>;

export interface PendingKbFileBuffer {
  knownKbIds: string[];
  files: SnapshotFile[];
}

type PendingKbFileMap = Record<string, PendingKbFileBuffer>;

type SnapshotReadyListener = (agentId: string, snapshot: AgentSnapshot) => void;

const debounceTimers = new Map<string, number>();
const snapshotReadyListeners: SnapshotReadyListener[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cloneSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  return {
    ...snapshot,
    agent: {
      ...snapshot.agent,
      guidelines: [...snapshot.agent.guidelines],
      knowledge_base: [...snapshot.agent.knowledge_base],
      collaborators: [...snapshot.agent.collaborators],
    },
    tools: snapshot.tools.map((tool) => ({ ...tool })),
    knowledgeBases: snapshot.knowledgeBases.map((kb) => ({
      id: kb.id,
      meta: { ...kb.meta },
      files: kb.files.map((file) => ({
        filename: file.filename,
        contentType: file.contentType,
        bytes: [...file.bytes],
      })),
    })),
    connections: snapshot.connections.map((connection) => ({ ...connection })),
  };
}

function createEmptySnapshot(agentId: string): AgentSnapshot {
  const agent: SnapshotAgent = {
    id: agentId,
    name: "",
    guidelines: [],
    knowledge_base: [],
    collaborators: [],
    tags: null,
    structured_output: null,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    tenant: "",
    agent,
    tools: [],
    knowledgeBases: [],
    connections: [],
  };
}

async function readSnapshots(): Promise<SnapshotMap> {
  const stored = await chrome.storage.session.get(SNAPSHOT_STORAGE_KEY);
  const value = stored[SNAPSHOT_STORAGE_KEY];
  if (!isRecord(value)) return {};
  return value as SnapshotMap;
}

async function writeSnapshots(snapshots: SnapshotMap): Promise<void> {
  await chrome.storage.session.set({ [SNAPSHOT_STORAGE_KEY]: snapshots });
}

async function readPendingKbFiles(): Promise<PendingKbFileMap> {
  const stored = await chrome.storage.session.get(PENDING_KB_FILES_STORAGE_KEY);
  const value = stored[PENDING_KB_FILES_STORAGE_KEY];
  if (!isRecord(value)) return {};
  return value as PendingKbFileMap;
}

async function writePendingKbFiles(pending: PendingKbFileMap): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KB_FILES_STORAGE_KEY]: pending });
}

async function upsertSnapshot(
  agentId: string,
  updater: (snapshot: AgentSnapshot) => AgentSnapshot,
): Promise<AgentSnapshot> {
  const snapshots = await readSnapshots();
  const current = snapshots[agentId] ?? createEmptySnapshot(agentId);
  const next = updater(cloneSnapshot(current));
  next.schemaVersion = SCHEMA_VERSION;
  next.capturedAt = new Date().toISOString();
  snapshots[agentId] = next;
  await writeSnapshots(snapshots);
  return next;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) {
    items.push(item);
    return items;
  }
  items[index] = { ...items[index], ...item };
  return items;
}

function upsertConnection(items: ConnectionMeta[], item: ConnectionMeta): ConnectionMeta[] {
  const index = items.findIndex((existing) => existing.app_id === item.app_id);
  if (index === -1) {
    items.push(item);
    return items;
  }
  items[index] = { ...items[index], ...item };
  return items;
}

function extractAgentId(data: Record<string, unknown>): string | null {
  return typeof data["id"] === "string" ? data["id"] : null;
}

function extractKnowledgeBaseIds(data: Record<string, unknown>): string[] {
  return asStringArray(data["knowledge_base"]);
}

function toSnapshotAgent(data: Record<string, unknown>, agentId: string): SnapshotAgent {
  const agent: SnapshotAgent = {
    id: agentId,
    name: typeof data["name"] === "string" ? data["name"] : "",
    guidelines: asArray(data["guidelines"]),
    knowledge_base: extractKnowledgeBaseIds(data),
    collaborators: asArray(data["collaborators"]),
    tags: data["tags"] ?? null,
    structured_output: data["structured_output"] ?? null,
  };

  if (typeof data["display_name"] === "string") agent.display_name = data["display_name"];
  if (typeof data["description"] === "string") agent.description = data["description"];
  if (typeof data["instructions"] === "string") agent.instructions = data["instructions"];
  if (typeof data["llm"] === "string") agent.llm = data["llm"];
  if (typeof data["style"] === "string") agent.style = data["style"];

  return agent;
}

function toSnapshotTool(data: Record<string, unknown>): SnapshotTool | null {
  if (typeof data["id"] !== "string" || typeof data["name"] !== "string") {
    return null;
  }

  const tool: SnapshotTool = {
    id: data["id"],
    name: data["name"],
  };

  if (typeof data["description"] === "string") tool.description = data["description"];
  if (data["binding"] !== undefined) tool.binding = data["binding"];

  return tool;
}

function extractToolsFromPayload(data: Record<string, unknown>): SnapshotTool[] {
  if (Array.isArray(data["toolsSelected"])) {
    return data["toolsSelected"]
      .filter(isRecord)
      .map(toSnapshotTool)
      .filter((tool): tool is SnapshotTool => tool !== null);
  }

  if (Array.isArray(data["items"])) {
    return data["items"]
      .filter(isRecord)
      .map(toSnapshotTool)
      .filter((tool): tool is SnapshotTool => tool !== null);
  }

  const single = toSnapshotTool(data);
  return single === null ? [] : [single];
}

function toSnapshotFile(payload: KBFilePayload): SnapshotFile {
  return {
    filename: payload.filename,
    contentType: payload.contentType,
    bytes: [...payload.bytes],
  };
}

function emitSnapshotReady(agentId: string, snapshot: AgentSnapshot): void {
  for (const listener of snapshotReadyListeners) {
    try {
      listener(agentId, snapshot);
    } catch (error) {
      console.error("[wxo-autosave] snapshot ready listener failed", error);
    }
  }
}

function scheduleSnapshotReady(agentId: string): void {
  const timer = debounceTimers.get(agentId);
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  const nextTimer = self.setTimeout(async () => {
    debounceTimers.delete(agentId);
    const snapshots = await readSnapshots();
    const snapshot = snapshots[agentId];
    if (!snapshot) return;
    emitSnapshotReady(agentId, snapshot);
  }, DEBOUNCE_DEFAULT_MS);

  debounceTimers.set(agentId, nextTimer);
}

function findNewKnowledgeBaseId(
  knownKbIds: string[],
  currentKbIds: string[],
): string | null {
  for (const kbId of currentKbIds) {
    if (!knownKbIds.includes(kbId)) {
      return kbId;
    }
  }
  return null;
}

function attachFilesToKnowledgeBase(
  snapshot: AgentSnapshot,
  kbId: string,
  files: SnapshotFile[],
): void {
  const kbIndex = snapshot.knowledgeBases.findIndex((kb) => kb.id === kbId);
  if (kbIndex === -1) {
    snapshot.knowledgeBases.push({
      id: kbId,
      meta: { id: kbId },
      files,
    });
    return;
  }

  snapshot.knowledgeBases[kbIndex] = {
    ...snapshot.knowledgeBases[kbIndex],
    files: [...snapshot.knowledgeBases[kbIndex].files, ...files],
  };
}

async function flushPendingKbFiles(agentId: string, kbIds: string[]): Promise<void> {
  const pending = await readPendingKbFiles();
  const buffer = pending[agentId];
  if (!buffer || buffer.files.length === 0) return;

  const targetKbId = findNewKnowledgeBaseId(buffer.knownKbIds, kbIds);
  if (!targetKbId) return;

  const snapshots = await readSnapshots();
  const snapshot = snapshots[agentId];
  if (!snapshot) return;

  attachFilesToKnowledgeBase(snapshot, targetKbId, buffer.files);
  snapshot.capturedAt = new Date().toISOString();
  snapshots[agentId] = snapshot;
  delete pending[agentId];

  await Promise.all([writeSnapshots(snapshots), writePendingKbFiles(pending)]);
}

async function handleAgentCaptured(payload: AgentPayload): Promise<void> {
  const agentId = extractAgentId(payload.data);
  if (!agentId) return;

  const kbIds = extractKnowledgeBaseIds(payload.data);

  await upsertSnapshot(agentId, (snapshot) => {
    snapshot.tenant = typeof payload.data["tenant_id"] === "string"
      ? payload.data["tenant_id"]
      : snapshot.tenant;
    snapshot.agent = toSnapshotAgent(payload.data, agentId);

    for (const tool of extractToolsFromPayload(payload.data)) {
      upsertById(snapshot.tools, tool);
    }

    return snapshot;
  });

  await flushPendingKbFiles(agentId, kbIds);
  scheduleSnapshotReady(agentId);
}

async function handleToolCaptured(payload: ToolPayload): Promise<void> {
  const tools = extractToolsFromPayload(payload.data);
  if (tools.length === 0) return;

  const snapshots = await readSnapshots();
  let updated = false;

  for (const [agentId, snapshot] of Object.entries(snapshots)) {
    const toolIds = new Set(snapshot.tools.map((tool) => tool.id));
    const matching = tools.filter((tool) => toolIds.has(tool.id));
    if (matching.length === 0) continue;

    const next = cloneSnapshot(snapshot);
    for (const tool of matching) {
      upsertById(next.tools, tool);
    }
    next.capturedAt = new Date().toISOString();
    snapshots[agentId] = next;
    updated = true;
    scheduleSnapshotReady(agentId);
  }

  if (updated) {
    await writeSnapshots(snapshots);
  }
}

async function handleConnectionCaptured(payload: ConnectionPayload): Promise<void> {
  const snapshots = await readSnapshots();
  let updated = false;

  for (const [agentId, snapshot] of Object.entries(snapshots)) {
    const referencesConnection = snapshot.tools.some((tool) => {
      if (!isRecord(tool.binding)) return false;
      for (const kind of ["python", "mcp"] as const) {
        const branch = tool.binding[kind];
        if (!isRecord(branch)) continue;
        const connections = branch["connections"];
        if (!isRecord(connections)) continue;
        if (Object.prototype.hasOwnProperty.call(connections, payload.app_id)) {
          return true;
        }
      }
      return false;
    });

    if (!referencesConnection) continue;

    const next = cloneSnapshot(snapshot);
    upsertConnection(next.connections, {
      app_id: payload.app_id,
      kind: payload.kind,
      ...(payload.server_url ? { server_url: payload.server_url } : {}),
    });
    next.capturedAt = new Date().toISOString();
    snapshots[agentId] = next;
    updated = true;
    scheduleSnapshotReady(agentId);
  }

  if (updated) {
    await writeSnapshots(snapshots);
  }
}

async function handleKbMetaCaptured(payload: KBMetaPayload): Promise<void> {
  const kbId = typeof payload.data["id"] === "string" ? payload.data["id"] : null;
  if (!kbId) return;

  const snapshots = await readSnapshots();
  const pending = await readPendingKbFiles();
  let updated = false;

  for (const [agentId, snapshot] of Object.entries(snapshots)) {
    if (!snapshot.agent.knowledge_base.includes(kbId)) continue;

    const next = cloneSnapshot(snapshot);
    const existing = next.knowledgeBases.find((kb) => kb.id === kbId);
    const kb: SnapshotKnowledgeBase = {
      id: kbId,
      meta: payload.data,
      files: existing?.files ?? [],
    };
    upsertById(next.knowledgeBases, kb);

    const buffer = pending[agentId];
    if (buffer && !buffer.knownKbIds.includes(kbId)) {
      attachFilesToKnowledgeBase(next, kbId, buffer.files);
      delete pending[agentId];
    }

    next.capturedAt = new Date().toISOString();
    snapshots[agentId] = next;
    updated = true;
    scheduleSnapshotReady(agentId);
  }

  if (updated) {
    await Promise.all([writeSnapshots(snapshots), writePendingKbFiles(pending)]);
  }
}

async function handleKbFileCaptured(payload: KBFilePayload): Promise<void> {
  const file = toSnapshotFile(payload);

  if (payload.kbId === "") {
    const snapshots = await readSnapshots();
    const agentIds = Object.keys(snapshots);
    const agentId = agentIds[agentIds.length - 1];
    if (!agentId) return;

    const pending = await readPendingKbFiles();
    const snapshot = snapshots[agentId];
    const knownKbIds = snapshot ? [...snapshot.agent.knowledge_base] : [];
    const existing = pending[agentId];

    pending[agentId] = {
      knownKbIds: existing?.knownKbIds ?? knownKbIds,
      files: [...(existing?.files ?? []), file],
    };
    await writePendingKbFiles(pending);
    return;
  }

  const snapshots = await readSnapshots();
  let updated = false;

  for (const [agentId, snapshot] of Object.entries(snapshots)) {
    if (!snapshot.agent.knowledge_base.includes(payload.kbId)) continue;

    const next = cloneSnapshot(snapshot);
    attachFilesToKnowledgeBase(next, payload.kbId, [file]);

    next.capturedAt = new Date().toISOString();
    snapshots[agentId] = next;
    updated = true;
    scheduleSnapshotReady(agentId);
  }

  if (updated) {
    await writeSnapshots(snapshots);
  }
}

export function onSnapshotReady(listener: SnapshotReadyListener): void {
  snapshotReadyListeners.push(listener);
}

export function registerAssembler(events: SnapshotAssemblerEvents): void {
  events.on("AGENT_CAPTURED", (payload) => {
    void handleAgentCaptured(payload);
  });

  events.on("TOOL_CAPTURED", (payload) => {
    void handleToolCaptured(payload);
  });

  events.on("CONNECTION_CAPTURED", (payload) => {
    void handleConnectionCaptured(payload);
  });

  events.on("KB_META_CAPTURED", (payload) => {
    void handleKbMetaCaptured(payload);
  });

  events.on("KB_FILE_CAPTURED", (payload) => {
    void handleKbFileCaptured(payload);
  });
}
