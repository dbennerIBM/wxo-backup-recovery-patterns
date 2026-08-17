/**
 * Unit tests for background service worker logic.
 *
 * PURPOSE: Validate the message-dispatch, event-emission, scrubbing, and
 * rawBytesFromRequestBody logic without any browser API dependencies.
 *
 * The background/index.ts module depends on chrome.* globals and cannot be
 * imported directly in vitest. Instead we extract and test the pure-function
 * portions directly.
 *
 * Pure logic under test:
 *  - rawBytesFromRequestBody  — ArrayBuffer chunk concatenation
 *  - handleMessage dispatch   — per-message-type scrubbing + emit logic
 *  - on/emit event bus        — handler registration and invocation
 *  - BEARER_TOKEN_OBSERVED    — token storage (no emit)
 *  - Defence-in-depth scrub   — background re-applies scrubSecrets / scrubConnectionPayload
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { scrubSecrets, scrubConnectionPayload } from "../scrubber";
import { isExtensionMessage, type ExtensionMessage } from "../messages";
import type { AgentSnapshot, SnapshotReadyPayload } from "../index";

// ─── Inline pure-function extracts from background/index.ts ──────────────────
// These are copy-extracted here because background/index.ts cannot be imported
// (it references chrome.* globals). We test the logic in isolation.

/** Reconstruct raw bytes from a simulated webRequest requestBody. */
function rawBytesFromRequestBody(
  requestBody: { raw?: Array<{ bytes?: ArrayBuffer }> } | null,
): Uint8Array | null {
  const raw = requestBody?.raw;
  if (!raw || raw.length === 0) return null;
  const totalLength = raw.reduce(
    (sum, chunk) => sum + (chunk.bytes?.byteLength ?? 0),
    0,
  );
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of raw) {
    if (chunk.bytes) {
      combined.set(new Uint8Array(chunk.bytes), offset);
      offset += chunk.bytes.byteLength;
    }
  }
  return combined;
}

// ─── Minimal event bus (mirrors background/index.ts on/emit) ─────────────────

type EventHandler<T> = (payload: T) => void;

function makeEventBus() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = new Map<string, Array<EventHandler<any>>>();

  function on<T extends ExtensionMessage>(
    type: T["type"],
    handler: EventHandler<T["payload"]>,
  ): void {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type)!.push(handler);
  }

  function emit<T extends ExtensionMessage>(
    type: T["type"],
    payload: T["payload"],
  ): void {
    const list = handlers.get(type);
    if (!list) return;
    for (const h of list) {
      try { h(payload); } catch { /* swallow */ }
    }
  }

  return { on, emit, handlers };
}

// ─── Minimal handleMessage (mirrors background/index.ts dispatch) ─────────────

function makeHandleMessage(
  bus: ReturnType<typeof makeEventBus>,
  tokenStore: { value: string | null },
) {
  return function handleMessage(message: ExtensionMessage): void {
    switch (message.type) {
      case "BEARER_TOKEN_OBSERVED": {
        tokenStore.value = message.payload.token;
        // Do not emit
        break;
      }
      case "AGENT_CAPTURED": {
        const scrubbed = scrubSecrets(message.payload.data) as Record<string, unknown>;
        bus.emit("AGENT_CAPTURED", { data: scrubbed, sourceUrl: message.payload.sourceUrl });
        break;
      }
      case "TOOL_CAPTURED": {
        const scrubbed = scrubSecrets(message.payload.data) as Record<string, unknown>;
        bus.emit("TOOL_CAPTURED", { data: scrubbed, sourceUrl: message.payload.sourceUrl });
        break;
      }
      case "CONNECTION_CAPTURED": {
        const scrubbed = scrubConnectionPayload({
          app_id: message.payload.app_id,
          kind: message.payload.kind,
          server_url: message.payload.server_url,
        });
        bus.emit("CONNECTION_CAPTURED", scrubbed);
        break;
      }
      case "KB_META_CAPTURED": {
        const scrubbed = scrubSecrets(message.payload.data) as Record<string, unknown>;
        bus.emit("KB_META_CAPTURED", { data: scrubbed, sourceUrl: message.payload.sourceUrl });
        break;
      }
      case "KB_FILE_CAPTURED": {
        bus.emit("KB_FILE_CAPTURED", message.payload);
        break;
      }
      case "TOOL_FILE_CAPTURED": {
        bus.emit("TOOL_FILE_CAPTURED", message.payload);
        break;
      }
    }
  };
}

// ─── Inline pure-function extracts from background/assembler.ts ───────────────

interface TestSnapshotFile {
  filename: string;
  contentType: string;
  bytes: number[];
}

interface TestKnowledgeBase {
  id: string;
  meta: Record<string, unknown>;
  files: TestSnapshotFile[];
}

interface TestAgentSnapshot {
  knowledgeBases: TestKnowledgeBase[];
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
  snapshot: TestAgentSnapshot,
  kbId: string,
  files: TestSnapshotFile[],
): void {
  const kbIndex = snapshot.knowledgeBases.findIndex((kb) => kb.id === kbId);
  if (kbIndex === -1) {
    snapshot.knowledgeBases.push({ id: kbId, meta: { id: kbId }, files });
    return;
  }

  snapshot.knowledgeBases[kbIndex] = {
    ...snapshot.knowledgeBases[kbIndex],
    files: [...snapshot.knowledgeBases[kbIndex].files, ...files],
  };
}

// ─── rawBytesFromRequestBody ──────────────────────────────────────────────────

describe("rawBytesFromRequestBody — ArrayBuffer chunk concatenation", () => {
  it("returns null for null body", () => {
    expect(rawBytesFromRequestBody(null)).toBeNull();
  });

  it("returns null for body with no raw field", () => {
    expect(rawBytesFromRequestBody({})).toBeNull();
  });

  it("returns null for empty raw array", () => {
    expect(rawBytesFromRequestBody({ raw: [] })).toBeNull();
  });

  it("returns empty Uint8Array for a single chunk with no bytes field (zero-length body)", () => {
    // A chunk with no bytes contributes 0 bytes. totalLength = 0 → combined = Uint8Array(0).
    // The function does not return null in this case; the caller discards zero-length results.
    const result = rawBytesFromRequestBody({ raw: [{}] });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(0);
  });

  it("returns Uint8Array for a single chunk", () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = rawBytesFromRequestBody({ raw: [{ bytes: buf }] });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
    expect([...result!]).toEqual([1, 2, 3, 4]);
  });

  it("concatenates multiple chunks in order", () => {
    const buf1 = new Uint8Array([10, 20]).buffer;
    const buf2 = new Uint8Array([30, 40, 50]).buffer;
    const result = rawBytesFromRequestBody({ raw: [{ bytes: buf1 }, { bytes: buf2 }] });
    expect(result).not.toBeNull();
    expect([...result!]).toEqual([10, 20, 30, 40, 50]);
  });

  it("skips chunks with undefined bytes (no crash, no gap in output)", () => {
    const buf = new Uint8Array([1, 2]).buffer;
    const result = rawBytesFromRequestBody({ raw: [{ bytes: buf }, {}, { bytes: buf }] });
    // Chunks without bytes contribute 0 bytes
    expect(result).not.toBeNull();
    expect([...result!]).toEqual([1, 2, 1, 2]);
  });

  it("handles a realistic 1 KB chunk correctly", () => {
    const bytes = new Uint8Array(1024);
    bytes.fill(0xab);
    const result = rawBytesFromRequestBody({ raw: [{ bytes: bytes.buffer }] });
    expect(result!.length).toBe(1024);
    expect(result![0]).toBe(0xab);
    expect(result![1023]).toBe(0xab);
  });
});

// ─── Event bus: on / emit ─────────────────────────────────────────────────────

describe("event bus — on/emit registration and invocation", () => {
  it("registered handler is called when matching type is emitted", () => {
    const bus = makeEventBus();
    const handler = vi.fn();
    bus.on("AGENT_CAPTURED", handler);
    bus.emit("AGENT_CAPTURED", { data: { id: "x" }, sourceUrl: "/agents/x" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("handler is called with the emitted payload", () => {
    const bus = makeEventBus();
    const handler = vi.fn();
    bus.on("TOOL_CAPTURED", handler);
    const payload = { data: { name: "my_tool" }, sourceUrl: "/tools/123" };
    bus.emit("TOOL_CAPTURED", payload);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it("handler not registered for a type is not called", () => {
    const bus = makeEventBus();
    const handler = vi.fn();
    bus.on("AGENT_CAPTURED", handler);
    bus.emit("TOOL_CAPTURED", { data: {}, sourceUrl: "" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("multiple handlers for the same type are all called in registration order", () => {
    const bus = makeEventBus();
    const calls: number[] = [];
    bus.on("KB_META_CAPTURED", () => calls.push(1));
    bus.on("KB_META_CAPTURED", () => calls.push(2));
    bus.emit("KB_META_CAPTURED", { data: {}, sourceUrl: "" });
    expect(calls).toEqual([1, 2]);
  });

  it("a throwing handler does not prevent subsequent handlers from running", () => {
    const bus = makeEventBus();
    bus.on("AGENT_CAPTURED", () => { throw new Error("boom"); });
    const safe = vi.fn();
    bus.on("AGENT_CAPTURED", safe);
    expect(() => bus.emit("AGENT_CAPTURED", { data: {}, sourceUrl: "" })).not.toThrow();
    expect(safe).toHaveBeenCalledOnce();
  });
});

// ─── handleMessage dispatch ───────────────────────────────────────────────────

describe("handleMessage dispatch — per-type routing and scrubbing", () => {
  let bus: ReturnType<typeof makeEventBus>;
  let tokenStore: { value: string | null };
  let handleMessage: ReturnType<typeof makeHandleMessage>;

  beforeEach(() => {
    bus = makeEventBus();
    tokenStore = { value: null };
    handleMessage = makeHandleMessage(bus, tokenStore);
  });

  it("BEARER_TOKEN_OBSERVED stores the CSRF token without emitting", () => {
    const emitSpy = vi.spyOn(bus, "emit");
    handleMessage({ type: "BEARER_TOKEN_OBSERVED", payload: { token: "csrf-abc" } });
    expect(tokenStore.value).toBe("csrf-abc");
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("BEARER_TOKEN_OBSERVED updates the token when called again", () => {
    handleMessage({ type: "BEARER_TOKEN_OBSERVED", payload: { token: "token-1" } });
    handleMessage({ type: "BEARER_TOKEN_OBSERVED", payload: { token: "token-2" } });
    expect(tokenStore.value).toBe("token-2");
  });

  it("AGENT_CAPTURED emits scrubbed payload to AGENT_CAPTURED handlers", () => {
    const received: unknown[] = [];
    bus.on("AGENT_CAPTURED", (p) => received.push(p));

    handleMessage({
      type: "AGENT_CAPTURED",
      payload: {
        data: { id: "agent-1", name: "my-agent", instructions: "do stuff" },
        sourceUrl: "/v1/builder/orchestrate/agents/agent-1",
      },
    });

    expect(received).toHaveLength(1);
    const payload = received[0] as { data: Record<string, unknown>; sourceUrl: string };
    expect(payload.data["id"]).toBe("agent-1");
    expect(payload.sourceUrl).toBe("/v1/builder/orchestrate/agents/agent-1");
  });

  it("AGENT_CAPTURED scrubs credential fields before emitting", () => {
    const received: { data: Record<string, unknown> }[] = [];
    bus.on("AGENT_CAPTURED", (p) => received.push(p as typeof received[0]));

    handleMessage({
      type: "AGENT_CAPTURED",
      payload: {
        data: { id: "a1", api_key: "secret-value", name: "secure-agent" },
        sourceUrl: "/v1/builder/orchestrate/agents/a1",
      },
    });

    expect(received[0]!.data["api_key"]).toBe("[REDACTED]");
    expect(received[0]!.data["name"]).toBe("secure-agent");
  });

  it("TOOL_CAPTURED emits scrubbed payload", () => {
    const received: unknown[] = [];
    bus.on("TOOL_CAPTURED", (p) => received.push(p));

    handleMessage({
      type: "TOOL_CAPTURED",
      payload: {
        data: { id: "t1", name: "my_tool", binding: { python: { connections: {} } } },
        sourceUrl: "/v2/builder/tools?ids=t1",
      },
    });

    expect(received).toHaveLength(1);
    const payload = received[0] as { data: Record<string, unknown>; sourceUrl: string };
    expect(payload.data["name"]).toBe("my_tool");
  });

  it("CONNECTION_CAPTURED re-scrubs payload (defence-in-depth) before emitting", () => {
    const received: unknown[] = [];
    bus.on("CONNECTION_CAPTURED", (p) => received.push(p));

    handleMessage({
      type: "CONNECTION_CAPTURED",
      payload: { app_id: "my-conn", kind: "api_key_auth", server_url: "https://example.com" },
    });

    expect(received).toHaveLength(1);
    const scrubbed = received[0] as { app_id: string; kind: string; server_url?: string };
    expect(scrubbed.app_id).toBe("my-conn");
    expect(scrubbed.kind).toBe("api_key_auth");
    expect(scrubbed.server_url).toBe("https://example.com");
  });

  it("CONNECTION_CAPTURED strips extra fields beyond the allowlist", () => {
    const received: unknown[] = [];
    bus.on("CONNECTION_CAPTURED", (p) => received.push(p));

    // Simulate a case where the content script didn't fully scrub
    handleMessage({
      type: "CONNECTION_CAPTURED",
      // @ts-expect-error — intentionally passing extra fields for testing
      payload: { app_id: "c1", kind: "bearer_token", server_url: "https://x.com", is_configured: true, credentials_entered: true },
    });

    const out = received[0] as Record<string, unknown>;
    expect(out["app_id"]).toBe("c1");
    expect(out["kind"]).toBe("bearer_token");
    expect(out).not.toHaveProperty("is_configured");
    expect(out).not.toHaveProperty("credentials_entered");
  });

  it("KB_META_CAPTURED emits scrubbed payload", () => {
    const received: unknown[] = [];
    bus.on("KB_META_CAPTURED", (p) => received.push(p));

    handleMessage({
      type: "KB_META_CAPTURED",
      payload: { data: { id: "kb-1", name: "my-kb" }, sourceUrl: "/v2/builder/knowledge-bases" },
    });

    expect(received).toHaveLength(1);
  });

  it("KB_FILE_CAPTURED emits the payload verbatim", () => {
    const received: unknown[] = [];
    bus.on("KB_FILE_CAPTURED", (p) => received.push(p));

    const filePayload = {
      kbId: "kb-abc",
      filename: "doc.pdf",
      contentType: "application/pdf",
      bytes: [37, 80, 68, 70],  // %PDF
    };

    handleMessage({ type: "KB_FILE_CAPTURED", payload: filePayload });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(filePayload);
  });

// ─── assembler KB correlation helpers ─────────────────────────────────────────

describe("assembler KB correlation helpers — one-agent active-session boundary", () => {
  it("findNewKnowledgeBaseId returns the newly added kb id", () => {
    expect(
      findNewKnowledgeBaseId(["kb-existing"], ["kb-existing", "kb-new"]),
    ).toBe("kb-new");
  });

  it("findNewKnowledgeBaseId returns null when no new kb id appears", () => {
    expect(
      findNewKnowledgeBaseId(["kb-existing"], ["kb-existing"]),
    ).toBeNull();
  });

  it("findNewKnowledgeBaseId returns the first unseen kb id when multiple are present", () => {
    expect(
      findNewKnowledgeBaseId(["kb-1"], ["kb-1", "kb-2", "kb-3"]),
    ).toBe("kb-2");
  });

  it("attachFilesToKnowledgeBase creates a new KB entry when absent", () => {
    const snapshot: TestAgentSnapshot = { knowledgeBases: [] };
    const files: TestSnapshotFile[] = [
      { filename: "doc1.pdf", contentType: "application/pdf", bytes: [1, 2] },
    ];

    attachFilesToKnowledgeBase(snapshot, "kb-new", files);

    expect(snapshot.knowledgeBases).toHaveLength(1);
    expect(snapshot.knowledgeBases[0]).toEqual({
      id: "kb-new",
      meta: { id: "kb-new" },
      files,
    });
  });

  it("attachFilesToKnowledgeBase appends files to an existing KB entry", () => {
    const snapshot: TestAgentSnapshot = {
      knowledgeBases: [
        {
          id: "kb-existing",
          meta: { id: "kb-existing", name: "existing" },
          files: [
            { filename: "doc1.pdf", contentType: "application/pdf", bytes: [1] },
          ],
        },
      ],
    };

    attachFilesToKnowledgeBase(snapshot, "kb-existing", [
      { filename: "doc2.pdf", contentType: "application/pdf", bytes: [2] },
    ]);

    expect(snapshot.knowledgeBases).toHaveLength(1);
    expect(snapshot.knowledgeBases[0]!.files).toEqual([
      { filename: "doc1.pdf", contentType: "application/pdf", bytes: [1] },
      { filename: "doc2.pdf", contentType: "application/pdf", bytes: [2] },
    ]);
    expect(snapshot.knowledgeBases[0]!.meta).toEqual({
      id: "kb-existing",
      name: "existing",
    });
  });
});

  it("TOOL_FILE_CAPTURED emits the payload verbatim", () => {
    const received: unknown[] = [];
    bus.on("TOOL_FILE_CAPTURED", (p) => received.push(p));

    const filePayload = {
      filename: "openapi.yaml",
      contentType: "application/yaml",
      bytes: [45, 45, 45],  // ---
    };

    handleMessage({ type: "TOOL_FILE_CAPTURED", payload: filePayload });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(filePayload);
  });
});

// ─── isExtensionMessage guard ─────────────────────────────────────────────────

describe("isExtensionMessage guard — rejects garbage at the chrome.runtime.onMessage boundary", () => {
  it("rejects null", () => expect(isExtensionMessage(null)).toBe(false));
  it("rejects a string", () => expect(isExtensionMessage("hello")).toBe(false));
  it("rejects an object with no type field", () => expect(isExtensionMessage({ payload: {} })).toBe(false));
  it("rejects an unknown type string", () => expect(isExtensionMessage({ type: "SOME_UNKNOWN_TYPE", payload: {} })).toBe(false));

  it("accepts all seven valid message types", () => {
    const validTypes: ExtensionMessage["type"][] = [
      "AGENT_CAPTURED", "TOOL_CAPTURED", "CONNECTION_CAPTURED",
      "KB_META_CAPTURED", "KB_FILE_CAPTURED", "TOOL_FILE_CAPTURED",
      "BEARER_TOKEN_OBSERVED",
    ];
    for (const type of validTypes) {
      expect(isExtensionMessage({ type, payload: {} }), `should accept ${type}`).toBe(true);
    }
  });
});

// ─── emitSnapshotReady — SNAPSHOT_READY bus emission ─────────────────────────
// Extracted inline from assembler.ts to test without chrome.storage dependencies.

interface TestSnapshotReadyBus {
  emittedType: string | null;
  emittedPayload: SnapshotReadyPayload | null;
  emit(type: "SNAPSHOT_READY", payload: SnapshotReadyPayload): void;
}

function makeSnapshotReadyBus(): TestSnapshotReadyBus {
  const bus: TestSnapshotReadyBus = {
    emittedType: null,
    emittedPayload: null,
    emit(type, payload) {
      bus.emittedType = type;
      bus.emittedPayload = payload;
    },
  };
  return bus;
}

function makeMinimalSnapshot(agentId: string): AgentSnapshot {
  return {
    schemaVersion: "1.0.0",
    capturedAt: "2026-08-15T00:00:00.000Z",
    tenant: "test-tenant",
    agent: {
      id: agentId,
      name: "test-agent",
      guidelines: [],
      tools: [],
      knowledge_base: [],
      collaborators: [],
      tags: [],
      structured_output: null,
    },
    tools: [],
    knowledgeBases: [],
    connections: [],
  };
}

/** Inline extract of emitSnapshotReady from assembler.ts (pure logic only). */
function extractedEmitSnapshotReady(
  bus: { emit(type: "SNAPSHOT_READY", payload: SnapshotReadyPayload): void },
  legacyListeners: Array<(agentId: string, snapshot: AgentSnapshot) => void>,
  agentId: string,
  snapshot: AgentSnapshot,
): void {
  const payload: SnapshotReadyPayload = { agentId, snapshot };
  bus.emit("SNAPSHOT_READY", payload);
  for (const listener of legacyListeners) {
    listener(agentId, snapshot);
  }
}

describe("emitSnapshotReady — SNAPSHOT_READY payload shape and bus emission", () => {
  it("emits SNAPSHOT_READY type on the bus", () => {
    const bus = makeSnapshotReadyBus();
    const snapshot = makeMinimalSnapshot("agent-42");
    extractedEmitSnapshotReady(bus, [], "agent-42", snapshot);
    expect(bus.emittedType).toBe("SNAPSHOT_READY");
  });

  it("payload contains the correct agentId", () => {
    const bus = makeSnapshotReadyBus();
    const snapshot = makeMinimalSnapshot("agent-42");
    extractedEmitSnapshotReady(bus, [], "agent-42", snapshot);
    expect(bus.emittedPayload!.agentId).toBe("agent-42");
  });

  it("payload contains the snapshot object", () => {
    const bus = makeSnapshotReadyBus();
    const snapshot = makeMinimalSnapshot("agent-42");
    extractedEmitSnapshotReady(bus, [], "agent-42", snapshot);
    expect(bus.emittedPayload!.snapshot).toBe(snapshot);
  });

  it("SnapshotReadyPayload shape — agentId is a string, snapshot is an object", () => {
    const bus = makeSnapshotReadyBus();
    const snapshot = makeMinimalSnapshot("shape-check");
    extractedEmitSnapshotReady(bus, [], "shape-check", snapshot);
    const p = bus.emittedPayload!;
    expect(typeof p.agentId).toBe("string");
    expect(typeof p.snapshot).toBe("object");
    expect(p.snapshot).not.toBeNull();
  });

  it("legacy onSnapshotReady listeners are still called after bus emit", () => {
    const bus = makeSnapshotReadyBus();
    const snapshot = makeMinimalSnapshot("agent-99");
    const legacyCalls: Array<{ agentId: string; snapshot: AgentSnapshot }> = [];
    const listener = (agentId: string, s: AgentSnapshot) => legacyCalls.push({ agentId, snapshot: s });
    extractedEmitSnapshotReady(bus, [listener], "agent-99", snapshot);
    expect(bus.emittedType).toBe("SNAPSHOT_READY");
    expect(legacyCalls).toHaveLength(1);
    expect(legacyCalls[0]!.agentId).toBe("agent-99");
  });

  it("bus emit is called exactly once per invocation", () => {
    let callCount = 0;
    const countingBus = {
      emit(_type: "SNAPSHOT_READY", _payload: SnapshotReadyPayload) { callCount++; },
    };
    const snapshot = makeMinimalSnapshot("agent-1");
    extractedEmitSnapshotReady(countingBus, [], "agent-1", snapshot);
    expect(callCount).toBe(1);
  });
});
