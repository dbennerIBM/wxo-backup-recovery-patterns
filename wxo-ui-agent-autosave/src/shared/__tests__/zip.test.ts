/**
 * Unit tests for the zip serialiser (Sub-Task 4).
 *
 * All tests operate on in-memory Uint8Array values — no file I/O, no chrome APIs.
 *
 * Coverage:
 *  - buildZip produces a non-empty Uint8Array
 *  - manifest.json is present and contains expected metadata fields
 *  - agent/agent.yaml is present and round-trips the agent object
 *  - tools/ entries are present for every tool in the snapshot
 *  - knowledge_bases/ entries are present with kb.yaml and documents/
 *  - connections/ entries are present for every connection
 *  - binary file bytes survive the round-trip without corruption
 *  - determinism: same snapshot → same bytes
 *  - safeName sanitises path-unsafe characters
 *  - parseZip / readZipText / readZipJson helpers
 *  - snapshots with no tools / KBs / connections produce a valid zip
 */

import { describe, it, expect } from "vitest";
import { buildZip, parseZip, readZipText, readZipJson } from "../zip";
import type { AgentSnapshot } from "../index";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    schemaVersion: "1.0.0",
    capturedAt: "2026-08-15T12:00:00.000Z",
    tenant: "test-tenant",
    agent: {
      id: "agent-001",
      name: "my-agent",
      display_name: "My Agent",
      description: "A test agent",
      instructions: "Be helpful",
      llm: "ibm/granite-3-8b-instruct",
      style: "react",
      guidelines: [],
      tools: ["tool-001"],
      knowledge_base: ["kb-001"],
      collaborators: [],
      tags: [],
      structured_output: null,
    },
    tools: [
      {
        id: "tool-001",
        name: "my_python_tool",
        description: "Does stuff",
        binding: { python: {} },
      },
    ],
    knowledgeBases: [
      {
        id: "kb-001",
        meta: { id: "kb-001", name: "My KB" },
        files: [
          {
            filename: "doc.pdf",
            contentType: "application/pdf",
            bytes: [37, 80, 68, 70, 45],  // %PDF-
          },
        ],
      },
    ],
    connections: [
      {
        app_id: "my-conn",
        kind: "API_KEY_AUTH",
        server_url: "https://example.com",
      },
    ],
    ...overrides,
  };
}

// ─── buildZip — basic shape ───────────────────────────────────────────────────

describe("buildZip — output shape", () => {
  it("returns a non-empty Uint8Array", () => {
    const result = buildZip(makeSnapshot());
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });

  it("zip starts with the PK signature (\\x50\\x4b\\x03\\x04)", () => {
    const result = buildZip(makeSnapshot());
    // ZIP local file header magic bytes
    expect(result[0]).toBe(0x50); // P
    expect(result[1]).toBe(0x4b); // K
    expect(result[2]).toBe(0x03);
    expect(result[3]).toBe(0x04);
  });
});

// ─── manifest.json ────────────────────────────────────────────────────────────

describe("buildZip — manifest.json", () => {
  it("manifest.json is present in the zip", () => {
    const parsed = parseZip(buildZip(makeSnapshot()));
    expect(parsed["manifest.json"]).toBeDefined();
  });

  it("manifest contains schemaVersion", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const manifest = readZipJson(parsed, "manifest.json") as Record<string, unknown>;
    expect(manifest["schemaVersion"]).toBe("1.0.0");
  });

  it("manifest contains capturedAt", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const manifest = readZipJson(parsed, "manifest.json") as Record<string, unknown>;
    expect(manifest["capturedAt"]).toBe("2026-08-15T12:00:00.000Z");
  });

  it("manifest contains tenant", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const manifest = readZipJson(parsed, "manifest.json") as Record<string, unknown>;
    expect(manifest["tenant"]).toBe("test-tenant");
  });

  it("manifest contains agentId", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const manifest = readZipJson(parsed, "manifest.json") as Record<string, unknown>;
    expect(manifest["agentId"]).toBe("agent-001");
  });

  it("manifest contains agentName", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const manifest = readZipJson(parsed, "manifest.json") as Record<string, unknown>;
    expect(manifest["agentName"]).toBe("my-agent");
  });
});

// ─── agent/agent.yaml ────────────────────────────────────────────────────────

describe("buildZip — agent/agent.yaml", () => {
  it("agent/agent.yaml is present", () => {
    const parsed = parseZip(buildZip(makeSnapshot()));
    expect(parsed["agent/agent.yaml"]).toBeDefined();
  });

  it("agent.yaml round-trips the agent id", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const agent = readZipJson(parsed, "agent/agent.yaml") as Record<string, unknown>;
    expect(agent["id"]).toBe("agent-001");
  });

  it("agent.yaml round-trips the agent name", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const agent = readZipJson(parsed, "agent/agent.yaml") as Record<string, unknown>;
    expect(agent["name"]).toBe("my-agent");
  });

  it("agent.yaml contains the llm field", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const agent = readZipJson(parsed, "agent/agent.yaml") as Record<string, unknown>;
    expect(agent["llm"]).toBe("ibm/granite-3-8b-instruct");
  });
});

// ─── tools/ ───────────────────────────────────────────────────────────────────

describe("buildZip — tools/", () => {
  it("tool.json is present for each tool", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    expect(parsed["tools/my_python_tool/tool.json"]).toBeDefined();
  });

  it("tool.json round-trips the tool id", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const tool = readZipJson(parsed, "tools/my_python_tool/tool.json") as Record<string, unknown>;
    expect(tool["id"]).toBe("tool-001");
  });

  it("tool.json round-trips the tool name", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const tool = readZipJson(parsed, "tools/my_python_tool/tool.json") as Record<string, unknown>;
    expect(tool["name"]).toBe("my_python_tool");
  });

  it("multiple tools each get their own directory", () => {
    const snap = makeSnapshot({
      tools: [
        { id: "t1", name: "tool_one" },
        { id: "t2", name: "tool_two" },
      ],
    });
    const parsed = parseZip(buildZip(snap));
    expect(parsed["tools/tool_one/tool.json"]).toBeDefined();
    expect(parsed["tools/tool_two/tool.json"]).toBeDefined();
  });

  it("snapshot with no tools produces no tools/ entries", () => {
    const snap = makeSnapshot({ tools: [] });
    const parsed = parseZip(buildZip(snap));
    const toolPaths = Object.keys(parsed).filter((k) => k.startsWith("tools/"));
    expect(toolPaths).toHaveLength(0);
  });
});

// ─── knowledge_bases/ ─────────────────────────────────────────────────────────

describe("buildZip — knowledge_bases/", () => {
  it("kb.yaml is present for each KB", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    expect(parsed["knowledge_bases/kb-001/kb.yaml"]).toBeDefined();
  });

  it("kb.yaml round-trips the kb id", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const kb = readZipJson(parsed, "knowledge_bases/kb-001/kb.yaml") as Record<string, unknown>;
    expect(kb["id"]).toBe("kb-001");
  });

  it("kb.yaml includes meta fields", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const kb = readZipJson(parsed, "knowledge_bases/kb-001/kb.yaml") as Record<string, unknown>;
    expect(kb["name"]).toBe("My KB");
  });

  it("document file is present under documents/", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    expect(parsed["knowledge_bases/kb-001/documents/doc.pdf"]).toBeDefined();
  });

  it("binary document bytes are preserved exactly", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const docBytes = parsed["knowledge_bases/kb-001/documents/doc.pdf"]!;
    expect([...docBytes]).toEqual([37, 80, 68, 70, 45]);
  });

  it("multiple documents under the same KB all appear", () => {
    const snap = makeSnapshot({
      knowledgeBases: [
        {
          id: "kb-002",
          meta: { id: "kb-002" },
          files: [
            { filename: "a.txt", contentType: "text/plain", bytes: [65] },
            { filename: "b.txt", contentType: "text/plain", bytes: [66] },
          ],
        },
      ],
    });
    const parsed = parseZip(buildZip(snap));
    expect(parsed["knowledge_bases/kb-002/documents/a.txt"]).toBeDefined();
    expect(parsed["knowledge_bases/kb-002/documents/b.txt"]).toBeDefined();
  });

  it("snapshot with no KBs produces no knowledge_bases/ entries", () => {
    const snap = makeSnapshot({ knowledgeBases: [] });
    const parsed = parseZip(buildZip(snap));
    const kbPaths = Object.keys(parsed).filter((k) => k.startsWith("knowledge_bases/"));
    expect(kbPaths).toHaveLength(0);
  });
});

// ─── connections/ ─────────────────────────────────────────────────────────────

describe("buildZip — connections/", () => {
  it("connection yaml is present for each connection", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    expect(parsed["connections/my-conn.yaml"]).toBeDefined();
  });

  it("connection yaml round-trips app_id", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const conn = readZipJson(parsed, "connections/my-conn.yaml") as Record<string, unknown>;
    expect(conn["app_id"]).toBe("my-conn");
  });

  it("connection yaml round-trips kind", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const conn = readZipJson(parsed, "connections/my-conn.yaml") as Record<string, unknown>;
    expect(conn["kind"]).toBe("API_KEY_AUTH");
  });

  it("connection yaml round-trips server_url", () => {
    const snap = makeSnapshot();
    const parsed = parseZip(buildZip(snap));
    const conn = readZipJson(parsed, "connections/my-conn.yaml") as Record<string, unknown>;
    expect(conn["server_url"]).toBe("https://example.com");
  });

  it("connection without server_url omits the field", () => {
    const snap = makeSnapshot({
      connections: [{ app_id: "bare-conn", kind: "BEARER_TOKEN" }],
    });
    const parsed = parseZip(buildZip(snap));
    const conn = readZipJson(parsed, "connections/bare-conn.yaml") as Record<string, unknown>;
    expect(conn["server_url"]).toBeUndefined();
  });

  it("snapshot with no connections produces no connections/ entries", () => {
    const snap = makeSnapshot({ connections: [] });
    const parsed = parseZip(buildZip(snap));
    const connPaths = Object.keys(parsed).filter((k) => k.startsWith("connections/"));
    expect(connPaths).toHaveLength(0);
  });
});

// ─── Determinism ──────────────────────────────────────────────────────────────

describe("buildZip — determinism", () => {
  it("same snapshot produces identical bytes on repeated calls", () => {
    const snap = makeSnapshot();
    const a = buildZip(snap);
    const b = buildZip(snap);
    expect(a).toEqual(b);
  });

  it("different capturedAt timestamps produce different bytes", () => {
    const a = buildZip(makeSnapshot({ capturedAt: "2026-08-15T12:00:00.000Z" }));
    const b = buildZip(makeSnapshot({ capturedAt: "2026-08-15T13:00:00.000Z" }));
    expect(a).not.toEqual(b);
  });
});

// ─── Empty snapshot ───────────────────────────────────────────────────────────

describe("buildZip — minimal snapshot (no tools / KBs / connections)", () => {
  it("produces a valid zip with only manifest.json and agent/agent.yaml", () => {
    const snap = makeSnapshot({ tools: [], knowledgeBases: [], connections: [] });
    const result = buildZip(snap);
    expect(result.length).toBeGreaterThan(0);
    const parsed = parseZip(result);
    expect(parsed["manifest.json"]).toBeDefined();
    expect(parsed["agent/agent.yaml"]).toBeDefined();
  });
});

// ─── safeName / path-unsafe characters ────────────────────────────────────────

describe("buildZip — safeName sanitisation", () => {
  it("forward slashes in tool names are replaced with underscores", () => {
    const snap = makeSnapshot({
      tools: [{ id: "t1", name: "ns/slash-tool" }],
    });
    const parsed = parseZip(buildZip(snap));
    expect(parsed["tools/ns_slash-tool/tool.json"]).toBeDefined();
  });

  it("forward slashes in connection app_id are replaced", () => {
    const snap = makeSnapshot({
      connections: [{ app_id: "my/conn", kind: "BEARER_TOKEN" }],
    });
    const parsed = parseZip(buildZip(snap));
    expect(parsed["connections/my_conn.yaml"]).toBeDefined();
  });
});

// ─── parseZip / readZipText / readZipJson helpers ─────────────────────────────

describe("parseZip / readZipText / readZipJson", () => {
  it("readZipText returns null for an absent path", () => {
    const parsed = parseZip(buildZip(makeSnapshot()));
    expect(readZipText(parsed, "nonexistent.txt")).toBeNull();
  });

  it("readZipJson returns null for an absent path", () => {
    const parsed = parseZip(buildZip(makeSnapshot()));
    expect(readZipJson(parsed, "nonexistent.json")).toBeNull();
  });

  it("readZipText returns the UTF-8 string content for a present path", () => {
    const parsed = parseZip(buildZip(makeSnapshot()));
    const text = readZipText(parsed, "manifest.json");
    expect(typeof text).toBe("string");
    expect(text).toContain("schemaVersion");
  });

  it("readZipJson parses JSON from a present path", () => {
    const parsed = parseZip(buildZip(makeSnapshot()));
    const value = readZipJson(parsed, "manifest.json");
    expect(typeof value).toBe("object");
    expect(value).not.toBeNull();
  });
});
