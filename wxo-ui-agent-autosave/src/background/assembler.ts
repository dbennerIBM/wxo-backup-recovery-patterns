/**
 * Snapshot assembler — Sub-Task 3.
 *
 * Stateful background module that coalesces captured agent/tool/connection/KB
 * events into per-agent versionable snapshots stored in chrome.storage.session.
 */

import type {
  AgentSnapshot,
  ConnectionMeta,
  RecentSnapshotEntry,
  SnapshotAgent,
  SnapshotFile,
  SnapshotKnowledgeBase,
} from "../shared";
import type {
  AgentPayload,
  ConnectionPayload,
  KBFilePayload,
  KBMetaPayload,
  ToolFilePayload,
  ToolPayload,
} from "../shared/messages";
import {
  DEBOUNCE_DEFAULT_MS,
  MAX_RECENT_SNAPSHOTS,
  RECENT_SNAPSHOTS_KEY,
  SCHEMA_VERSION,
  type SnapshotReadyPayload,
} from "../shared";
import { buildZip, snapshotContentDigest } from "../shared/zip";
import { mergeSettings, SETTINGS_STORAGE_KEY } from "../shared/settings";
import {
  agentIdFromUrl,
  agentIdsFromKbMeta,
  dedupFiles,
  extractSelectedTools,
  extractToolIds,
  extractToolsFromPayload,
  pickTenant,
  tenantFromToolsPayload,
  UNKNOWN_TENANT,
} from "../shared/capture";

export type SnapshotEventType =
  | "AGENT_CAPTURED"
  | "TOOL_CAPTURED"
  | "CONNECTION_CAPTURED"
  | "CONNECTION_BATCH_CAPTURED"
  | "KB_META_CAPTURED"
  | "KB_FILE_CAPTURED"
  | "TOOL_FILE_CAPTURED"
  | "SNAPSHOT_READY";

export interface SnapshotAssemblerEvents {
  on<T extends SnapshotEventType>(
    type: T,
    handler: (
      payload:
        T extends "AGENT_CAPTURED" ? AgentPayload
        : T extends "TOOL_CAPTURED" ? ToolPayload
        : T extends "CONNECTION_CAPTURED" ? ConnectionPayload
        : T extends "CONNECTION_BATCH_CAPTURED" ? ConnectionPayload[]
        : T extends "KB_META_CAPTURED" ? KBMetaPayload
        : T extends "KB_FILE_CAPTURED" ? KBFilePayload
        : T extends "TOOL_FILE_CAPTURED" ? ToolFilePayload
        : SnapshotReadyPayload,
    ) => void,
  ): void;
  emit(type: "SNAPSHOT_READY", payload: SnapshotReadyPayload): void;
}

const SNAPSHOT_STORAGE_KEY = "agentSnapshots";
const PENDING_KB_FILES_STORAGE_KEY = "pendingKbFiles";
const POSTED_DIGESTS_STORAGE_KEY = "postedSnapshotDigests";
const PENDING_TOOL_SOURCE_STORAGE_KEY = "pendingToolSource";

type SnapshotMap = Record<string, AgentSnapshot>;

export interface PendingKbFileBuffer {
  knownKbIds: string[];
  files: SnapshotFile[];
}

type PendingKbFileMap = Record<string, PendingKbFileBuffer>;

type SnapshotReadyListener = (agentId: string, snapshot: AgentSnapshot) => void;

const debounceTimers = new Map<string, number>();
const snapshotReadyListeners: SnapshotReadyListener[] = [];

/** Proxy hosts to try in order — localhost first, then 127.0.0.1 as fallback. */
const PROXY_HOSTS = ["localhost", "127.0.0.1"] as const;

/**
 * Try a fetch against localhost first, then 127.0.0.1 if the first attempt
 * fails with a network error. Returns the first successful Response, or
 * throws the last error if both fail.
 */
async function tryFetch(
  port: number,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for (const host of PROXY_HOSTS) {
    try {
      const url = `http://${host}:${port}${path}`;
      return await fetch(url, options);
    } catch (err) {
      lastError = err;
      // Network error — try next host
    }
  }
  throw lastError;
}

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
      tools: [...(snapshot.agent.tools ?? [])],
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
    tools: [],
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

// ─── Recent-snapshot index (chrome.storage.local) ────────────────────────────

async function readRecentSnapshotsFromStorage(): Promise<RecentSnapshotEntry[]> {
  const stored = await chrome.storage.local.get(RECENT_SNAPSHOTS_KEY);
  const value = stored[RECENT_SNAPSHOTS_KEY];
  return Array.isArray(value) ? (value as RecentSnapshotEntry[]) : [];
}

async function appendRecentSnapshot(entry: RecentSnapshotEntry): Promise<void> {
  const current = await readRecentSnapshotsFromStorage();
  // Prepend newest-first, deduplicate by agentId+capturedAt, cap at MAX.
  const next = [entry, ...current].slice(0, MAX_RECENT_SNAPSHOTS);
  await chrome.storage.local.set({ [RECENT_SNAPSHOTS_KEY]: next });
}

/** Read the recent-snapshot index from local storage. Exported for the popup. */
export async function readRecentSnapshots(): Promise<RecentSnapshotEntry[]> {
  return readRecentSnapshotsFromStorage();
}

// ─── Proxy POST ───────────────────────────────────────────────────────────────

/**
 * Serialise the snapshot to a zip and POST it to the local proxy.
 * Returns `true` on HTTP 2xx, `false` if the proxy is unreachable or returns
 * an error — never throws so a missing proxy never crashes the service worker.
 */
async function postSnapshotToProxy(
  snapshot: AgentSnapshot,
  port: number,
): Promise<boolean> {
  let zipBytes: Uint8Array;
  try {
    zipBytes = buildZip(snapshot);
  } catch (err) {
    console.error("[wxo-autosave] buildZip failed", err);
    return false;
  }
  try {
    const res = await tryFetch(port, "/snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: zipBytes,
    });
    if (!res.ok) {
      console.warn(`[wxo-autosave] proxy POST returned ${res.status}`);
      return false;
    }
    let key = "";
    try {
      const body = (await res.json()) as { key?: unknown };
      if (typeof body.key === "string") key = body.key;
    } catch { /* body optional */ }
    console.info(
      `[wxo-autosave] snapshot uploaded (${zipBytes.byteLength} bytes)` +
        (key ? ` → ${key}` : ""),
    );
    return true;
  } catch (err) {
    // Proxy offline — swallow; do not crash the service worker.
    console.warn("[wxo-autosave] proxy unreachable:", err);
    return false;
  }
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

/**
 * Agent uuid: `id` on the payload (GET response), else the last path segment of
 * the source URL (PATCH request body — the 204 response has no body).
 */
function extractAgentId(data: Record<string, unknown>, sourceUrl: string): string | null {
  if (typeof data["id"] === "string" && data["id"] !== "") return data["id"];
  return agentIdFromUrl(sourceUrl);
}

function extractKnowledgeBaseIds(data: Record<string, unknown>): string[] {
  return asStringArray(data["knowledge_base"]);
}

function toSnapshotAgent(data: Record<string, unknown>, agentId: string): SnapshotAgent {
  const agent: SnapshotAgent = {
    id: agentId,
    name: typeof data["name"] === "string" ? data["name"] : "",
    guidelines: asArray(data["guidelines"]),
    tools: extractToolIds(data),
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

/**
 * Field-level merge of an incoming agent capture over the existing agent.
 *
 * Agent captures vary in completeness: PATCH bodies carry the full editable
 * state, but agents-LIST entries carry only id/name/description. A wholesale
 * replace let those partial payloads wipe `tools`, `knowledge_base`, `llm`, …
 * (observed live: snapshots with `knowledge_base: []` moments after a save
 * that listed a KB). Only fields actually present on the payload win; for
 * everything else the existing value is kept.
 */
function mergeAgentCapture(
  existing: SnapshotAgent,
  incoming: SnapshotAgent,
  data: Record<string, unknown>,
): SnapshotAgent {
  const merged: SnapshotAgent = { ...existing, ...incoming };
  const fields = [
    "name", "display_name", "description", "instructions", "llm", "style",
    "guidelines", "tools", "knowledge_base", "collaborators", "tags",
    "structured_output",
  ] as const;
  for (const key of fields) {
    if (!(key in data)) {
      (merged as unknown as Record<string, unknown>)[key] = existing[key];
    }
  }
  return merged;
}

function toSnapshotFile(payload: KBFilePayload | ToolFilePayload): SnapshotFile {
  return {
    filename: payload.filename,
    contentType: payload.contentType,
    bytes: [...payload.bytes],
  };
}

async function emitSnapshotReady(
  events: SnapshotAssemblerEvents,
  agentId: string,
  snapshot: AgentSnapshot,
): Promise<void> {
  const payload: SnapshotReadyPayload = { agentId, snapshot };

  events.emit("SNAPSHOT_READY", payload);

  for (const listener of snapshotReadyListeners) {
    try {
      listener(agentId, snapshot);
    } catch (error) {
      console.error("[wxo-autosave] snapshot ready listener failed", error);
    }
  }

  // Dedup: merely browsing the builder fires GETs that re-capture identical
  // state on every page view. Only post when the content digest (capturedAt
  // excluded) differs from the last successfully posted snapshot (FR-3.2).
  const digest = await snapshotContentDigest(snapshot);
  const storedDigests = await chrome.storage.session.get(POSTED_DIGESTS_STORAGE_KEY);
  const digests: Record<string, string> = isRecord(storedDigests[POSTED_DIGESTS_STORAGE_KEY])
    ? (storedDigests[POSTED_DIGESTS_STORAGE_KEY] as Record<string, string>)
    : {};
  if (digests[agentId] === digest) {
    console.debug("[wxo-autosave] snapshot unchanged — skipping post", agentId);
    return;
  }

  // Read user-configured port; fall back to default if storage is empty.
  const storedSettings = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
  const { proxyPort } = mergeSettings(storedSettings[SETTINGS_STORAGE_KEY]);

  // POST zip to local proxy; on success update the recent-snapshot index.
  const ok = await postSnapshotToProxy(snapshot, proxyPort);
  if (ok) {
    digests[agentId] = digest;
    await chrome.storage.session.set({ [POSTED_DIGESTS_STORAGE_KEY]: digests });
    const entry: RecentSnapshotEntry = {
      agentId,
      agentName: snapshot.agent.display_name || snapshot.agent.name,
      tenant: snapshot.tenant,
      capturedAt: snapshot.capturedAt,
      proxyUrl: `http://localhost:${proxyPort}/snapshots`,
    };
    await appendRecentSnapshot(entry);
    console.info("[wxo-autosave] snapshot saved", agentId, snapshot.tenant, snapshot.capturedAt);
  }
}

function scheduleSnapshotReady(
  events: SnapshotAssemblerEvents,
  agentId: string,
): void {
  const timer = debounceTimers.get(agentId);
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  const nextTimer = self.setTimeout(() => {
    debounceTimers.delete(agentId);
    void (async () => {
      const snapshots = await readSnapshots();
      const snapshot = snapshots[agentId];
      if (!snapshot) return;
      await emitSnapshotReady(events, agentId, snapshot);
    })();
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
    files: dedupFiles(snapshot.knowledgeBases[kbIndex].files, files),
  };
}

/** Most recently touched agent snapshot — the "single active agent" (§ 9). */
function latestAgentId(snapshots: SnapshotMap): string | null {
  let best: string | null = null;
  let bestTs = "";
  for (const [agentId, snapshot] of Object.entries(snapshots)) {
    if (best === null || snapshot.capturedAt > bestTs) {
      best = agentId;
      bestTs = snapshot.capturedAt;
    }
  }
  return best;
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

async function handleAgentCaptured(
  events: SnapshotAssemblerEvents,
  payload: AgentPayload,
): Promise<void> {
  const agentId = extractAgentId(payload.data, payload.sourceUrl);
  if (!agentId) return;

  const kbIds = extractKnowledgeBaseIds(payload.data);

  await upsertSnapshot(agentId, (snapshot) => {
    snapshot.tenant = pickTenant(payload.data["tenant_id"], snapshot.tenant, payload.tenantHint);
    snapshot.agent = mergeAgentCapture(snapshot.agent, toSnapshotAgent(payload.data, agentId), payload.data);

    // toolsSelected[] (populated on GET; often empty on PATCH bodies) — upsert
    // whatever binding detail is present without wiping tools we already hold.
    // Only toolsSelected: the generic extractor's single-object fallback would
    // record the agent payload itself as a tool.
    for (const tool of extractSelectedTools(payload.data)) {
      upsertById(snapshot.tools, tool);
    }
    // Drop tools the agent no longer references — but only when this payload
    // actually carried a `tools` list. A payload with the key absent (agents-
    // list entries) keeps the existing set via mergeAgentCapture; a payload
    // with `tools: []` is a genuine detach-all and must prune (the old
    // `size > 0` guard kept the last detached tool forever).
    if ("tools" in payload.data) {
      const referenced = new Set(snapshot.agent.tools);
      snapshot.tools = snapshot.tools.filter((tool) => referenced.has(tool.id));
    }

    return snapshot;
  });

  await flushPendingKbFiles(agentId, kbIds);
  scheduleSnapshotReady(events, agentId);
}

// ─── Pending tool source (locally-created tool uploads) ──────────────────────

/**
 * A tool-create upload (`POST /v2/builder/tools`, multipart) produces two
 * events in unguaranteed order: TOOL_FILE_CAPTURED (the source bytes, read
 * asynchronously from FormData) and TOOL_CAPTURED (the create response — the
 * one tools payload whose URL has no `ids=` query). This buffer pairs them:
 * whichever side arrives first waits for the other.
 */
interface PendingToolSource {
  files: SnapshotFile[];
  targetToolId: string | null;
}

async function readPendingToolSource(): Promise<PendingToolSource> {
  const stored = await chrome.storage.session.get(PENDING_TOOL_SOURCE_STORAGE_KEY);
  const value = stored[PENDING_TOOL_SOURCE_STORAGE_KEY];
  return isRecord(value)
    ? (value as unknown as PendingToolSource)
    : { files: [], targetToolId: null };
}

async function writePendingToolSource(pending: PendingToolSource): Promise<void> {
  await chrome.storage.session.set({ [PENDING_TOOL_SOURCE_STORAGE_KEY]: pending });
}

/** Split captured upload files into source (first non-requirements file) + requirements. */
function splitToolUploadFiles(files: SnapshotFile[]): {
  sourceFile?: SnapshotFile;
  requirementsFile?: SnapshotFile;
} {
  const requirementsFile = files.find((f) => f.filename.toLowerCase() === "requirements.txt");
  const sourceFile = files.find((f) => f.filename.toLowerCase() !== "requirements.txt");
  return {
    ...(sourceFile ? { sourceFile } : {}),
    ...(requirementsFile ? { requirementsFile } : {}),
  };
}

/** Attach captured source files to the tool with `toolId` in every snapshot holding it. */
function attachSourceToTool(
  snapshots: SnapshotMap,
  toolId: string,
  files: SnapshotFile[],
): string[] {
  const touched: string[] = [];
  const split = splitToolUploadFiles(files);
  if (!split.sourceFile && !split.requirementsFile) return touched;

  for (const [agentId, snapshot] of Object.entries(snapshots)) {
    const index = snapshot.tools.findIndex((tool) => tool.id === toolId);
    if (index === -1) continue;
    const next = cloneSnapshot(snapshot);
    next.tools[index] = { ...next.tools[index]!, ...split };
    next.capturedAt = new Date().toISOString();
    snapshots[agentId] = next;
    touched.push(agentId);
  }
  return touched;
}

async function handleToolFileCaptured(
  events: SnapshotAssemblerEvents,
  payload: ToolFilePayload,
): Promise<void> {
  const file = toSnapshotFile(payload);
  const pending = await readPendingToolSource();
  pending.files = dedupFiles(pending.files, [file]);

  // The create response may already have arrived — attach immediately.
  if (pending.targetToolId !== null) {
    const snapshots = await readSnapshots();
    const touched = attachSourceToTool(snapshots, pending.targetToolId, pending.files);
    if (touched.length > 0) {
      await writeSnapshots(snapshots);
      await writePendingToolSource({ files: [], targetToolId: null });
      for (const agentId of touched) scheduleSnapshotReady(events, agentId);
      return;
    }
  }

  await writePendingToolSource(pending);
}

/** True when this tools payload is a create/upload response (no `ids=` batch query). */
function isToolCreateResponse(sourceUrl: string, toolCount: number): boolean {
  return toolCount === 1 && !sourceUrl.includes("ids=");
}

async function handleToolCaptured(
  events: SnapshotAssemblerEvents,
  payload: ToolPayload,
): Promise<void> {
  const tools = extractToolsFromPayload(payload.data);
  if (tools.length === 0) return;
  const toolTenant = tenantFromToolsPayload(payload.data);

  const snapshots = await readSnapshots();
  let updated = false;

  for (const [agentId, snapshot] of Object.entries(snapshots)) {
    // A tool belongs to this agent if the agent references it by id
    // (`tools[]` on the agent payload) or we already hold it from toolsSelected.
    const toolIds = new Set([
      ...snapshot.tools.map((tool) => tool.id),
      ...(snapshot.agent.tools ?? []),
    ]);
    const matching = tools.filter((tool) => toolIds.has(tool.id));
    if (matching.length === 0) continue;

    const next = cloneSnapshot(snapshot);
    for (const tool of matching) {
      upsertById(next.tools, tool);
    }
    if (toolTenant !== null && (next.tenant === "" || next.tenant === UNKNOWN_TENANT)) {
      next.tenant = toolTenant;
    }
    next.capturedAt = new Date().toISOString();
    snapshots[agentId] = next;
    updated = true;
    scheduleSnapshotReady(events, agentId);
  }

  // Tool-create response: the tool is not referenced by any agent yet (the
  // PATCH that lists it follows on the next save). Stash it on the active
  // agent so its uploaded source travels into the zip once the agent
  // references it — the prune in handleAgentCaptured drops it otherwise.
  const createdTool = tools[0];
  if (isToolCreateResponse(payload.sourceUrl, tools.length) && createdTool) {
    const agentId = latestAgentId(snapshots);
    if (agentId) {
      const next = cloneSnapshot(snapshots[agentId]!);
      upsertById(next.tools, createdTool);
      const pending = await readPendingToolSource();
      if (pending.files.length > 0) {
        // Upload bytes arrived first — attach and clear the buffer.
        const split = splitToolUploadFiles(pending.files);
        const index = next.tools.findIndex((tool) => tool.id === createdTool.id);
        next.tools[index] = { ...next.tools[index]!, ...split };
        await writePendingToolSource({ files: [], targetToolId: null });
      } else {
        // Bytes still in flight — record the target for handleToolFileCaptured.
        await writePendingToolSource({ files: [], targetToolId: createdTool.id });
      }
      next.capturedAt = new Date().toISOString();
      snapshots[agentId] = next;
      updated = true;
      scheduleSnapshotReady(events, agentId);
    }
  }

  if (updated) {
    await writeSnapshots(snapshots);
  }
}

/** app_ids referenced by any tool binding on the snapshot (python + mcp). */
function referencedConnectionAppIds(snapshot: AgentSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const tool of snapshot.tools) {
    if (!isRecord(tool.binding)) continue;
    for (const kind of ["python", "mcp"] as const) {
      const branch = tool.binding[kind];
      if (!isRecord(branch)) continue;
      const connections = branch["connections"];
      if (!isRecord(connections)) continue;
      for (const appId of Object.keys(connections)) ids.add(appId);
    }
  }
  return ids;
}

/**
 * Handle one or many connection records in a single read-modify-write.
 * (The connections list is ~200 records; processing them as independent
 * concurrent handlers raced on chrome.storage.session and lost updates.)
 */
async function handleConnectionsCaptured(
  events: SnapshotAssemblerEvents,
  payloads: ConnectionPayload[],
): Promise<void> {
  if (payloads.length === 0) return;
  const snapshots = await readSnapshots();
  let updated = false;

  for (const [agentId, snapshot] of Object.entries(snapshots)) {
    const referenced = referencedConnectionAppIds(snapshot);
    const matching = payloads.filter((p) => referenced.has(p.app_id));
    if (matching.length === 0) continue;

    const next = cloneSnapshot(snapshot);
    for (const payload of matching) {
      upsertConnection(next.connections, {
        app_id: payload.app_id,
        kind: payload.kind,
        ...(payload.server_url ? { server_url: payload.server_url } : {}),
      });
    }
    next.capturedAt = new Date().toISOString();
    snapshots[agentId] = next;
    updated = true;
    scheduleSnapshotReady(events, agentId);
  }

  if (updated) {
    await writeSnapshots(snapshots);
  }
}

async function handleKbMetaCaptured(
  events: SnapshotAssemblerEvents,
  payload: KBMetaPayload,
): Promise<void> {
  const kbId = typeof payload.data["id"] === "string" ? payload.data["id"] : null;
  if (!kbId) return;

  const snapshots = await readSnapshots();
  const pending = await readPendingKbFiles();
  let updated = false;

  // Agents this KB points back at. When an existing KB is attached to an
  // agent, the association lives on the KB (`agent_references`) — the agent
  // payload may never list the KB in `knowledge_base[]`.
  const referencedAgentIds = agentIdsFromKbMeta(payload.data);

  for (const [agentId, snapshot] of Object.entries(snapshots)) {
    // Owned by this agent, already attached (files can arrive before the
    // agent PATCH that lists the new KB), or referenced from the KB side.
    const owned =
      snapshot.agent.knowledge_base.includes(kbId) ||
      snapshot.knowledgeBases.some((kb) => kb.id === kbId) ||
      referencedAgentIds.includes(agentId);
    if (!owned) continue;

    const next = cloneSnapshot(snapshot);
    const existing = next.knowledgeBases.find((kb) => kb.id === kbId);
    const kb: SnapshotKnowledgeBase = {
      id: kbId,
      meta: payload.data,
      files: existing?.files ?? [],
    };
    upsertById(next.knowledgeBases, kb);

    // Keep the agent's own KB list in sync so the restored agent references
    // the KB even when no agent payload ever carried it. Only when the KB's
    // own agent_references names this agent — a stale local KB entry after a
    // detach must not re-attach it.
    if (referencedAgentIds.includes(agentId) && !next.agent.knowledge_base.includes(kbId)) {
      next.agent.knowledge_base.push(kbId);
    }

    const buffer = pending[agentId];
    if (buffer && !buffer.knownKbIds.includes(kbId)) {
      attachFilesToKnowledgeBase(next, kbId, buffer.files);
      delete pending[agentId];
    }

    next.capturedAt = new Date().toISOString();
    snapshots[agentId] = next;
    updated = true;
    scheduleSnapshotReady(events, agentId);
  }

  if (updated) {
    await Promise.all([writeSnapshots(snapshots), writePendingKbFiles(pending)]);
  }
}

async function handleKbFileCaptured(
  events: SnapshotAssemblerEvents,
  payload: KBFilePayload,
): Promise<void> {
  const file = toSnapshotFile(payload);

  if (payload.kbId === "") {
    const snapshots = await readSnapshots();
    const agentId = latestAgentId(snapshots);
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
    const owned =
      snapshot.agent.knowledge_base.includes(payload.kbId) ||
      snapshot.knowledgeBases.some((kb) => kb.id === payload.kbId);
    if (!owned) continue;

    const next = cloneSnapshot(snapshot);
    attachFilesToKnowledgeBase(next, payload.kbId, [file]);

    next.capturedAt = new Date().toISOString();
    snapshots[agentId] = next;
    updated = true;
    scheduleSnapshotReady(events, agentId);
  }

  // A brand-new KB: the file (with its uuid from the 201 response) arrives
  // before the agent PATCH that lists it. Attach to the active agent now; the
  // later AGENT_CAPTURED / KB_META_CAPTURED will confirm ownership and add meta.
  // Files cannot be re-fetched, so this is not deferred (single-agent session, § 9).
  if (!updated) {
    const agentId = latestAgentId(snapshots);
    if (!agentId) return;
    const next = cloneSnapshot(snapshots[agentId]!);
    attachFilesToKnowledgeBase(next, payload.kbId, [file]);
    next.capturedAt = new Date().toISOString();
    snapshots[agentId] = next;
    updated = true;
    scheduleSnapshotReady(events, agentId);
  }

  if (updated) {
    await writeSnapshots(snapshots);
  }
}

export function onSnapshotReady(listener: SnapshotReadyListener): void {
  snapshotReadyListeners.push(listener);
}

/**
 * All handlers perform read-modify-write on chrome.storage.session. Events can
 * arrive in bursts (paginated tool fetches, 200+ connections, KB polling), so
 * they are serialised through one promise chain to prevent lost updates.
 */
let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task, task).catch((err) => {
    console.error("[wxo-autosave] assembler handler failed", err);
  });
}

export function registerAssembler(events: SnapshotAssemblerEvents): void {
  events.on("AGENT_CAPTURED", (payload) => {
    enqueue(() => handleAgentCaptured(events, payload));
  });

  events.on("TOOL_CAPTURED", (payload) => {
    enqueue(() => handleToolCaptured(events, payload));
  });

  events.on("CONNECTION_CAPTURED", (payload) => {
    enqueue(() => handleConnectionsCaptured(events, [payload]));
  });

  events.on("CONNECTION_BATCH_CAPTURED", (payloads) => {
    enqueue(() => handleConnectionsCaptured(events, payloads));
  });

  events.on("KB_META_CAPTURED", (payload) => {
    enqueue(() => handleKbMetaCaptured(events, payload));
  });

  events.on("TOOL_FILE_CAPTURED", (payload) => {
    enqueue(() => handleToolFileCaptured(events, payload));
  });

  events.on("KB_FILE_CAPTURED", (payload) => {
    enqueue(() => handleKbFileCaptured(events, payload));
  });
}
