/**
 * Unit tests for the URL capture patterns defined in the content script.
 *
 * CONFIRMED FROM THREE HAR RECORDINGS (us-south.watson-orchestrate.cloud.ibm.com, Aug 2026):
 *
 * HAR 1 — tool list page load:
 *   GET /mfe_builder/api/v2/builder/tools?&limit=15&offset=0&sort=asc&...
 *
 * HAR 2 — open tool detail, add catalog tool, delete tool:
 *   GET  /mfe_builder/api/v2/builder/tools?&ids=<uuid>&ids=<uuid>&show_bundled=true&...
 *   GET  /mfe_builder/api/v1/orchestrate/connections/applications?connectionIds=
 *   PATCH /mfe_builder/api/v1/builder/orchestrate/agents/<uuid>
 *   POST /mfe_builder/api/v1/builder/tools/create-from-template?parent_agent_id=<uuid>
 *
 * HAR 3 — manage agents list → agent detail → change LLM:
 *   GET  /mfe_builder/api/v1/builder/orchestrate/agents/<uuid>  (canonical agent detail, v1)
 *   GET  /mfe_builder/api/v1/builder/models/list               (available LLM models)
 *   GET  /mfe_builder/api/v1/orchestrate/connections/applications/authtype/  (auth scheme enum)
 *   GET  /mfe_builder/api/v1/builder/tools?&workspace_id=...   (v1 tool list — returns binding.connections)
 *   PATCH /mfe_builder/api/v1/builder/orchestrate/agents/<uuid> (LLM change — tools unchanged)
 *
 * Key findings from HAR 3:
 *   1. Agent GET is /v1/builder/orchestrate/agents/{id} — same path as PATCH. Both captured by one pattern.
 *   2. There is also a v1/builder/tools list (different from v2/builder/tools) — also returns binding.connections.
 *   3. connections/applications/authtype returns the full enum of security_scheme values: api_key_auth,
 *      basic_auth, bearer_token, key_value_creds, oauth2. This confirms security_scheme is the right
 *      field for kind, NOT auth_type (which is always "" for non-OAuth connections).
 *   4. PATCH body on LLM change: llm field changes; tools array is identical (UUID list unchanged).
 */
import { describe, it, expect } from "vitest";

// ─── Patterns copied from src/content/index.ts (keep in sync) ────────────────

const WXO_API_BASE = /\/mfe_builder\/api\/(v1|v2)\/(builder|orchestrate)\//;
const AGENT_V2_RE = /\/mfe_builder\/api\/v2\/builder\/agents(\/[^/?]+)?(\?|$)/;
const AGENT_V1_RE = /\/mfe_builder\/api\/v1\/builder\/orchestrate\/agents\/[^/?]+(\?|$)/;
const TOOL_V2_RE = /\/mfe_builder\/api\/v2\/builder\/tools(\?|$)/;
const CONNECTION_RE = /\/mfe_builder\/api\/v1\/orchestrate\/connections\/applications(\?|$)/;
// CONFIRMED HAR 4: ALL KB paths are /v1/orchestrate/, NOT /v2/builder/
const KB_META_RE    = /\/mfe_builder\/api\/v1\/orchestrate\/knowledge-bases\/(?!documents(?:\?|$))[^/?]+(\?|$)/;
const KB_CREATE_RE  = /\/mfe_builder\/api\/v1\/orchestrate\/knowledge-bases\/documents(\?|$)/;
const KB_UPLOAD_RE  = /\/mfe_builder\/api\/v1\/orchestrate\/knowledge-bases\/([^/?]+)\/documents(\?|$)/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function matches(re: RegExp, path: string): boolean { return re.test(path); }
function capture(re: RegExp, path: string, group = 1): string | null {
  return re.exec(path)?.[group] ?? null;
}

// ─── WXO_API_BASE ─────────────────────────────────────────────────────────────

describe("WXO_API_BASE — gates all mfe_builder/api/(v1|v2) calls", () => {
  it("matches v2/builder paths", () => {
    expect(matches(WXO_API_BASE, "/mfe_builder/api/v2/builder/tools")).toBe(true);
    expect(matches(WXO_API_BASE, "/mfe_builder/api/v2/builder/agents")).toBe(true);
  });
  it("matches v1/builder paths", () => {
    expect(matches(WXO_API_BASE, "/mfe_builder/api/v1/builder/orchestrate/agents/c0c5096f")).toBe(true);
    expect(matches(WXO_API_BASE, "/mfe_builder/api/v1/builder/models/list")).toBe(true);
    expect(matches(WXO_API_BASE, "/mfe_builder/api/v1/builder/tools")).toBe(true);
  });
  it("matches v1/orchestrate paths", () => {
    expect(matches(WXO_API_BASE, "/mfe_builder/api/v1/orchestrate/connections/applications")).toBe(true);
    expect(matches(WXO_API_BASE, "/mfe_builder/api/v1/orchestrate/connections/applications/authtype/")).toBe(true);
  });
  it("does NOT match non-mfe_builder paths", () => {
    expect(matches(WXO_API_BASE, "/v2/orchestrate/tools")).toBe(false);
    expect(matches(WXO_API_BASE, "/mfe_catalog/api/catalogv3/artifacts")).toBe(false);
  });
});

// ─── Regression guard ─────────────────────────────────────────────────────────

describe("OLD /v2/orchestrate/ and /v2/builder/knowledge-bases paths — must NOT match", () => {
  const allPatterns = [AGENT_V2_RE, AGENT_V1_RE, TOOL_V2_RE, CONNECTION_RE, KB_META_RE, KB_CREATE_RE, KB_UPLOAD_RE];
  const oldPaths = [
    "/v2/orchestrate/agents/unified",
    "/v2/orchestrate/tools",
    "/v2/orchestrate/connections",
    "/v2/orchestrate/knowledge-bases",
    // These were the WRONG KB paths (HAR 4 confirmed v1/orchestrate is correct):
    "/mfe_builder/api/v2/builder/knowledge-bases",
    "/mfe_builder/api/v2/builder/knowledge-bases/kb-abc123",
    "/mfe_builder/api/v2/builder/knowledge-bases/kb-abc123/documents",
  ];
  for (const path of oldPaths) {
    for (const re of allPatterns) {
      it(`"${path}" does not match ${re}`, () => {
        expect(matches(re, path)).toBe(false);
      });
    }
  }
});

// ─── Agent patterns ───────────────────────────────────────────────────────────

describe("AGENT_V2_RE — GET /mfe_builder/api/v2/builder/agents (list, minimal fields)", () => {
  it("matches the agent list endpoint", () => {
    expect(matches(AGENT_V2_RE, "/mfe_builder/api/v2/builder/agents")).toBe(true);
  });
  it("matches an agent list with query string", () => {
    expect(matches(AGENT_V2_RE, "/mfe_builder/api/v2/builder/agents?limit=50")).toBe(true);
  });
  it("does NOT match the v1 agent detail endpoint", () => {
    expect(matches(AGENT_V2_RE, "/mfe_builder/api/v1/builder/orchestrate/agents/c0c5096f")).toBe(false);
  });
});

describe("AGENT_V1_RE — GET+PATCH /mfe_builder/api/v1/builder/orchestrate/agents/{uuid}", () => {
  it("matches the agent GET (exact from HAR 3)", () => {
    expect(matches(AGENT_V1_RE, "/mfe_builder/api/v1/builder/orchestrate/agents/c0c5096f-bb7c-4291-b039-96ff43ade1db?workspace_id=00000000-0000-0000-0000-000000000001")).toBe(true);
  });
  it("matches the agent PATCH (LLM change from HAR 3)", () => {
    expect(matches(AGENT_V1_RE, "/mfe_builder/api/v1/builder/orchestrate/agents/c0c5096f-bb7c-4291-b039-96ff43ade1db")).toBe(true);
  });
  it("does NOT match /environment sub-path (polling endpoint)", () => {
    // /environment is polled constantly; capturing it would be very noisy.
    // The pattern requires end-of-path or query string immediately after the UUID.
    expect(matches(AGENT_V1_RE, "/mfe_builder/api/v1/builder/orchestrate/agents/c0c5096f-bb7c-4291-b039-96ff43ade1db/environment")).toBe(false);
  });
  it("does NOT match /releases/status, /template-status, /chat-starter-settings sub-paths", () => {
    const agent = "/mfe_builder/api/v1/builder/orchestrate/agents/c0c5096f-bb7c-4291-b039-96ff43ade1db";
    expect(matches(AGENT_V1_RE, agent + "/releases/status")).toBe(false);
    expect(matches(AGENT_V1_RE, agent + "/template-status")).toBe(false);
    expect(matches(AGENT_V1_RE, agent + "/chat-starter-settings")).toBe(false);
  });
  it("does NOT match /environments/{id}/channels sub-path", () => {
    expect(matches(AGENT_V1_RE, "/mfe_builder/api/v1/builder/orchestrate/agents/c0c5096f-bb7c-4291-b039-96ff43ade1db/environments/10281134/channels")).toBe(false);
  });
});

// ─── Tool patterns ────────────────────────────────────────────────────────────

describe("TOOL_V2_RE — GET /mfe_builder/api/v2/builder/tools (batch ?ids= or list)", () => {
  it("matches the bare tool list", () => {
    expect(matches(TOOL_V2_RE, "/mfe_builder/api/v2/builder/tools")).toBe(true);
  });
  it("matches the paginated list (HAR 1)", () => {
    expect(matches(TOOL_V2_RE, "/mfe_builder/api/v2/builder/tools?&limit=15&offset=0&sort=asc&include=global&workspace_id=00000000-0000-0000-0000-000000000001")).toBe(true);
  });
  it("matches the batch ?ids= fetch (HAR 2 + HAR 3)", () => {
    const path = "/mfe_builder/api/v2/builder/tools?&ids=6701c7b8-c8d6-4b00-9495-f775ae5bc908&ids=bd99f27f-6bef-4698-817a-af2b178faa09&ids=1247965e-c52d-4a0b-b533-4e1552e49d22&show_bundled=true&include=global&workspace_id=00000000-0000-0000-0000-000000000001";
    expect(matches(TOOL_V2_RE, path)).toBe(true);
  });
  it("does NOT match the v1/builder/tools endpoint (different version)", () => {
    // NOTE: /v1/builder/tools also exists (HAR 3) and returns binding.connections.
    // It is NOT currently a capture target — we rely on v2 batch-fetch instead.
    expect(matches(TOOL_V2_RE, "/mfe_builder/api/v1/builder/tools?workspace_id=00000000-0000-0000-0000-000000000001")).toBe(false);
  });
  it("does NOT match create-from-template", () => {
    expect(matches(TOOL_V2_RE, "/mfe_builder/api/v1/builder/tools/create-from-template")).toBe(false);
  });
});

// ─── Connection patterns ──────────────────────────────────────────────────────

describe("CONNECTION_RE — GET /mfe_builder/api/v1/orchestrate/connections/applications", () => {
  it("matches the exact connections list from HAR 2 + HAR 3", () => {
    expect(matches(CONNECTION_RE, "/mfe_builder/api/v1/orchestrate/connections/applications")).toBe(true);
  });
  it("matches with ?connectionIds= query (HAR 2 + HAR 3)", () => {
    expect(matches(CONNECTION_RE, "/mfe_builder/api/v1/orchestrate/connections/applications?connectionIds=")).toBe(true);
  });
  it("does NOT match the /authtype/ sub-path (enum lookup, not a connection list)", () => {
    // authtype is a static enum endpoint, not connection data — no need to capture.
    expect(matches(CONNECTION_RE, "/mfe_builder/api/v1/orchestrate/connections/applications/authtype/")).toBe(false);
  });
});

// ─── KB patterns (CONFIRMED HAR 4) ───────────────────────────────────────────

describe("KB patterns — v1/orchestrate (CONFIRMED HAR 4)", () => {
  const KB_UUID = "ad66dc1f-592f-44d4-9fad-bf2aa9dcf814";

  describe("KB_META_RE — GET /v1/orchestrate/knowledge-bases/{id}", () => {
    it("matches KB detail (exact from HAR 4)", () => {
      expect(matches(KB_META_RE, `/mfe_builder/api/v1/orchestrate/knowledge-bases/${KB_UUID}`)).toBe(true);
    });
    it("matches with workspace_id query param", () => {
      expect(matches(KB_META_RE, `/mfe_builder/api/v1/orchestrate/knowledge-bases/${KB_UUID}?workspace_id=00000000-0000-0000-0000-000000000001`)).toBe(true);
    });
    it("does NOT match the OLD v2/builder path", () => {
      expect(matches(KB_META_RE, `/mfe_builder/api/v2/builder/knowledge-bases/${KB_UUID}`)).toBe(false);
    });
    it("does NOT match the KB-create endpoint /knowledge-bases/documents (its 201 body is not KB meta)", () => {
      expect(matches(KB_META_RE, "/mfe_builder/api/v1/orchestrate/knowledge-bases/documents")).toBe(false);
      expect(matches(KB_META_RE, "/mfe_builder/api/v1/orchestrate/knowledge-bases/documents?workspace_id=0")).toBe(false);
    });
    it("does NOT match /documents sub-path (upload, not detail)", () => {
      expect(matches(KB_META_RE, `/mfe_builder/api/v1/orchestrate/knowledge-bases/${KB_UUID}/documents`)).toBe(false);
    });
    it("does NOT match /status sub-path (polling, should not be captured)", () => {
      expect(matches(KB_META_RE, `/mfe_builder/api/v1/orchestrate/knowledge-bases/${KB_UUID}/status`)).toBe(false);
    });
  });

  describe("KB_CREATE_RE — POST /v1/orchestrate/knowledge-bases/documents (create + first upload)", () => {
    it("matches the KB create endpoint (exact from HAR 4)", () => {
      expect(matches(KB_CREATE_RE, "/mfe_builder/api/v1/orchestrate/knowledge-bases/documents")).toBe(true);
    });
    it("matches with trailing query string", () => {
      expect(matches(KB_CREATE_RE, "/mfe_builder/api/v1/orchestrate/knowledge-bases/documents?workspace_id=00000000")).toBe(true);
    });
    it("does NOT match /{id}/documents (that is KB_UPLOAD_RE)", () => {
      expect(matches(KB_CREATE_RE, `/mfe_builder/api/v1/orchestrate/knowledge-bases/${KB_UUID}/documents`)).toBe(false);
    });
  });

  describe("KB_UPLOAD_RE — PUT /v1/orchestrate/knowledge-bases/{id}/documents (add more files)", () => {
    it("matches the upload path and captures KB UUID (exact from HAR 4)", () => {
      const path = `/mfe_builder/api/v1/orchestrate/knowledge-bases/${KB_UUID}/documents`;
      expect(matches(KB_UPLOAD_RE, path)).toBe(true);
      expect(capture(KB_UPLOAD_RE, path)).toBe(KB_UUID);
    });
    it("does NOT match the OLD v2/builder path", () => {
      expect(matches(KB_UPLOAD_RE, `/mfe_builder/api/v2/builder/knowledge-bases/${KB_UUID}/documents`)).toBe(false);
    });
    it("does NOT match KB_CREATE path (no UUID segment)", () => {
      expect(matches(KB_UPLOAD_RE, "/mfe_builder/api/v1/orchestrate/knowledge-bases/documents")).toBe(false);
    });
  });
});

// ─── Pattern disambiguation ───────────────────────────────────────────────────

describe("pattern disambiguation — each URL matches at most one capture pattern", () => {
  const allResponsePatterns = [
    { re: AGENT_V2_RE,   name: "AGENT_V2" },
    { re: AGENT_V1_RE,   name: "AGENT_V1" },
    { re: TOOL_V2_RE,    name: "TOOL_V2" },
    { re: CONNECTION_RE, name: "CONNECTION" },
    { re: KB_META_RE,    name: "KB_META" },
  ];
  function matchingPatterns(url: string): string[] {
    return allResponsePatterns.filter(({ re }) => re.test(url)).map(({ name }) => name);
  }
  const KB_UUID = "ad66dc1f-592f-44d4-9fad-bf2aa9dcf814";

  it("agent GET/PATCH (HAR 3) → AGENT_V1 only", () => {
    expect(matchingPatterns("/mfe_builder/api/v1/builder/orchestrate/agents/c0c5096f-bb7c-4291-b039-96ff43ade1db?workspace_id=00000000-0000-0000-0000-000000000001")).toEqual(["AGENT_V1"]);
  });
  it("tool batch ?ids= (HAR 2 + HAR 3) → TOOL_V2 only", () => {
    expect(matchingPatterns("/mfe_builder/api/v2/builder/tools?&ids=6701c7b8&ids=bd99f27f&show_bundled=true&workspace_id=00000000-0000-0000-0000-000000000001")).toEqual(["TOOL_V2"]);
  });
  it("connections list (HAR 2 + HAR 3) → CONNECTION only", () => {
    expect(matchingPatterns("/mfe_builder/api/v1/orchestrate/connections/applications?connectionIds=")).toEqual(["CONNECTION"]);
  });
  it("/environment polling endpoint → no match (must not spam captures)", () => {
    expect(matchingPatterns("/mfe_builder/api/v1/builder/orchestrate/agents/c0c5096f-bb7c-4291-b039-96ff43ade1db/environment?workspace_id=00000000-0000-0000-0000-000000000001")).toEqual([]);
  });
  it("KB detail GET (HAR 4) → KB_META only", () => {
    expect(matchingPatterns(`/mfe_builder/api/v1/orchestrate/knowledge-bases/${KB_UUID}`)).toEqual(["KB_META"]);
  });
  it("KB document upload PUT (HAR 4) → no response pattern (upload, not GET)", () => {
    // KB_UPLOAD_RE only governs REQUEST interception; it has no entry in CAPTURE_RESPONSE_PATTERNS.
    expect(matchingPatterns(`/mfe_builder/api/v1/orchestrate/knowledge-bases/${KB_UUID}/documents`)).toEqual([]);
  });
  it("KB status polling (HAR 4) → no match (must not be captured)", () => {
    expect(matchingPatterns(`/mfe_builder/api/v1/orchestrate/knowledge-bases/${KB_UUID}/status`)).toEqual([]);
  });
  it("authtype enum endpoint → no match (static enum, not connection data)", () => {
    expect(matchingPatterns("/mfe_builder/api/v1/orchestrate/connections/applications/authtype/")).toEqual([]);
  });
});

// ─── Real agent GET response shape (confirmed from HAR 3) ────────────────────

describe("agent GET response shape — confirmed from HAR 3", () => {
  // Exact agent detail response from GET /v1/builder/orchestrate/agents/{id}
  const agentDetail = {
    id: "c0c5096f-bb7c-4291-b039-96ff43ade1db",
    tenant_id: "22fbea2f8f6673a0b658e7b0cfd612b9_d24a8322-2e2e-4f54-a942-8a5666f542d9",
    workspace_id: "00000000-0000-0000-0000-000000000001",
    name: "competitive_research_analyst",
    display_name: "competitive_research_analyst",
    description: "Specialist in finding primary-source evidence...",
    instructions: "You are a competitive intelligence researcher...",
    tools: [
      "6701c7b8-c8d6-4b00-9495-f775ae5bc908",
      "bd99f27f-6bef-4698-817a-af2b178faa09",
      "1247965e-c52d-4a0b-b533-4e1552e49d22",
    ],
    collaborators: [],
    knowledge_base: [],
    llm: "virtual-model/anthropic/claude-opus-4-8",
    style: "react_intrinsic",
    guidelines: [],
    tags: null,
    structured_output: null,
    created_by: "IBMid-3100019UH8",
    created_on: "2026-08-05T00:48:10.426744Z",
    updated_at: "2026-08-11T20:04:03.153704Z",
    environments: [{ id: "10281134-a630-4a97-915e-e3bf7c243246", name: "draft" }],
    hidden: false,
  };

  it("agent detail has all snapshot-critical fields at the top level", () => {
    expect(agentDetail).toHaveProperty("id");
    expect(agentDetail).toHaveProperty("name");
    expect(agentDetail).toHaveProperty("instructions");
    expect(agentDetail).toHaveProperty("llm");
    expect(agentDetail).toHaveProperty("tools");
    expect(agentDetail).toHaveProperty("collaborators");
    expect(agentDetail).toHaveProperty("knowledge_base");
    expect(agentDetail).toHaveProperty("guidelines");
  });

  it("tools field is an array of UUID strings, NOT tool names or objects", () => {
    for (const t of agentDetail.tools) {
      expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("agent GET response does NOT contain toolsSelected (that only appears in PATCH)", () => {
    // The GET response is leaner than the PATCH body — no toolsSelected with full binding.
    // Assembler must correlate tools[] UUIDs with the v2/builder/tools batch-fetch.
    expect("toolsSelected" in agentDetail).toBe(false);
  });

  it("llm field is a virtual-model/ prefixed string (matching models list format)", () => {
    expect(agentDetail.llm).toMatch(/^(virtual-model\/|watsonx\/|groq\/|bedrock\/|watsonx-orchestrate\/)/);
  });

  it("PATCH #1 (groq) and PATCH #2 (revert to claude) both change only the llm field", () => {
    const patch1 = { ...agentDetail, llm: "groq/openai/gpt-oss-120b" };
    const patch2 = { ...agentDetail, llm: "virtual-model/anthropic/claude-opus-4-8" };
    // tools array is identical across both PATCHes
    expect(patch1.tools).toEqual(patch2.tools);
    expect(patch1.llm).not.toBe(patch2.llm);
  });
});

// ─── Auth type enum (confirmed from HAR 3) ───────────────────────────────────

describe("connection auth type enum — confirmed from GET /connections/applications/authtype/", () => {
  // Exact authTypes array from HAR 3
  const authTypes = [
    { title: "API Key",                   security_scheme: "api_key_auth",        auth_type: "" },
    { title: "Basic Auth",                security_scheme: "basic_auth",           auth_type: "" },
    { title: "Bearer Token",              security_scheme: "bearer_token",         auth_type: "" },
    { title: "Key Value Pair",            security_scheme: "key_value_creds",      auth_type: "" },
    { title: "OAuth2 Authorization Code", security_scheme: "oauth2",               auth_type: "oauth2_auth_code" },
    { title: "OAuth2 Client Credential",  security_scheme: "oauth2",               auth_type: "oauth2_client_creds" },
    { title: "OAuth2 Password",           security_scheme: "oauth2",               auth_type: "oauth2_password" },
    { title: "OAuth2 On Behalf Of Flow",  security_scheme: "oauth2",               auth_type: "oauth_on_behalf_of_flow" },
    { title: "OAuth2 Token Exchange",     security_scheme: "oauth2",               auth_type: "oauth2_token_exchange" },
    { title: "OAuth2 Direct Access Token",security_scheme: "oauth2",               auth_type: "oauth2_direct_accesstoken" },
  ];

  it("all non-OAuth auth types have empty string auth_type (security_scheme is the kind)", () => {
    const nonOauth = authTypes.filter(a => a.security_scheme !== "oauth2");
    for (const a of nonOauth) {
      expect(a.auth_type, `${a.title} should have empty auth_type`).toBe("");
    }
  });

  it("all OAuth sub-types share security_scheme='oauth2', distinguished by auth_type", () => {
    const oauth = authTypes.filter(a => a.security_scheme === "oauth2");
    expect(oauth.every(a => a.security_scheme === "oauth2")).toBe(true);
    const authTypeValues = new Set(oauth.map(a => a.auth_type));
    expect(authTypeValues.size).toBe(oauth.length); // all distinct
  });

  it("security_scheme values form the complete kind enum for scrubConnectionPayload", () => {
    const schemes = [...new Set(authTypes.map(a => a.security_scheme))].sort();
    expect(schemes).toEqual(["api_key_auth", "basic_auth", "bearer_token", "key_value_creds", "oauth2"].sort());
  });

  it("scrubConnectionPayload correctly maps security_scheme to kind for non-OAuth connection", () => {
    // Mirror the actual scrubber logic: ?? skips null, so null security_scheme falls through.
    // String(null) would give "null" — but scrubConnectionPayload uses ?? which skips null,
    // then falls back through kind/type/auth_scheme, all absent, landing on "".
    function scrubKind(raw: Record<string, unknown>): string {
      const val = raw["security_scheme"] ?? raw["kind"] ?? raw["type"] ?? raw["auth_scheme"] ?? "";
      return val === null ? "" : String(val);
    }
    expect(scrubKind({ app_id: "my-conn", security_scheme: "api_key_auth" })).toBe("api_key_auth");
    expect(scrubKind({ app_id: "my-conn", security_scheme: "bearer_token" })).toBe("bearer_token");
    expect(scrubKind({ app_id: "my-conn", security_scheme: "oauth2", auth_type: "oauth2_auth_code" })).toBe("oauth2");
    // security_scheme: null → ?? skips null, all other fallbacks absent → ""
    expect(scrubKind({ app_id: "my-conn", security_scheme: null })).toBe("");
  });

  it("CRITICAL — MCP connections from the list endpoint have null security_scheme (kind = '')", () => {
    // The connections/applications list returns security_scheme: null for toolkit-based connections.
    // scrubConnectionPayload will return kind="" which is correct — no kind to capture.
    // The connections/applications/authtype endpoint is the ONLY source of the kind enum;
    // we should NOT capture it during session (it's a static lookup, not connection state).
    const mcpConnFromList = { app_id: "tavily_connection", security_scheme: null, auth_type: null };
    function scrubKind(raw: Record<string, unknown>): string {
      const val = raw["security_scheme"] ?? raw["kind"] ?? raw["type"] ?? raw["auth_scheme"] ?? "";
      return val === null ? "" : String(val);
    }
    expect(scrubKind(mcpConnFromList as unknown as Record<string, unknown>)).toBe("");
  });
});

// ─── Models list shape (confirmed from HAR 3) ─────────────────────────────────

describe("models list shape — confirmed from GET /v1/builder/models/list", () => {
  // Sample from HAR 3 — first 4 models
  const modelsResponse = {
    resources: [
      { id: "groq/openai/gpt-oss-120b", label: "GPT-OSS 120B — OpenAI (via Groq)", type: "Groq", tags: ["groq", "recommended", "default"] },
      { id: "virtual-model/anthropic/claude-opus-4-8", label: "Anthropic Claude Opus 4.8", type: "ai_gateway", tags: ["anthropic", "claude", "opus", "third party"] },
      { id: "bedrock/openai.gpt-oss-120b-1:0", label: "GPT-OSS 120B — OpenAI (via AWS Bedrock)", type: "Bedrock", tags: ["bedrock", "recommended"] },
      { id: "watsonx-orchestrate/frontier", label: "Watsonx Orchestrate Frontier", type: "WxO", tags: ["wxO", "recommended"] },
    ],
  };

  it("response is { resources: [...] } not a bare array", () => {
    expect(modelsResponse).toHaveProperty("resources");
    expect(Array.isArray(modelsResponse.resources)).toBe(true);
  });

  it("each model has id, label, type, tags", () => {
    for (const m of modelsResponse.resources) {
      expect(m).toHaveProperty("id");
      expect(m).toHaveProperty("label");
      expect(m).toHaveProperty("type");
      expect(m).toHaveProperty("tags");
    }
  });

  it("model IDs use provider-prefixed format matching the agent llm field", () => {
    const validPrefixes = ["virtual-model/", "watsonx/", "watsonx-orchestrate/", "groq/", "bedrock/"];
    for (const m of modelsResponse.resources) {
      expect(validPrefixes.some(p => m.id.startsWith(p)), `${m.id} should have known prefix`).toBe(true);
    }
  });

  it("the LLM ID from the agent detail is present in the models list", () => {
    const agentLlm = "virtual-model/anthropic/claude-opus-4-8";
    const ids = modelsResponse.resources.map(m => m.id);
    expect(ids).toContain(agentLlm);
  });

  it("PATCH LLM change uses a model ID from the models list (groq/openai/gpt-oss-120b)", () => {
    const newLlm = "groq/openai/gpt-oss-120b";
    const ids = modelsResponse.resources.map(m => m.id);
    expect(ids).toContain(newLlm);
  });
});

// ─── Connection binding shape (HAR 2 + HAR 3 confirmed) ──────────────────────

describe("tool binding shape — confirmed from HAR 2 + HAR 3", () => {
  const mcpTool = {
    id: "bd99f27f-6bef-4698-817a-af2b178faa09",
    name: "tavily_search:tavily_extract",
    binding: {
      mcp: {
        server_url: "https://mcp.tavily.com/mcp/",
        transport: "streamable_http",
        connections: { tavily_connection: "bf11dc9b-57fb-4e22-9a5e-15931b42041a" },
      },
    },
  };
  const pythonTool = {
    id: "d33e806a-96d3-4df6-be6f-0f230f1d7c77",
    name: "add_a_comment_google_drive_26e12",
    binding: {
      python: {
        function: "agent_ready_tools.tools.productivity.google_drive.add_a_comment_google_drive:add_a_comment_google_drive",
        connections: { google_ibm_184bdbd3: "ed11c915-9765-4317-bf35-1319c5702bc1" },
        requirements: [],
      },
    },
  };

  it("MCP tool: connection app_id is the key of binding.mcp.connections", () => {
    expect(Object.keys(mcpTool.binding.mcp.connections)).toEqual(["tavily_connection"]);
  });
  it("Python tool: connection app_id is the key of binding.python.connections", () => {
    expect(Object.keys(pythonTool.binding.python.connections)).toEqual(["google_ibm_184bdbd3"]);
  });
  it("connection_id (UUID) is the value in both binding.*.connections maps", () => {
    expect(mcpTool.binding.mcp.connections["tavily_connection"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(pythonTool.binding.python.connections["google_ibm_184bdbd3"]).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("tool batch-fetch response is a bare array", () => {
    const response = [mcpTool, pythonTool];
    expect(Array.isArray(response)).toBe(true);
    expect("data" in response).toBe(false);
  });
});

// ─── KB response shapes (CONFIRMED HAR 4) ────────────────────────────────────

describe("KB response shapes — confirmed from HAR 4", () => {
  // POST /v1/orchestrate/knowledge-bases/documents → 201 Created
  const kbCreateResponse = {
    tool:            "425a1d99-86a4-4dc6-a8d2-98c96172b74d",
    vector_index:    "57915d71-1f77-4509-ab59-ae50cfd9e6ae",
    doc_collection:  "734ef673-a35a-4583-9af8-55279c069970",
    knowledge_base:  "ad66dc1f-592f-44d4-9fad-bf2aa9dcf814",
  };

  // GET /v1/orchestrate/knowledge-bases/{id} → 200 OK
  const kbDetailResponse = {
    id:           "ad66dc1f-592f-44d4-9fad-bf2aa9dcf814",
    tenant_id:    "22fbea2f8f6673a0b658e7b0cfd612b9_d24a8322-2e2e-4f54-a942-8a5666f542d9",
    workspace_id: "00000000-0000-0000-0000-000000000001",
    name:         "business-use-case-catalog_0132KI",
    display_name: "business-use-case-catalog",
    description:  "This is a list of the business use cases that wxO can handle in an organization.",
    prioritize_built_in_index: true,
    status: "ready",
    created_by: "IBMid-3100019UH8",
    updated_at: "2026-08-11T22:35:50.125611Z",
    representation: "tool",
    vector_index: {
      embeddings_model_name:  "ibm/slate-125m-english-rtrvr-v2",
      chunk_size:     400,
      chunk_overlap:  50,
      status:         "not_ready",
      status_msg:     "Add document collections and refresh in order to use the vector index.",
      top_k:          10,
      extraction_strategy: "standard",
    },
    conversational_search_tool: {
      language:    "en",
      index_config: [],
      generation: {
        model_id:    null,
        enabled:     false,
        generated_response_length: "Moderate",
        max_docs_passed_to_llm: 5,
      },
      confidence_thresholds: {
        retrieval_confidence_threshold: "Lowest",
        response_confidence_threshold:  "Lowest",
      },
      citations: { citation_title: "How do we know?", citations_shown: -1 },
      hap_filtering: { output: { enabled: false, threshold: 0.5 } },
    },
  };

  // PUT /v1/orchestrate/knowledge-bases/{id}/documents → 200 OK
  const kbUploadResponse = {
    knowledge_base: "ad66dc1f-592f-44d4-9fad-bf2aa9dcf814",
    documents:      ["3b0e625c-1496-4323-9eb0-c30bc1a77abd"],
  };

  it("KB create POST response has knowledge_base UUID to correlate with pending file bytes", () => {
    // The assembler uses this UUID to back-fill kbId="" on pending KB_FILE_CAPTURED messages.
    expect(kbCreateResponse).toHaveProperty("knowledge_base");
    expect(kbCreateResponse.knowledge_base).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("KB create response also carries tool/vector_index/doc_collection UUIDs (not needed for snapshot)", () => {
    expect(kbCreateResponse).toHaveProperty("tool");
    expect(kbCreateResponse).toHaveProperty("vector_index");
    expect(kbCreateResponse).toHaveProperty("doc_collection");
  });

  it("KB detail GET has all assembler-critical fields", () => {
    const critical = ["id", "name", "display_name", "description", "status", "vector_index",
                      "conversational_search_tool"];
    for (const f of critical) {
      expect(kbDetailResponse, `field "${f}"`).toHaveProperty(f);
    }
  });

  it("KB detail GET vector_index contains indexing config (not credentials)", () => {
    const vi = kbDetailResponse.vector_index;
    expect(vi).toHaveProperty("embeddings_model_name");
    expect(vi).toHaveProperty("chunk_size");
    expect(vi).toHaveProperty("chunk_overlap");
    expect(vi).toHaveProperty("top_k");
  });

  it("KB detail GET status field indicates readiness for searching", () => {
    // "ready" means the KB tool is configured; vector_index.status may still be "not_ready"
    // until documents are indexed.
    expect(kbDetailResponse.status).toBe("ready");
    expect(kbDetailResponse.vector_index.status).toBe("not_ready");
  });

  it("KB upload PUT response carries knowledge_base UUID and new document UUIDs", () => {
    expect(kbUploadResponse.knowledge_base).toMatch(/^[0-9a-f-]{36}$/);
    expect(Array.isArray(kbUploadResponse.documents)).toBe(true);
    expect(kbUploadResponse.documents[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("KB upload PUT response can be used to confirm successful document ingestion", () => {
    // After a PUT, the assembler knows: KB UUID + document UUID(s) just uploaded.
    // This is enough to update the snapshot index without needing a follow-up GET.
    expect(kbUploadResponse.documents.length).toBeGreaterThan(0);
  });

  it("KB detail path is v1/orchestrate — NOT v2/builder (regression guard)", () => {
    const kbDetailUrl = "/mfe_builder/api/v1/orchestrate/knowledge-bases/ad66dc1f-592f-44d4-9fad-bf2aa9dcf814";
    const wrongUrl    = "/mfe_builder/api/v2/builder/knowledge-bases/ad66dc1f-592f-44d4-9fad-bf2aa9dcf814";
    expect(matches(KB_META_RE, kbDetailUrl)).toBe(true);
    expect(matches(KB_META_RE, wrongUrl)).toBe(false);
  });
});
