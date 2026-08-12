/**
 * Unit tests for proxy zip parsing (src/zip.ts).
 *
 * Tests use fflate's zipSync to build real zip fixtures in-memory,
 * then exercise every public function — no disk I/O needed.
 *
 * Coverage:
 *  - unpackZip: valid zip, missing manifest, malformed manifest, missing fields
 *  - Path traversal guard (SEC-6): absolute paths, Windows drive letters, ../
 *  - listToolNames, readToolMeta
 *  - listKbIds, listKbDocuments, readKbDocument
 *  - listConnectionNames, readConnectionMeta
 *  - readToolSource
 */

import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  unpackZip,
  listToolNames,
  readToolMeta,
  listKbIds,
  listKbDocuments,
  readKbDocument,
  listConnectionNames,
  readConnectionMeta,
  readToolSource,
} from "../zip.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function enc(s: string): Uint8Array { return strToU8(s); }
function j(v: unknown): Uint8Array  { return enc(JSON.stringify(v)); }

const VALID_MANIFEST = {
  schemaVersion: "1.0.0",
  capturedAt: "2026-08-15T12:00:00.000Z",
  tenant: "test-tenant",
  agentId: "agent-001",
  agentName: "my-agent",
};

function makeZip(extraEntries: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "manifest.json": j(VALID_MANIFEST),
    "agent/agent.yaml": j({ id: "agent-001", name: "my-agent" }),
    ...extraEntries,
  });
}

// ─── unpackZip ────────────────────────────────────────────────────────────────

describe("unpackZip — valid zip", () => {
  it("returns entries and manifest for a well-formed zip", () => {
    const result = unpackZip(makeZip());
    expect(result.manifest.agentName).toBe("my-agent");
    expect(result.manifest.tenant).toBe("test-tenant");
    expect(result.entries["manifest.json"]).toBeDefined();
  });

  it("includes all entries in the result", () => {
    const zip = makeZip({ "tools/my_tool/tool.json": j({ name: "my_tool" }) });
    const { entries } = unpackZip(zip);
    expect(entries["tools/my_tool/tool.json"]).toBeDefined();
  });
});

describe("unpackZip — malformed input", () => {
  it("throws on non-zip bytes", () => {
    expect(() => unpackZip(new Uint8Array([1, 2, 3, 4]))).toThrow(/Failed to unzip/);
  });

  it("throws when manifest.json is absent", () => {
    const zip = zipSync({ "agent/agent.yaml": enc("{}") });
    expect(() => unpackZip(zip)).toThrow(/missing manifest\.json/);
  });

  it("throws when manifest.json is not valid JSON", () => {
    const zip = zipSync({ "manifest.json": enc("not json {{") });
    expect(() => unpackZip(zip)).toThrow(/not valid JSON/);
  });

  it("throws when manifest is missing the tenant field", () => {
    const zip = zipSync({
      "manifest.json": j({ schemaVersion: "1.0", capturedAt: "now", agentName: "x" }),
    });
    expect(() => unpackZip(zip)).toThrow(/missing required fields/);
  });

  it("throws when manifest is missing agentName", () => {
    const zip = zipSync({
      "manifest.json": j({ schemaVersion: "1.0", capturedAt: "now", tenant: "t" }),
    });
    expect(() => unpackZip(zip)).toThrow(/missing required fields/);
  });
});

describe("unpackZip — path traversal guard (SEC-6)", () => {
  it("throws on an absolute Unix path", () => {
    const zip = zipSync({ "/etc/passwd": enc("root:x:0:0") });
    expect(() => unpackZip(zip)).toThrow(/unsafe path/);
  });

  it("throws on a Windows drive letter path", () => {
    const zip = zipSync({ "C:/Windows/system32": enc("data") });
    expect(() => unpackZip(zip)).toThrow(/unsafe path/);
  });

  it("throws on a path containing ../", () => {
    // fflate normalises some paths, so construct the raw entry name manually
    const zip = zipSync({ "foo/../../../etc/shadow": enc("data") });
    expect(() => unpackZip(zip)).toThrow(/unsafe path/);
  });

  it("accepts normal relative paths", () => {
    expect(() => unpackZip(makeZip())).not.toThrow();
  });
});

// ─── listToolNames / readToolMeta ─────────────────────────────────────────────

describe("listToolNames + readToolMeta", () => {
  it("returns empty array when no tools present", () => {
    const { entries } = unpackZip(makeZip());
    expect(listToolNames(entries)).toEqual([]);
  });

  it("returns tool names from tools/{name}/tool.json entries", () => {
    const zip = makeZip({
      "tools/tool_a/tool.json": j({ name: "tool_a" }),
      "tools/tool_b/tool.json": j({ name: "tool_b" }),
    });
    const names = listToolNames(unpackZip(zip).entries);
    expect(names.sort()).toEqual(["tool_a", "tool_b"]);
  });

  it("readToolMeta returns null for an absent tool", () => {
    const { entries } = unpackZip(makeZip());
    expect(readToolMeta(entries, "nonexistent")).toBeNull();
  });

  it("readToolMeta returns the parsed tool metadata", () => {
    const meta = { name: "my_tool", id: "t1", app_id: "my-conn", sourceUnavailable: false };
    const zip = makeZip({ "tools/my_tool/tool.json": j(meta) });
    const result = readToolMeta(unpackZip(zip).entries, "my_tool");
    expect(result?.name).toBe("my_tool");
    expect(result?.app_id).toBe("my-conn");
    expect(result?.sourceUnavailable).toBe(false);
  });

  it("readToolMeta correctly reads sourceUnavailable: true", () => {
    const meta = { name: "catalog_tool", sourceUnavailable: true };
    const zip = makeZip({ "tools/catalog_tool/tool.json": j(meta) });
    const result = readToolMeta(unpackZip(zip).entries, "catalog_tool");
    expect(result?.sourceUnavailable).toBe(true);
  });
});

// ─── listKbIds / listKbDocuments / readKbDocument ─────────────────────────────

describe("listKbIds + listKbDocuments + readKbDocument", () => {
  it("returns empty when no KBs present", () => {
    const { entries } = unpackZip(makeZip());
    expect(listKbIds(entries)).toEqual([]);
  });

  it("lists KB IDs from knowledge_bases/{id}/kb.yaml entries", () => {
    const zip = makeZip({
      "knowledge_bases/kb-001/kb.yaml": j({ id: "kb-001" }),
      "knowledge_bases/kb-002/kb.yaml": j({ id: "kb-002" }),
    });
    const ids = listKbIds(unpackZip(zip).entries);
    expect(ids.sort()).toEqual(["kb-001", "kb-002"]);
  });

  it("lists document filenames under a KB", () => {
    const zip = makeZip({
      "knowledge_bases/kb-001/kb.yaml": j({ id: "kb-001" }),
      "knowledge_bases/kb-001/documents/doc1.pdf": new Uint8Array([1]),
      "knowledge_bases/kb-001/documents/doc2.txt": new Uint8Array([2]),
    });
    const docs = listKbDocuments(unpackZip(zip).entries, "kb-001");
    expect(docs.sort()).toEqual(["doc1.pdf", "doc2.txt"]);
  });

  it("readKbDocument returns the raw bytes", () => {
    const bytes = new Uint8Array([37, 80, 68, 70]); // %PDF
    const zip = makeZip({
      "knowledge_bases/kb-001/kb.yaml": j({ id: "kb-001" }),
      "knowledge_bases/kb-001/documents/doc.pdf": bytes,
    });
    const result = readKbDocument(unpackZip(zip).entries, "kb-001", "doc.pdf");
    expect(result).not.toBeNull();
    expect([...result!]).toEqual([37, 80, 68, 70]);
  });

  it("readKbDocument returns null for an absent document", () => {
    const zip = makeZip({ "knowledge_bases/kb-001/kb.yaml": j({ id: "kb-001" }) });
    expect(readKbDocument(unpackZip(zip).entries, "kb-001", "missing.pdf")).toBeNull();
  });
});

// ─── listConnectionNames / readConnectionMeta ─────────────────────────────────

describe("listConnectionNames + readConnectionMeta", () => {
  it("returns empty when no connections present", () => {
    const { entries } = unpackZip(makeZip());
    expect(listConnectionNames(entries)).toEqual([]);
  });

  it("lists connection names from connections/{name}.yaml entries", () => {
    const zip = makeZip({
      "connections/my-conn.yaml":    j({ app_id: "my-conn",    kind: "api_key_auth" }),
      "connections/other-conn.yaml": j({ app_id: "other-conn", kind: "bearer_token" }),
    });
    const names = listConnectionNames(unpackZip(zip).entries);
    expect(names.sort()).toEqual(["my-conn", "other-conn"]);
  });

  it("readConnectionMeta returns the parsed connection metadata", () => {
    const meta = { app_id: "my-conn", kind: "api_key_auth", server_url: "https://example.com" };
    const zip = makeZip({ "connections/my-conn.yaml": j(meta) });
    const result = readConnectionMeta(unpackZip(zip).entries, "my-conn");
    expect(result?.app_id).toBe("my-conn");
    expect(result?.kind).toBe("api_key_auth");
    expect(result?.server_url).toBe("https://example.com");
  });

  it("readConnectionMeta returns null for absent connection", () => {
    const { entries } = unpackZip(makeZip());
    expect(readConnectionMeta(entries, "nonexistent")).toBeNull();
  });
});

// ─── readToolSource ───────────────────────────────────────────────────────────

describe("readToolSource", () => {
  it("returns null when no source file exists", () => {
    const zip = makeZip({ "tools/my_tool/tool.json": j({ name: "my_tool" }) });
    expect(readToolSource(unpackZip(zip).entries, "my_tool")).toBeNull();
  });

  it("finds source.py", () => {
    const zip = makeZip({
      "tools/my_tool/tool.json": j({ name: "my_tool" }),
      "tools/my_tool/source.py": enc("def my_tool(): pass"),
    });
    const result = readToolSource(unpackZip(zip).entries, "my_tool");
    expect(result?.filename).toBe("source.py");
  });

  it("finds spec.yaml", () => {
    const zip = makeZip({
      "tools/api_tool/tool.json": j({ name: "api_tool" }),
      "tools/api_tool/spec.yaml": enc("openapi: '3.0'"),
    });
    const result = readToolSource(unpackZip(zip).entries, "api_tool");
    expect(result?.filename).toBe("spec.yaml");
  });

  it("returns the raw bytes of the source file", () => {
    const src = "def my_tool(): return 42\n";
    const zip = makeZip({
      "tools/t/tool.json": j({ name: "t" }),
      "tools/t/source.py": enc(src),
    });
    const result = readToolSource(unpackZip(zip).entries, "t");
    expect(result?.bytes).toBeDefined();
    expect(new TextDecoder().decode(result!.bytes)).toBe(src);
  });
});
