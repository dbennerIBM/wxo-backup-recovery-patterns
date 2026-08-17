/**
 * Tests for src/shared/capture.ts — pure helpers behind the assembler's
 * agent/tool/tenant/file handling. Fixtures are the shapes observed live on
 * dl.watson-orchestrate.ibm.com (Aug 2026), which differ from the v1.1 HAR
 * assumptions in three ways:
 *   1. PATCH /agents/{uuid} returns 204 — the request body is the capture, and
 *      it has no `id` (uuid only in the URL) and no `tenant_id`.
 *   2. GET /v2/builder/tools?ids= returns a paginated { data: [...] } envelope.
 *   3. Tool objects and the connections envelope carry `tenant_id`.
 */

import { describe, it, expect } from "vitest";
import {
  agentIdFromUrl,
  dedupFiles,
  extractToolIds,
  extractToolsFromPayload,
  kbIdFromUploadResponse,
  pickTenant,
  sameFile,
  tenantFromCookie,
  tenantFromToolsPayload,
  UNKNOWN_TENANT,
} from "../capture";
import type { SnapshotFile } from "../index";

const AGENT_ID = "2d340cb9-a667-462a-94c9-db078c032cd2";
const TENANT = "20250528-1755-2655-707d-39ea346a273e_20250603-2043-5947-400d-b782e9c14770";
const AGENT_URL = `https://dl.watson-orchestrate.ibm.com/mfe_builder/api/v1/builder/orchestrate/agents/${AGENT_ID}`;

/** PATCH request body as sent by the wxO UI (no id, no tenant_id, toolsSelected empty). */
const PATCH_BODY: Record<string, unknown> = {
  name: "Untitled_Agent_1_5588Qo",
  display_name: "e2e-agent1",
  description: "A general-purpose AI agent",
  instructions: "",
  tools: ["342a7eae-5de5-4ad1-b98b-388509158919", "505371b7-71fa-4655-a4c1-bf45ff4eacb0"],
  toolsSelected: [],
  knowledge_base: ["11c3aed3-cc31-4b45-b510-84faf9d02d7c"],
  llm: "groq/openai/gpt-oss-120b",
  style: "react_intrinsic",
  workspace_id: "00000000-0000-0000-0000-000000000001",
};

/** GET /v2/builder/tools?ids= response envelope (confirmed live). */
const TOOLS_ENVELOPE: Record<string, unknown> = {
  data: [
    {
      id: "342a7eae-5de5-4ad1-b98b-388509158919",
      tenant_id: TENANT,
      name: "add_a_comment_6af51",
      display_name: "add_a_comment",
      description: "Add a comment to a file",
      binding: { python: { function: "box.add_a_comment:add_a_comment", connections: { box_key_value: "7d49d119" } } },
    },
  ],
  total: 1,
  limit: 9,
  offset: 0,
  result_count: 1,
  hidden_tools_count: 0,
};

// ─── agentIdFromUrl ───────────────────────────────────────────────────────────

describe("agentIdFromUrl", () => {
  it("extracts the uuid from an agent-detail URL", () => {
    expect(agentIdFromUrl(AGENT_URL)).toBe(AGENT_ID);
  });
  it("tolerates a query string / hash", () => {
    expect(agentIdFromUrl(`${AGENT_URL}?workspace_id=x`)).toBe(AGENT_ID);
    expect(agentIdFromUrl(`${AGENT_URL}#frag`)).toBe(AGENT_ID);
  });
  it("returns null for the v2 agent list and unrelated URLs", () => {
    expect(agentIdFromUrl("https://x/mfe_builder/api/v2/builder/agents")).toBeNull();
    expect(agentIdFromUrl("https://x/mfe_builder/api/v1/orchestrate/knowledge-bases/abc")).toBeNull();
    expect(agentIdFromUrl(`${AGENT_URL}/environment`)).toBeNull();
  });
});

// ─── tenant ───────────────────────────────────────────────────────────────────

describe("tenantFromCookie", () => {
  const cookie = `BMAID=84734b65; x-ibm-wo-tenant-id=${TENANT}; x-ibm-wo-session-id=b512cf6f; _ga=GA1.1`;
  it("finds x-ibm-wo-tenant-id among other cookies", () => {
    expect(tenantFromCookie(cookie)).toBe(TENANT);
  });
  it("returns null when absent or empty", () => {
    expect(tenantFromCookie("a=1; b=2")).toBeNull();
    expect(tenantFromCookie("x-ibm-wo-tenant-id=; a=1")).toBeNull();
    expect(tenantFromCookie("")).toBeNull();
  });
  it("does not match a cookie whose name merely contains the target", () => {
    expect(tenantFromCookie("not-x-ibm-wo-tenant-id=zzz")).toBeNull();
  });
  it("URL-decodes the value", () => {
    expect(tenantFromCookie("x-ibm-wo-tenant-id=a%5Fb")).toBe("a_b");
  });
});

describe("pickTenant", () => {
  it("prefers tenant_id on the payload", () => {
    expect(pickTenant(TENANT, "other", "hint")).toBe(TENANT);
  });
  it("keeps the snapshot's existing tenant when payload has none", () => {
    expect(pickTenant(undefined, "existing", "hint")).toBe("existing");
  });
  it("uses the hint when payload and snapshot have nothing", () => {
    expect(pickTenant(undefined, "", "dl.watson-orchestrate.ibm.com")).toBe("dl.watson-orchestrate.ibm.com");
    expect(pickTenant(undefined, UNKNOWN_TENANT, "hint")).toBe("hint");
  });
  it("never returns an empty string", () => {
    expect(pickTenant(undefined, "", undefined)).toBe(UNKNOWN_TENANT);
    expect(pickTenant("", "", "")).toBe(UNKNOWN_TENANT);
  });
});

describe("tenantFromToolsPayload", () => {
  it("reads tenant_id from a tool inside the { data: [...] } envelope", () => {
    expect(tenantFromToolsPayload(TOOLS_ENVELOPE)).toBe(TENANT);
  });
  it("reads a top-level tenant_id (connections-style envelope)", () => {
    expect(tenantFromToolsPayload({ tenant_id: TENANT, applications: [] })).toBe(TENANT);
  });
  it("returns null when no tool carries tenant_id", () => {
    expect(tenantFromToolsPayload({ data: [{ id: "a", name: "b" }] })).toBeNull();
    expect(tenantFromToolsPayload({})).toBeNull();
  });
});

// ─── tools ────────────────────────────────────────────────────────────────────

describe("extractToolsFromPayload", () => {
  it("reads the paginated { data: [...] } envelope from GET /v2/builder/tools", () => {
    const tools = extractToolsFromPayload(TOOLS_ENVELOPE);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "342a7eae-5de5-4ad1-b98b-388509158919",
      name: "add_a_comment_6af51",
      description: "Add a comment to a file",
    });
    const first = (TOOLS_ENVELOPE["data"] as Array<Record<string, unknown>>)[0]!;
    expect(tools[0]!.binding).toEqual(first["binding"]);
  });
  it("reads toolsSelected[] from an agent GET response", () => {
    const tools = extractToolsFromPayload({
      id: AGENT_ID,
      toolsSelected: [{ id: "t1", name: "one", binding: { python: {} } }, { id: "t2", name: "two" }],
    });
    expect(tools.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
  it("returns [] for an agent PATCH body whose toolsSelected is empty (tools[] are ids only)", () => {
    expect(extractToolsFromPayload(PATCH_BODY)).toEqual([]);
  });
  it("still accepts a bare-array wrap { items: [...] } and a single tool", () => {
    expect(extractToolsFromPayload({ items: [{ id: "a", name: "A" }] })).toHaveLength(1);
    expect(extractToolsFromPayload({ id: "solo", name: "Solo" })).toHaveLength(1);
  });
  it("skips elements without id + name", () => {
    expect(extractToolsFromPayload({ data: [{ id: "x" }, { name: "y" }, { id: "z", name: "Z" }] })).toHaveLength(1);
  });
});

describe("extractToolIds", () => {
  it("returns the tools[] uuid list from an agent payload", () => {
    expect(extractToolIds(PATCH_BODY)).toEqual([
      "342a7eae-5de5-4ad1-b98b-388509158919",
      "505371b7-71fa-4655-a4c1-bf45ff4eacb0",
    ]);
  });
  it("ignores non-string entries and missing field", () => {
    expect(extractToolIds({ tools: ["a", 1, null, "b"] })).toEqual(["a", "b"]);
    expect(extractToolIds({})).toEqual([]);
  });
});

// ─── files ────────────────────────────────────────────────────────────────────

const f = (filename: string, len: number, contentType = "application/pdf"): SnapshotFile => ({
  filename,
  contentType,
  bytes: Array.from({ length: len }, (_, i) => i % 256),
});

describe("sameFile / dedupFiles", () => {
  it("treats same filename + same length as the same upload", () => {
    expect(sameFile(f("a.pdf", 10), f("a.pdf", 10, "text/plain"))).toBe(true);
    expect(sameFile(f("a.pdf", 10), f("a.pdf", 11))).toBe(false);
    expect(sameFile(f("a.pdf", 10), f("b.pdf", 10))).toBe(false);
  });
  it("dedupFiles skips duplicates observed on a second capture path", () => {
    const existing = [f("a.pdf", 10)];
    const out = dedupFiles(existing, [f("a.pdf", 10), f("b.pdf", 5), f("b.pdf", 5)]);
    expect(out.map((x) => x.filename)).toEqual(["a.pdf", "b.pdf"]);
    expect(existing).toHaveLength(1); // input not mutated
  });
});

// ─── KB upload response ───────────────────────────────────────────────────────

describe("kbIdFromUploadResponse", () => {
  it("reads knowledge_base from the KB-create 201 body", () => {
    expect(
      kbIdFromUploadResponse({ tool: "t", vector_index: "v", doc_collection: "d", knowledge_base: "1213c319" }),
    ).toBe("1213c319");
  });
  it("returns null when absent", () => {
    expect(kbIdFromUploadResponse({ id: "1213c319" })).toBeNull();
    expect(kbIdFromUploadResponse({ knowledge_base: "" })).toBeNull();
  });
});
