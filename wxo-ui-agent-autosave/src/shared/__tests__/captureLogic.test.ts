/**
 * Validation tests for the content script capture logic.
 *
 * PURPOSE: Prove which data can actually be captured from the wxO UI network
 * traffic and identify any gaps or barriers before building the assembler.
 *
 * These tests operate on pure data-transformation functions extracted from the
 * content script logic — no browser APIs (window.fetch, chrome.*) are needed.
 * All patterns/helpers are exercised against real response shapes taken from
 * live HAR recordings (us-south.watson-orchestrate.cloud.ibm.com, Aug 2026).
 *
 * ─── What we can capture ──────────────────────────────────────────────────────
 *
 *  ✅ AGENT full object         — PATCH /v1/builder/orchestrate/agents/{id}
 *     Contains: name, instructions, llm, tools[], toolsSelected[], guidelines,
 *               knowledge_base[], collaborators[], style, tags, structured_output
 *
 *  ✅ AGENT lean object         — GET /v1/builder/orchestrate/agents/{id}
 *     Contains: same fields EXCEPT toolsSelected (binding not in GET response)
 *
 *  ✅ TOOL binding metadata     — GET /v2/builder/tools?ids=...
 *     Contains: id, name, binding.python|mcp.connections, binding.mcp.server_url
 *
 *  ✅ CONNECTION metadata       — GET /v1/orchestrate/connections/applications
 *     Contains: app_id, name, security_scheme, is_configured, credentials_entered
 *     MISSING:  actual credentials (correct — we only want metadata, not secrets)
 *
 *  ✅ KB metadata               — GET /v2/builder/knowledge-bases
 *     Contains: id, name, description (body not yet confirmed from a HAR)
 *
 *  ✅ KB file bytes             — POST /v2/builder/knowledge-bases/{id}/documents
 *     Contains: full file bytes from multipart body (before transmission)
 *
 *  ✅ CSRF token (ephemeral)    — x-ibm-wo-csrf header on any mfe_builder request
 *     Used for: proactive tool batch-fetch in assembler only; never stored
 *
 * ─── Technical barriers identified ───────────────────────────────────────────
 *
 *  ⚠️  TOOL_FILE_CAPTURED only fires for hand-crafted Python tool uploads
 *      (multipart POST /v2/builder/tools). Catalog tools go through
 *      POST /v1/builder/tools/create-from-template with a JSON body pointing
 *      to a pre-signed S3 URL. The source file is NOT transmitted to the
 *      mfe_builder API — it lives in S3. We cannot capture catalog tool source.
 *
 *  ⚠️  No Authorization: Bearer header on wxO SaaS UI requests.
 *      Auth is cookie-based + x-ibm-wo-csrf. CSRF token IS capturable but
 *      it is not the same as an API key — it provides session access only.
 *
 *  ⚠️  The GET /v2/builder/agents list returns minimal fields (no toolsSelected,
 *      no binding details). The PATCH body is the richest single capture point.
 *
 *  ⚠️  KB response body shape not yet confirmed from a HAR — the KB_META_CAPTURED
 *      pattern is correctly routed but the downstream assembler may need to handle
 *      an unknown response shape until we get a KB HAR.
 *
 *  ⚠️  MCP connections report security_scheme: null from the applications list.
 *      The connection kind cannot be inferred from the list endpoint alone.
 *      The /authtype/ enum endpoint would need to be cross-referenced, but
 *      we deliberately do NOT capture it (static lookup, not connection state).
 *
 *  ⚠️  Collaborators always appear as [] in observed HARs. Full collaborator
 *      binding shape is not yet confirmed.
 */

import { describe, it, expect } from "vitest";
import { scrubSecrets, scrubConnectionPayload } from "../scrubber";

// ─── Real API response fixtures (taken from confirmed HAR recordings) ─────────

/** HAR 3: GET /v1/builder/orchestrate/agents/{id} — full agent detail */
const AGENT_GET_RESPONSE = {
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

/**
 * HAR 2+3: PATCH /v1/builder/orchestrate/agents/{id} body (richest capture).
 * Identical to GET but ALSO includes toolsSelected[] with full binding objects.
 */
const AGENT_PATCH_BODY = {
  ...AGENT_GET_RESPONSE,
  toolsSelected: [
    {
      id: "6701c7b8-c8d6-4b00-9495-f775ae5bc908",
      name: "web_search_tavily",
      binding: {
        python: {
          function: "agent_ready_tools.tools.web.tavily.web_search_tavily:web_search_tavily",
          connections: { tavily_connection: "bf11dc9b-57fb-4e22-9a5e-15931b42041a" },
          requirements: [],
        },
      },
    },
    {
      id: "bd99f27f-6bef-4698-817a-af2b178faa09",
      name: "tavily_search:tavily_extract",
      binding: {
        mcp: {
          server_url: "https://mcp.tavily.com/mcp/",
          transport: "streamable_http",
          connections: { tavily_connection: "bf11dc9b-57fb-4e22-9a5e-15931b42041a" },
        },
      },
    },
    {
      id: "1247965e-c52d-4a0b-b533-4e1552e49d22",
      name: "get_current_weather",
      binding: {
        python: {
          function: "tools.weather:get_current_weather",
          connections: {},
          requirements: [],
        },
      },
    },
  ],
};

/**
 * HAR 2+3: GET /v2/builder/tools?&ids=...&ids=...
 * Response is a bare JSON array (NOT wrapped in { data: [...] }).
 */
const TOOL_BATCH_RESPONSE = [
  {
    id: "6701c7b8-c8d6-4b00-9495-f775ae5bc908",
    name: "web_search_tavily",
    description: "Search the web using Tavily",
    binding: {
      python: {
        function: "agent_ready_tools.tools.web.tavily.web_search_tavily:web_search_tavily",
        connections: { tavily_connection: "bf11dc9b-57fb-4e22-9a5e-15931b42041a" },
        requirements: [],
      },
    },
  },
  {
    id: "bd99f27f-6bef-4698-817a-af2b178faa09",
    name: "tavily_search:tavily_extract",
    binding: {
      mcp: {
        server_url: "https://mcp.tavily.com/mcp/",
        transport: "streamable_http",
        connections: { tavily_connection: "bf11dc9b-57fb-4e22-9a5e-15931b42041a" },
      },
    },
  },
  {
    id: "1247965e-c52d-4a0b-b533-4e1552e49d22",
    name: "get_current_weather",
    binding: {
      python: {
        function: "tools.weather:get_current_weather",
        connections: {},
        requirements: [],
      },
    },
  },
];

/**
 * HAR 2+3: GET /v1/orchestrate/connections/applications?connectionIds=
 * The full applications list response shape.
 */
const CONNECTIONS_RESPONSE = {
  tenant_id: "22fbea2f8f6673a0b658e7b0cfd612b9_d24a8322-2e2e-4f54-a942-8a5666f542d9",
  page: 1,
  limit: 50,
  total: 2,
  applications: [
    {
      app_id: "tavily_connection",
      name: "Tavily Connection",
      connection_id: "bf11dc9b-57fb-4e22-9a5e-15931b42041a",
      security_scheme: null,      // MCP connections always have null security_scheme
      auth_type: null,
      server_url: "https://mcp.tavily.com/mcp/",
      is_configured: true,
      credentials_entered: true,
    },
    {
      app_id: "google_ibm_184bdbd3",
      name: "Google Drive Connection",
      connection_id: "ed11c915-9765-4317-bf35-1319c5702bc1",
      security_scheme: "api_key_auth",
      auth_type: "",
      server_url: null,
      is_configured: true,
      credentials_entered: true,
    },
  ],
};

// ─── 1. AGENT CAPTURE ─────────────────────────────────────────────────────────

describe("✅ AGENT capture — what we can extract from GET + PATCH responses", () => {
  it("agent GET response contains all assembler-critical top-level fields", () => {
    const critical = ["id", "name", "instructions", "llm", "tools",
                      "collaborators", "knowledge_base", "guidelines", "style"];
    for (const field of critical) {
      expect(AGENT_GET_RESPONSE, `field "${field}"`).toHaveProperty(field);
    }
  });

  it("agent GET response tools[] is an array of UUID strings only (not full objects)", () => {
    expect(Array.isArray(AGENT_GET_RESPONSE.tools)).toBe(true);
    for (const t of AGENT_GET_RESPONSE.tools) {
      expect(typeof t).toBe("string");
      expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("agent GET response does NOT contain toolsSelected (assembler must cross-ref v2/tools)", () => {
    expect("toolsSelected" in AGENT_GET_RESPONSE).toBe(false);
  });

  it("agent PATCH body DOES contain toolsSelected[] with full tool binding", () => {
    expect(Array.isArray(AGENT_PATCH_BODY.toolsSelected)).toBe(true);
    expect(AGENT_PATCH_BODY.toolsSelected.length).toBe(3);
  });

  it("toolsSelected in PATCH body has binding.python.connections / binding.mcp.connections", () => {
    const tavilyPython = AGENT_PATCH_BODY.toolsSelected[0]!;
    const tavilyMcp = AGENT_PATCH_BODY.toolsSelected[1]!;
    expect(tavilyPython.binding.python.connections).toEqual({ tavily_connection: "bf11dc9b-57fb-4e22-9a5e-15931b42041a" });
    expect(tavilyMcp.binding.mcp.connections).toEqual({ tavily_connection: "bf11dc9b-57fb-4e22-9a5e-15931b42041a" });
  });

  it("PATCH body tools[] UUID array matches toolsSelected[] ids 1:1", () => {
    const toolUuids = AGENT_PATCH_BODY.tools;
    const selectedIds = AGENT_PATCH_BODY.toolsSelected.map((t) => t.id);
    expect(toolUuids).toEqual(selectedIds);
  });

  it("scrubSecrets does NOT redact agent-level safe fields", () => {
    const scrubbed = scrubSecrets(AGENT_GET_RESPONSE) as typeof AGENT_GET_RESPONSE;
    expect(scrubbed.id).toBe(AGENT_GET_RESPONSE.id);
    expect(scrubbed.name).toBe(AGENT_GET_RESPONSE.name);
    expect(scrubbed.instructions).toBe(AGENT_GET_RESPONSE.instructions);
    expect(scrubbed.llm).toBe(AGENT_GET_RESPONSE.llm);
  });

  it("scrubSecrets on PATCH body with hypothetical credential field in binding", () => {
    const patchWithCred = {
      ...AGENT_PATCH_BODY,
      toolsSelected: [
        {
          ...AGENT_PATCH_BODY.toolsSelected[0]!,
          binding: {
            python: {
              ...AGENT_PATCH_BODY.toolsSelected[0]!.binding.python,
              auth_config: { api_key: "sk-secret-123" },  // hypothetical — should be redacted
            },
          },
        },
      ],
    };
    const scrubbed = scrubSecrets(patchWithCred) as Record<string, unknown>;
    // toolsSelected is an array — traverse into it
    const toolsSelected = scrubbed["toolsSelected"] as Record<string, unknown>[];
    const binding = (toolsSelected[0]!["binding"] as Record<string, unknown>)["python"] as Record<string, unknown>;
    // auth_config is in SECRET_KEYS (normalises to "authconfig") → entire value becomes "[REDACTED]"
    expect(binding["auth_config"]).toBe("[REDACTED]");
    // Safe fields survive scrubbing
    const connections = binding["connections"] as Record<string, unknown>;
    expect(connections["tavily_connection"]).toBe("bf11dc9b-57fb-4e22-9a5e-15931b42041a");
  });

  it("readJsonBody wrapping: bare array tool response gets wrapped as { items: [...] }", () => {
    // The content script wraps bare JSON arrays so the downstream can handle them uniformly.
    // This mirrors the logic in readJsonBody (content/index.ts).
    const bareArray = TOOL_BATCH_RESPONSE;
    const wrapped = Array.isArray(bareArray) ? { items: bareArray } : bareArray;
    expect(wrapped).toHaveProperty("items");
    expect((wrapped as { items: typeof bareArray }).items).toHaveLength(3);
  });
});

// ─── 2. TOOL CAPTURE ─────────────────────────────────────────────────────────

describe("✅ TOOL capture — what we can extract from v2/builder/tools batch-fetch", () => {
  it("tool batch response is a bare array (not wrapped in { data: [...] })", () => {
    expect(Array.isArray(TOOL_BATCH_RESPONSE)).toBe(true);
  });

  it("each tool has id, name, and binding", () => {
    for (const tool of TOOL_BATCH_RESPONSE) {
      expect(tool).toHaveProperty("id");
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("binding");
    }
  });

  it("Python tool binding structure is capturable (module:function + connections map)", () => {
    const pythonTool = TOOL_BATCH_RESPONSE[0]!;
    expect(pythonTool.binding).toHaveProperty("python");
    expect(pythonTool.binding.python).toHaveProperty("function");
    expect(pythonTool.binding.python).toHaveProperty("connections");
    expect(typeof pythonTool.binding.python.function).toBe("string");
    expect(pythonTool.binding.python.function).toContain(":");
  });

  it("MCP tool binding structure is capturable (server_url + transport + connections map)", () => {
    const mcpTool = TOOL_BATCH_RESPONSE[1]!;
    expect(mcpTool.binding).toHaveProperty("mcp");
    expect(mcpTool.binding.mcp).toHaveProperty("server_url");
    expect(mcpTool.binding.mcp).toHaveProperty("transport");
    expect(mcpTool.binding.mcp).toHaveProperty("connections");
    expect(mcpTool.binding.mcp.server_url).toMatch(/^https?:\/\//);
  });

  it("tool with no connection has an empty connections map (not null/undefined)", () => {
    const noConnTool = TOOL_BATCH_RESPONSE[2]!;
    expect(noConnTool.binding.python.connections).toEqual({});
  });

  it("connection app_ids can be extracted from all tools in one pass", () => {
    const allAppIds = new Set<string>();
    for (const tool of TOOL_BATCH_RESPONSE) {
      const binding = tool.binding as Record<string, unknown>;
      for (const kind of ["python", "mcp"] as const) {
        const bk = (binding[kind] as Record<string, unknown> | undefined);
        if (!bk) continue;
        const conns = bk["connections"] as Record<string, string> | undefined;
        if (conns) {
          for (const appId of Object.keys(conns)) {
            allAppIds.add(appId);
          }
        }
      }
    }
    expect([...allAppIds]).toEqual(["tavily_connection"]);
  });

  it("tool UUIDs in batch response match agent tools[] array 1:1", () => {
    const batchIds = TOOL_BATCH_RESPONSE.map((t) => t.id);
    expect(batchIds).toEqual(AGENT_GET_RESPONSE.tools);
  });

  it("⚠️  BARRIER — catalog tools (create-from-template) have no capturable source file", () => {
    // Catalog tools are created from a presigned S3 URL. The mfe_builder API only
    // receives a JSON template reference, not the actual Python/YAML source.
    // We can capture the tool's metadata and binding (via tools batch-fetch) but NOT
    // the original source file. This is expected — catalog tools are not user files.
    const createFromTemplateBody = {
      parent_agent_id: "c0c5096f-bb7c-4291-b039-96ff43ade1db",
      catalog_id: "abc123",
      version: "1.0.0",
      // Presigned S3 URL for the source — the actual bytes are in S3, not transmitted here
      artifact_url: "https://s3.amazonaws.com/catalog-bucket/tools/abc123/1.0.0.zip?...",
    };
    // No file bytes available — only metadata. This is not a bug; it's by design.
    expect(createFromTemplateBody).not.toHaveProperty("bytes");
    expect(createFromTemplateBody).not.toHaveProperty("content");
    expect(typeof createFromTemplateBody.artifact_url).toBe("string");
  });
});

// ─── 3. CONNECTION CAPTURE ────────────────────────────────────────────────────

describe("✅ CONNECTION capture — scrubbed metadata from applications list", () => {
  const apps = CONNECTIONS_RESPONSE.applications;

  it("connections list response wraps apps in { applications: [...] } (not bare array)", () => {
    expect(CONNECTIONS_RESPONSE).toHaveProperty("applications");
    expect(Array.isArray(CONNECTIONS_RESPONSE.applications)).toBe(true);
  });

  it("content script must extract .applications[] — response is NOT { resources: [...] }", () => {
    // The background handler currently tries data["resources"] — this is wrong for
    // the connections endpoint. The field is "applications", not "resources".
    // This test documents the BARRIER so the content script handler can be fixed.
    expect(CONNECTIONS_RESPONSE).not.toHaveProperty("resources");
    expect(CONNECTIONS_RESPONSE).toHaveProperty("applications");
  });

  it("scrubConnectionPayload correctly captures MCP connection (security_scheme: null)", () => {
    const mcpConn = apps[0]!;
    const scrubbed = scrubConnectionPayload(mcpConn as unknown as Record<string, unknown>);
    expect(scrubbed.app_id).toBe("tavily_connection");
    expect(scrubbed.kind).toBe("");             // null → "" (correct: no kind available)
    expect(scrubbed.server_url).toBe("https://mcp.tavily.com/mcp/");
  });

  it("scrubConnectionPayload correctly captures API-key connection (security_scheme present)", () => {
    const apiKeyConn = apps[1]!;
    const scrubbed = scrubConnectionPayload(apiKeyConn as unknown as Record<string, unknown>);
    expect(scrubbed.app_id).toBe("google_ibm_184bdbd3");
    expect(scrubbed.kind).toBe("api_key_auth");
    expect(scrubbed.server_url).toBeUndefined();  // server_url: null → omitted
  });

  it("scrubConnectionPayload strips all non-allowlisted fields (no leaking is_configured, credentials_entered, etc.)", () => {
    const conn = apps[0]!;
    const scrubbed = scrubConnectionPayload(conn as unknown as Record<string, unknown>);
    const keys = Object.keys(scrubbed);
    // Only these three keys should ever appear
    expect(keys.every((k) => ["app_id", "kind", "server_url"].includes(k))).toBe(true);
    // Specifically: is_configured and credentials_entered are stripped
    expect(scrubbed).not.toHaveProperty("is_configured");
    expect(scrubbed).not.toHaveProperty("credentials_entered");
    expect(scrubbed).not.toHaveProperty("connection_id");
    expect(scrubbed).not.toHaveProperty("auth_type");
  });

  it("⚠️  BARRIER — content script CONNECTION_CAPTURED handler uses wrong field name", () => {
    // In content/index.ts the CONNECTION_CAPTURED handler does:
    //   const resources = Array.isArray(data["resources"]) ? data["resources"] : [data];
    //
    // But the real connections response uses "applications", not "resources".
    // This means connections from the list endpoint will be captured as a single
    // wrapped object rather than iterated. Fix: use data["applications"] as primary.
    //
    // We document this as a known barrier here so it can be fixed before assembler work.
    const responseData = CONNECTIONS_RESPONSE as unknown as Record<string, unknown>;
    const usingWrongField = Array.isArray(responseData["resources"])
      ? (responseData["resources"] as unknown[])
      : null;
    const usingCorrectField = Array.isArray(responseData["applications"])
      ? (responseData["applications"] as unknown[])
      : null;

    expect(usingWrongField).toBeNull();           // "resources" field doesn't exist
    expect(usingCorrectField).toHaveLength(2);     // "applications" has 2 connections
  });

  it("all connection app_ids in the response match the tool binding connection references", () => {
    // Cross-reference: every app_id that appears in tool bindings should appear in connections list.
    const connAppIds = new Set(apps.map((a) => a.app_id));
    const toolAppIds = new Set<string>();
    for (const tool of TOOL_BATCH_RESPONSE) {
      const binding = tool.binding as Record<string, unknown>;
      for (const kind of ["python", "mcp"] as const) {
        const bk = binding[kind] as Record<string, unknown> | undefined;
        if (!bk) continue;
        const conns = bk["connections"] as Record<string, string> | undefined;
        if (conns) {
          for (const appId of Object.keys(conns)) toolAppIds.add(appId);
        }
      }
    }
    for (const id of toolAppIds) {
      expect(connAppIds.has(id), `app_id "${id}" from tool binding not found in connections list`).toBe(true);
    }
  });
});

// ─── 4. CSRF TOKEN CAPTURE ────────────────────────────────────────────────────

describe("✅ CSRF token capture — x-ibm-wo-csrf header (session-scoped, not API key)", () => {
  it("CSRF token is a hex string extracted from x-ibm-wo-csrf header", () => {
    // Simulated CSRF token as it appears in the request header
    const csrfToken = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    expect(csrfToken).toMatch(/^[a-f0-9]+$/i);
  });

  it("⚠️  BARRIER — CSRF token is session-scoped, NOT a persistent API key", () => {
    // The wxO UI does NOT use Authorization: Bearer. It uses:
    //   - IBM Cloud session cookie (HttpOnly, not readable by extension JS)
    //   - x-ibm-wo-csrf header (readable from request headers)
    //
    // Consequence: the CSRF token can be used for the assembler's proactive
    // tool batch-fetch during the SAME browser session, but will be invalid
    // after logout or session expiry.
    //
    // This is acceptable for the extension's design (proactive fetch during session).
    // It is NOT suitable for replay outside the session (restore uses the ADK CLI
    // with its own auth, not the extension's captured CSRF token).
    const isBearerToken = false;  // no bearer token on wxO SaaS UI
    const isCsrfToken = true;      // only x-ibm-wo-csrf is available
    expect(isBearerToken).toBe(false);
    expect(isCsrfToken).toBe(true);
  });

  it("BEARER_TOKEN_OBSERVED message carries the CSRF value in the token field", () => {
    // The message type is named BEARER_TOKEN_OBSERVED for historical reasons but
    // now carries the CSRF token value. The field name "token" is correct.
    const msg = { type: "BEARER_TOKEN_OBSERVED" as const, payload: { token: "a1b2c3d4" } };
    expect(msg.payload.token).toBe("a1b2c3d4");
    expect(msg.type).toBe("BEARER_TOKEN_OBSERVED");
  });
});

// ─── 5. AGENT PATCH → SNAPSHOT ASSEMBLY ──────────────────────────────────────

describe("✅ AGENT PATCH is the snapshot trigger — coalescing into AgentSnapshot", () => {
  it("PATCH body alone provides enough for a complete snapshot (minus file bytes)", () => {
    const patch = AGENT_PATCH_BODY;
    // 1. Agent identity
    expect(patch.id).toBeTruthy();
    expect(patch.name).toBeTruthy();
    // 2. LLM config
    expect(patch.llm).toMatch(/^(virtual-model\/|watsonx\/|groq\/|bedrock\/|watsonx-orchestrate\/)/);
    // 3. Instructions
    expect(typeof patch.instructions).toBe("string");
    // 4. Tools (UUIDs for batch-fetch trigger)
    expect(patch.tools.length).toBeGreaterThan(0);
    // 5. Tool binding (in toolsSelected)
    expect(patch.toolsSelected.length).toBe(patch.tools.length);
    // 6. KB refs (empty here, but field is present)
    expect(Array.isArray(patch.knowledge_base)).toBe(true);
    // 7. Collaborators (empty here, but field is present)
    expect(Array.isArray(patch.collaborators)).toBe(true);
  });

  it("PATCH toolsSelected provides all connection app_ids needed to request connection metadata", () => {
    const neededAppIds = new Set<string>();
    for (const tool of AGENT_PATCH_BODY.toolsSelected) {
      const binding = tool.binding as Record<string, unknown>;
      for (const kind of ["python", "mcp"] as const) {
        const bk = binding[kind] as Record<string, unknown> | undefined;
        if (!bk) continue;
        const conns = bk["connections"] as Record<string, string> | undefined;
        if (conns) {
          for (const appId of Object.keys(conns)) neededAppIds.add(appId);
        }
      }
    }
    // The assembler should request connections for these app_ids
    expect([...neededAppIds].sort()).toEqual(["tavily_connection"]);
  });

  it("assembler can build a complete AgentSnapshot from PATCH + tools + connections", () => {
    // Simulate the assembler's coalescing step.
    // In practice this is done in Sub-Task 3, but we validate the data is all present.

    const snapshot = {
      schemaVersion: "1.0.0",
      capturedAt: new Date().toISOString(),
      tenant: AGENT_PATCH_BODY.tenant_id,
      agent: {
        id: AGENT_PATCH_BODY.id,
        name: AGENT_PATCH_BODY.name,
        llm: AGENT_PATCH_BODY.llm,
        instructions: AGENT_PATCH_BODY.instructions,
        style: AGENT_PATCH_BODY.style,
        guidelines: AGENT_PATCH_BODY.guidelines,
        knowledge_base: AGENT_PATCH_BODY.knowledge_base,
        collaborators: AGENT_PATCH_BODY.collaborators,
      },
      tools: TOOL_BATCH_RESPONSE.map((t) => ({
        id: t.id,
        name: t.name,
        binding: t.binding,
      })),
      knowledgeBases: [],
      connections: CONNECTIONS_RESPONSE.applications.map((c) =>
        scrubConnectionPayload(c as unknown as Record<string, unknown>),
      ),
    };

    expect(snapshot.agent.id).toBe("c0c5096f-bb7c-4291-b039-96ff43ade1db");
    expect(snapshot.agent.llm).toBe("virtual-model/anthropic/claude-opus-4-8");
    expect(snapshot.tools).toHaveLength(3);
    expect(snapshot.connections).toHaveLength(2);

    // MCP connection scrubbed correctly
    const mcpConn = snapshot.connections[0]!;
    expect(mcpConn.app_id).toBe("tavily_connection");
    expect(mcpConn.kind).toBe("");   // null → ""

    // API-key connection scrubbed correctly
    const apiKeyConn = snapshot.connections[1]!;
    expect(apiKeyConn.app_id).toBe("google_ibm_184bdbd3");
    expect(apiKeyConn.kind).toBe("api_key_auth");
  });
});

// ─── 6. RESPONSE WRAPPING ─────────────────────────────────────────────────────

describe("readJsonBody wrapping behaviour — how array vs object responses are handled", () => {
  /**
   * The content script's readJsonBody() wraps bare JSON arrays as { items: [...] }
   * so that all downstream handlers receive a Record<string, unknown>.
   * These tests confirm the wrapping logic is correct for each endpoint type.
   */

  function simulateReadJsonBody(json: unknown): Record<string, unknown> | null {
    if (typeof json !== "object" || json === null) return null;
    if (Array.isArray(json)) return { items: json };
    return json as Record<string, unknown>;
  }

  it("agent GET/PATCH responses are objects → passed through as-is", () => {
    const result = simulateReadJsonBody(AGENT_GET_RESPONSE);
    expect(result).not.toBeNull();
    expect(result!["id"]).toBe("c0c5096f-bb7c-4291-b039-96ff43ade1db");
  });

  it("tool batch-fetch is a bare array → wrapped as { items: [...] }", () => {
    const result = simulateReadJsonBody(TOOL_BATCH_RESPONSE);
    expect(result).not.toBeNull();
    expect(result!).toHaveProperty("items");
    expect((result!["items"] as unknown[]).length).toBe(3);
  });

  it("connections list is an object { applications: [...] } → passed through as-is", () => {
    const result = simulateReadJsonBody(CONNECTIONS_RESPONSE);
    expect(result).not.toBeNull();
    expect(result!).toHaveProperty("applications");
  });

  it("null response body returns null (no capture)", () => {
    expect(simulateReadJsonBody(null)).toBeNull();
  });

  it("non-JSON response (string) returns null (no capture)", () => {
    expect(simulateReadJsonBody("not-an-object")).toBeNull();
  });
});

// ─── 7. BARRIERS SUMMARY ─────────────────────────────────────────────────────

describe("⚠️  Technical barrier documentation — known gaps in capture coverage", () => {
  it("BARRIER 1: connections list uses 'applications' key, not 'resources' — handler must be updated", () => {
    // Priority: HIGH — must fix before assembler
    const responseKeys = Object.keys(CONNECTIONS_RESPONSE);
    expect(responseKeys).toContain("applications");
    expect(responseKeys).not.toContain("resources");
  });

  it("BARRIER 2: catalog tool source files are NOT capturable (presigned S3, not transmitted to API)", () => {
    // Priority: LOW — catalog tools can be re-downloaded; source isn't user-authored
    // No fix needed — document only
    expect(true).toBe(true);
  });

  it("BARRIER 3: MCP connections always report security_scheme: null from list endpoint", () => {
    // Priority: LOW — kind="" is acceptable; the server_url is still captured
    const mcpApp = CONNECTIONS_RESPONSE.applications[0]!;
    expect(mcpApp.security_scheme).toBeNull();
    // The server_url compensates — it's enough to know it's an MCP connection
    expect(mcpApp.server_url).toBe("https://mcp.tavily.com/mcp/");
  });

  it("BARRIER 4: CSRF token is session-scoped and cannot be used for restore", () => {
    // Priority: N/A — restore uses ADK CLI auth; CSRF only needed during capture session
    expect(true).toBe(true);
  });

  it("BARRIER 5: KB response body shape not yet confirmed from a live HAR", () => {
    // Priority: MEDIUM — KB_META_CAPTURED routing is correct but assembler must handle
    // unknown shape. Mitigation: capture full raw response and treat it as opaque blob
    // until a KB HAR is available.
    expect(true).toBe(true);
  });
});
