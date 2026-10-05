/**
 * Tests for transform.ts — raw captured payloads → ADK import specs.
 */

import { describe, it, expect } from "vitest";
import { toAdkAgentSpec, toAdkConnectionSpec, toAdkKnowledgeBaseSpec } from "../transform.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Raw agent payload as captured from the builder API (see live snapshots). */
function makeRawAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    collaborators: [],
    description: "A general-purpose AI agent that can assist with various tasks.",
    display_name: "e2e-test-agent",
    guidelines: [],
    id: "0e1d6fb0-dd00-4dc8-afb6-55fd920328dc",
    instructions: "",
    knowledge_base: ["kb-uuid-1"],
    llm: "groq/openai/gpt-oss-120b",
    name: "Untitled_Agent_1_8211Wn",
    structured_output: null,
    style: "react_intrinsic",
    tags: null,
    tools: ["tool-uuid-1"],
    ...overrides,
  };
}

// ─── toAdkAgentSpec ───────────────────────────────────────────────────────────

describe("toAdkAgentSpec", () => {
  const toolMap = new Map([["tool-uuid-1", "add_a_comment_6af51"]]);
  const kbMap = new Map([["kb-uuid-1", "bob_3530Kl"]]);

  it("adds spec_version and kind", () => {
    const { spec } = toAdkAgentSpec(makeRawAgent(), toolMap, kbMap);
    expect(spec.spec_version).toBe("v1");
    expect(spec.kind).toBe("native");
  });

  it("maps tool uuids to names", () => {
    const { spec, warnings } = toAdkAgentSpec(makeRawAgent(), toolMap, kbMap);
    expect(spec.tools).toEqual(["add_a_comment_6af51"]);
    expect(warnings).toEqual([]);
  });

  it("maps knowledge base uuids to names", () => {
    const { spec } = toAdkAgentSpec(makeRawAgent(), toolMap, kbMap);
    expect(spec.knowledge_base).toEqual(["bob_3530Kl"]);
  });

  it("drops unmapped tool uuids with a warning", () => {
    const { spec, warnings } = toAdkAgentSpec(makeRawAgent(), new Map(), kbMap);
    expect(spec.tools).toBeUndefined();
    expect(warnings.some((w: string) => w.includes("tool-uuid-1"))).toBe(true);
  });

  it("drops unmapped kb uuids with a warning", () => {
    const { spec, warnings } = toAdkAgentSpec(makeRawAgent(), toolMap, new Map());
    expect(spec.knowledge_base).toBeUndefined();
    expect(warnings.some((w: string) => w.includes("kb-uuid-1"))).toBe(true);
  });

  it("keeps name, display_name, llm, and style", () => {
    const { spec } = toAdkAgentSpec(makeRawAgent(), toolMap, kbMap);
    expect(spec.name).toBe("Untitled_Agent_1_8211Wn");
    expect(spec.display_name).toBe("e2e-test-agent");
    expect(spec.llm).toBe("groq/openai/gpt-oss-120b");
    expect(spec.style).toBe("react_intrinsic");
  });

  it("omits empty instructions (ADK enforces min length)", () => {
    const { spec } = toAdkAgentSpec(makeRawAgent(), toolMap, kbMap);
    expect(spec.instructions).toBeUndefined();
  });

  it("falls back to the name when description is missing (description is mandatory)", () => {
    const raw = makeRawAgent({ description: undefined });
    const { spec } = toAdkAgentSpec(raw, toolMap, kbMap);
    expect(spec.description).toBe("Untitled_Agent_1_8211Wn");
  });

  it("does not carry over raw-payload-only fields", () => {
    const { spec } = toAdkAgentSpec(makeRawAgent(), toolMap, kbMap);
    const asRecord = spec as unknown as Record<string, unknown>;
    expect(asRecord["id"]).toBeUndefined();
    expect(asRecord["tags"]).toBeUndefined();
    expect(asRecord["structured_output"]).toBeUndefined();
    expect(asRecord["collaborators"]).toBeUndefined();
    expect(asRecord["guidelines"]).toBeUndefined();
  });

  it("throws when the payload has no usable name", () => {
    expect(() => toAdkAgentSpec({}, toolMap, kbMap)).toThrow(/name/);
  });
});

// ─── toAdkConnectionSpec ──────────────────────────────────────────────────────

describe("toAdkConnectionSpec", () => {
  it.each([
    ["api_key_auth", "api_key"],
    ["basic_auth", "basic"],
    ["bearer_token", "bearer"],
    ["key_value_creds", "key_value"],
    ["oauth2", "oauth_auth_code_flow"],
  ])("maps security scheme %s to ADK kind %s", (scheme, adkKind) => {
    const spec = toAdkConnectionSpec({ app_id: "my_app", kind: scheme });
    expect(spec).not.toBeNull();
    expect(spec?.spec_version).toBe("v1");
    expect(spec?.kind).toBe("connection");
    expect(spec?.app_id).toBe("my_app");
    expect(spec?.environments.draft.kind).toBe(adkKind);
    expect(spec?.environments.draft.type).toBe("team");
  });

  it("returns null for an unknown scheme (MCP toolkit connections)", () => {
    expect(toAdkConnectionSpec({ app_id: "box_key_value", kind: "" })).toBeNull();
  });

  it("carries server_url through when present", () => {
    const spec = toAdkConnectionSpec({ app_id: "a", kind: "key_value_creds", server_url: "https://mcp.example.com" });
    expect(spec?.environments.draft.server_url).toBe("https://mcp.example.com");
  });
});

// ─── toAdkKnowledgeBaseSpec ───────────────────────────────────────────────────

describe("toAdkKnowledgeBaseSpec", () => {
  const rawMeta = {
    id: "3c54fdcb-07d9-4469-a8a5-3906e56502da",
    name: "bob_3530Kl",
    display_name: "bob",
    description: "kb-test",
    status: "ready",
    tenant_id: "t1",
    vector_index: { chunk_size: 400 },
  };

  it("builds a documents-based import spec", () => {
    const { spec } = toAdkKnowledgeBaseSpec(rawMeta, ["/tmp/doc1.pdf"]);
    expect(spec.spec_version).toBe("v1");
    expect(spec.kind).toBe("knowledge_base");
    expect(spec.name).toBe("bob_3530Kl");
    expect(spec.description).toBe("kb-test");
    expect(spec.documents).toEqual(["/tmp/doc1.pdf"]);
  });

  it("does not carry over raw-payload-only fields", () => {
    const { spec } = toAdkKnowledgeBaseSpec(rawMeta, ["/tmp/doc1.pdf"]);
    const asRecord = spec as unknown as Record<string, unknown>;
    expect(asRecord["status"]).toBeUndefined();
    expect(asRecord["tenant_id"]).toBeUndefined();
    expect(asRecord["vector_index"]).toBeUndefined();
    expect(asRecord["conversational_search_tool"]).toBeUndefined();
  });

  it("falls back to display_name, then id, for the name", () => {
    expect(toAdkKnowledgeBaseSpec({ display_name: "bob" }, []).spec.name).toBe("bob");
    expect(toAdkKnowledgeBaseSpec({ id: "kb-1" }, []).spec.name).toBe("kb-1");
    expect(() => toAdkKnowledgeBaseSpec({}, [])).toThrow(/name/);
  });
});
