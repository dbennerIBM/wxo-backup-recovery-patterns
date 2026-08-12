/**
 * Unit tests for the proxy POST and recent-snapshot index logic (Sub-Task 3 completion).
 *
 * Pure extracted logic — no chrome APIs, no real fetch.
 * Tests cover:
 *  - postSnapshotToProxy: success, proxy offline, HTTP error, buildZip error
 *  - appendRecentSnapshot: prepend-newest, cap at MAX_RECENT_SNAPSHOTS, empty store
 *  - RecentSnapshotEntry shape
 *  - Integration: successful POST triggers index append; failed POST does not
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildZip } from "../zip";
import type { AgentSnapshot, RecentSnapshotEntry } from "../index";
import { MAX_RECENT_SNAPSHOTS, PROXY_DEFAULT_PORT } from "../index";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSnapshot(agentId = "agent-001"): AgentSnapshot {
  return {
    schemaVersion: "1.0.0",
    capturedAt: "2026-08-15T12:00:00.000Z",
    tenant: "test-tenant",
    agent: {
      id: agentId,
      name: "my-agent",
      guidelines: [],
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

function makeEntry(overrides: Partial<RecentSnapshotEntry> = {}): RecentSnapshotEntry {
  return {
    agentId: "agent-001",
    agentName: "my-agent",
    tenant: "test-tenant",
    capturedAt: "2026-08-15T12:00:00.000Z",
    proxyUrl: `http://localhost:${PROXY_DEFAULT_PORT}/snapshots`,
    ...overrides,
  };
}

// ─── Inline extracts from assembler.ts ────────────────────────────────────────
// Extracted for unit testing without chrome.* globals.

/**
 * Pure logic extract of postSnapshotToProxy.
 * Accepts injectable fetch and buildZip to allow stubbing in tests.
 */
async function extractedPostSnapshotToProxy(
  snapshot: AgentSnapshot,
  port: number,
  fetchFn: typeof fetch,
  buildZipFn: (s: AgentSnapshot) => Uint8Array,
): Promise<boolean> {
  const url = `http://localhost:${port}/snapshots`;
  let zipBytes: Uint8Array;
  try {
    zipBytes = buildZipFn(snapshot);
  } catch (err) {
    console.error("[wxo-autosave] buildZip failed", err);
    return false;
  }
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: zipBytes,
    });
    if (!res.ok) {
      console.warn(`[wxo-autosave] proxy POST returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[wxo-autosave] proxy unreachable:", err);
    return false;
  }
}

/**
 * Pure logic extract of appendRecentSnapshot.
 * Accepts injectable read/write storage functions to allow in-memory testing.
 */
async function extractedAppendRecentSnapshot(
  entry: RecentSnapshotEntry,
  max: number,
  readFn: () => Promise<RecentSnapshotEntry[]>,
  writeFn: (entries: RecentSnapshotEntry[]) => Promise<void>,
): Promise<void> {
  const current = await readFn();
  const next = [entry, ...current].slice(0, max);
  await writeFn(next);
}

// ─── postSnapshotToProxy ──────────────────────────────────────────────────────

describe("postSnapshotToProxy — fetch behaviour", () => {
  it("returns true when proxy responds with 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await extractedPostSnapshotToProxy(
      makeSnapshot(),
      PROXY_DEFAULT_PORT,
      mockFetch as unknown as typeof fetch,
      buildZip,
    );
    expect(result).toBe(true);
  });

  it("POSTs to the correct URL with the correct method", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await extractedPostSnapshotToProxy(
      makeSnapshot(),
      PROXY_DEFAULT_PORT,
      mockFetch as unknown as typeof fetch,
      buildZip,
    );
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://localhost:${PROXY_DEFAULT_PORT}/snapshots`);
    expect(init.method).toBe("POST");
  });

  it("sends Content-Type: application/zip", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await extractedPostSnapshotToProxy(
      makeSnapshot(),
      PROXY_DEFAULT_PORT,
      mockFetch as unknown as typeof fetch,
      buildZip,
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/zip");
  });

  it("sends the zip bytes as the body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const snapshot = makeSnapshot();
    await extractedPostSnapshotToProxy(
      snapshot,
      PROXY_DEFAULT_PORT,
      mockFetch as unknown as typeof fetch,
      buildZip,
    );
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(Uint8Array);
    const expectedBytes = buildZip(snapshot);
    expect(init.body).toEqual(expectedBytes);
  });

  it("returns false when proxy responds with 500", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await extractedPostSnapshotToProxy(
      makeSnapshot(),
      PROXY_DEFAULT_PORT,
      mockFetch as unknown as typeof fetch,
      buildZip,
    );
    expect(result).toBe(false);
  });

  it("returns false when fetch throws (proxy offline)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await extractedPostSnapshotToProxy(
      makeSnapshot(),
      PROXY_DEFAULT_PORT,
      mockFetch as unknown as typeof fetch,
      buildZip,
    );
    expect(result).toBe(false);
  });

  it("returns false when buildZip throws", async () => {
    const mockFetch = vi.fn();
    const throwingBuild = () => { throw new Error("zip error"); };
    const result = await extractedPostSnapshotToProxy(
      makeSnapshot(),
      PROXY_DEFAULT_PORT,
      mockFetch as unknown as typeof fetch,
      throwingBuild,
    );
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses the supplied port number in the URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    await extractedPostSnapshotToProxy(
      makeSnapshot(),
      9999,
      mockFetch as unknown as typeof fetch,
      buildZip,
    );
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:9999/snapshots");
  });
});

// ─── appendRecentSnapshot — index management ──────────────────────────────────

describe("appendRecentSnapshot — index management", () => {
  let store: RecentSnapshotEntry[];
  let readFn: () => Promise<RecentSnapshotEntry[]>;
  let writeFn: (entries: RecentSnapshotEntry[]) => Promise<void>;

  beforeEach(() => {
    store = [];
    readFn = async () => [...store];
    writeFn = async (entries) => { store = entries; };
  });

  it("adds the first entry to an empty store", async () => {
    await extractedAppendRecentSnapshot(makeEntry(), MAX_RECENT_SNAPSHOTS, readFn, writeFn);
    expect(store).toHaveLength(1);
    expect(store[0]!.agentId).toBe("agent-001");
  });

  it("prepends newest entry first", async () => {
    const older = makeEntry({ capturedAt: "2026-08-15T11:00:00.000Z", agentId: "agent-old" });
    const newer = makeEntry({ capturedAt: "2026-08-15T12:00:00.000Z", agentId: "agent-new" });
    await extractedAppendRecentSnapshot(older, MAX_RECENT_SNAPSHOTS, readFn, writeFn);
    await extractedAppendRecentSnapshot(newer, MAX_RECENT_SNAPSHOTS, readFn, writeFn);
    expect(store[0]!.agentId).toBe("agent-new");
    expect(store[1]!.agentId).toBe("agent-old");
  });

  it("caps the list at MAX_RECENT_SNAPSHOTS", async () => {
    for (let i = 0; i < MAX_RECENT_SNAPSHOTS + 3; i++) {
      await extractedAppendRecentSnapshot(
        makeEntry({ agentId: `agent-${i}`, capturedAt: `2026-08-15T${String(i).padStart(2, "0")}:00:00.000Z` }),
        MAX_RECENT_SNAPSHOTS,
        readFn,
        writeFn,
      );
    }
    expect(store).toHaveLength(MAX_RECENT_SNAPSHOTS);
  });

  it("the oldest entry is dropped when the cap is reached", async () => {
    for (let i = 0; i < MAX_RECENT_SNAPSHOTS; i++) {
      await extractedAppendRecentSnapshot(
        makeEntry({ agentId: `agent-${i}` }),
        MAX_RECENT_SNAPSHOTS,
        readFn,
        writeFn,
      );
    }
    // Add one more — the very first entry should be gone
    await extractedAppendRecentSnapshot(
      makeEntry({ agentId: "agent-newest" }),
      MAX_RECENT_SNAPSHOTS,
      readFn,
      writeFn,
    );
    expect(store.some((e) => e.agentId === "agent-0")).toBe(false);
    expect(store[0]!.agentId).toBe("agent-newest");
  });

  it("write is called with the final entries array", async () => {
    const writeSpy = vi.fn(async (_entries: RecentSnapshotEntry[]) => { store = _entries; });
    await extractedAppendRecentSnapshot(makeEntry(), MAX_RECENT_SNAPSHOTS, readFn, writeSpy);
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(writeSpy.mock.calls[0]![0]).toHaveLength(1);
  });
});

// ─── RecentSnapshotEntry shape ─────────────────────────────────────────────────

describe("RecentSnapshotEntry — shape", () => {
  it("entry produced from a snapshot has the correct agentId", () => {
    const snap = makeSnapshot("agent-shape");
    const entry: RecentSnapshotEntry = {
      agentId: snap.agent.id,
      agentName: snap.agent.name,
      tenant: snap.tenant,
      capturedAt: snap.capturedAt,
      proxyUrl: `http://localhost:${PROXY_DEFAULT_PORT}/snapshots`,
    };
    expect(entry.agentId).toBe("agent-shape");
    expect(entry.agentName).toBe("my-agent");
    expect(entry.tenant).toBe("test-tenant");
    expect(entry.proxyUrl).toContain(`${PROXY_DEFAULT_PORT}`);
  });
});

// ─── Integration: POST outcome drives index write ─────────────────────────────

describe("proxy POST outcome drives index write", () => {
  it("index is appended when proxy returns 200", async () => {
    let store: RecentSnapshotEntry[] = [];
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const ok = await extractedPostSnapshotToProxy(
      makeSnapshot(),
      PROXY_DEFAULT_PORT,
      mockFetch as unknown as typeof fetch,
      buildZip,
    );
    if (ok) {
      await extractedAppendRecentSnapshot(
        makeEntry(),
        MAX_RECENT_SNAPSHOTS,
        async () => [...store],
        async (e) => { store = e; },
      );
    }
    expect(store).toHaveLength(1);
  });

  it("index is NOT appended when proxy is offline", async () => {
    let store: RecentSnapshotEntry[] = [];
    const mockFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const ok = await extractedPostSnapshotToProxy(
      makeSnapshot(),
      PROXY_DEFAULT_PORT,
      mockFetch as unknown as typeof fetch,
      buildZip,
    );
    if (ok) {
      await extractedAppendRecentSnapshot(
        makeEntry(),
        MAX_RECENT_SNAPSHOTS,
        async () => [...store],
        async (e) => { store = e; },
      );
    }
    expect(store).toHaveLength(0);
  });
});
