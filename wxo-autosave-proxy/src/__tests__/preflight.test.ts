/**
 * Unit tests for proxy preflight report builder (src/preflight.ts).
 *
 * All fixtures are built using the zip helpers — no disk I/O.
 *
 * Coverage:
 *  - Empty snapshot produces empty lists
 *  - connections_to_recredential contains all connections
 *  - tools_source_unavailable contains only flagged tools
 *  - restore_order is always the canonical sequence
 */

import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { unpackZip } from "../zip.js";
import { buildPreflightReport } from "../preflight.js";

function enc(s: string): Uint8Array { return strToU8(s); }
function j(v: unknown): Uint8Array  { return enc(JSON.stringify(v)); }

const BASE_MANIFEST = {
  schemaVersion: "1.0.0",
  capturedAt: "2026-08-15T12:00:00.000Z",
  tenant: "test-tenant",
  agentId: "agent-001",
  agentName: "my-agent",
};

function makeZip(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({ "manifest.json": j(BASE_MANIFEST), ...extra });
}

function parsed(extra: Record<string, Uint8Array> = {}) {
  return unpackZip(makeZip(extra));
}

// ─── restore_order ────────────────────────────────────────────────────────────

describe("buildPreflightReport — restore_order", () => {
  it("always returns the canonical dependency order", () => {
    const report = buildPreflightReport(parsed());
    expect(report.restore_order).toEqual(["connections", "tools", "knowledge_bases", "agent"]);
  });
});

// ─── connections_to_recredential ──────────────────────────────────────────────

describe("buildPreflightReport — connections_to_recredential", () => {
  it("is empty when snapshot has no connections", () => {
    expect(buildPreflightReport(parsed()).connections_to_recredential).toHaveLength(0);
  });

  it("includes all connections (all need re-credentialing after restore)", () => {
    const zip = parsed({
      "connections/conn-a.yaml": j({ app_id: "conn-a", kind: "api_key_auth" }),
      "connections/conn-b.yaml": j({ app_id: "conn-b", kind: "bearer_token", server_url: "https://x.com" }),
    });
    const report = buildPreflightReport(zip);
    expect(report.connections_to_recredential).toHaveLength(2);
  });

  it("report entry has app_id and kind", () => {
    const zip = parsed({
      "connections/my-conn.yaml": j({ app_id: "my-conn", kind: "basic_auth" }),
    });
    const [conn] = buildPreflightReport(zip).connections_to_recredential;
    expect(conn?.app_id).toBe("my-conn");
    expect(conn?.kind).toBe("basic_auth");
  });

  it("includes optional server_url when present", () => {
    const zip = parsed({
      "connections/srv.yaml": j({ app_id: "srv", kind: "api_key_auth", server_url: "https://api.example.com" }),
    });
    const [conn] = buildPreflightReport(zip).connections_to_recredential;
    expect(conn?.server_url).toBe("https://api.example.com");
  });

  it("omits server_url when not present in metadata", () => {
    const zip = parsed({
      "connections/bare.yaml": j({ app_id: "bare", kind: "bearer_token" }),
    });
    const [conn] = buildPreflightReport(zip).connections_to_recredential;
    expect(conn?.server_url).toBeUndefined();
  });
});

// ─── tools_source_unavailable ─────────────────────────────────────────────────

describe("buildPreflightReport — tools_source_unavailable", () => {
  it("is empty when no tools are present", () => {
    expect(buildPreflightReport(parsed()).tools_source_unavailable).toHaveLength(0);
  });

  it("is empty when all tools have source available", () => {
    const zip = parsed({
      "tools/my_tool/tool.json": j({ name: "my_tool", sourceUnavailable: false }),
    });
    expect(buildPreflightReport(zip).tools_source_unavailable).toHaveLength(0);
  });

  it("lists tools flagged sourceUnavailable: true", () => {
    const zip = parsed({
      "tools/catalog_tool/tool.json": j({ name: "catalog_tool", sourceUnavailable: true }),
      "tools/my_tool/tool.json":      j({ name: "my_tool",      sourceUnavailable: false }),
    });
    const report = buildPreflightReport(zip);
    expect(report.tools_source_unavailable).toContain("catalog_tool");
    expect(report.tools_source_unavailable).not.toContain("my_tool");
  });

  it("does not list tools where sourceUnavailable is absent (treated as available)", () => {
    const zip = parsed({
      "tools/implicit_tool/tool.json": j({ name: "implicit_tool" }),
    });
    expect(buildPreflightReport(zip).tools_source_unavailable).toHaveLength(0);
  });

  it("uses tool name from tool.json, not the directory name", () => {
    const zip = parsed({
      "tools/dir_name/tool.json": j({ name: "actual_name", sourceUnavailable: true }),
    });
    expect(buildPreflightReport(zip).tools_source_unavailable).toContain("actual_name");
  });
});

// ─── Combined scenario ─────────────────────────────────────────────────────────

describe("buildPreflightReport — combined snapshot", () => {
  it("correctly reports all fields for a realistic snapshot", () => {
    const zip = parsed({
      "connections/salesforce.yaml": j({ app_id: "salesforce", kind: "oauth2", server_url: "https://sf.example.com" }),
      "connections/internal-api.yaml": j({ app_id: "internal-api", kind: "api_key_auth" }),
      "tools/python_tool/tool.json": j({ name: "python_tool", sourceUnavailable: false }),
      "tools/catalog_tool/tool.json": j({ name: "catalog_tool", sourceUnavailable: true }),
      "knowledge_bases/kb-001/kb.yaml": j({ id: "kb-001" }),
    });
    const report = buildPreflightReport(zip);

    expect(report.connections_to_recredential).toHaveLength(2);
    expect(report.tools_source_unavailable).toEqual(["catalog_tool"]);
    expect(report.restore_order).toEqual(["connections", "tools", "knowledge_bases", "agent"]);
  });
});
