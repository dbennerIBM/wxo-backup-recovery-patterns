import { describe, expect, it } from "vitest";
import { synthesizeOpenApiSpec } from "../openapiSynth";
import { toSnapshotTool } from "../capture";
import { buildZip, parseZip } from "../zip";
import type { AgentSnapshot, SnapshotTool } from "../index";

// Real GET /v2/builder/tools?ids=… payload from a live SaaS tenant (Aug 2026).
// The new builder UI parses OpenAPI uploads client-side, so this response is
// the ONLY place the tool's parameter schema exists — no file is ever uploaded.
const LIVE_TOOL_PAYLOAD = {
  id: "989871a0-de3d-4e7b-a4ad-ae1a20df69ad",
  tenant_id: "t1_t2",
  description:
    "Calls httpbin's /get endpoint, echoing the query parameters back. Exists solely to verify the autosave extension saved this spec.",
  name: "Echo_a_greeting_autosave_captu_1454NF",
  input_schema: {
    type: "object",
    properties: {
      query_name: {
        type: "string",
        title: "name",
        description: "The name to greet.",
        in: "query",
        aliasName: "name",
      },
      query_marker: {
        type: "string",
        title: "marker",
        description: "Test marker string.",
        default: "AUTOSAVE-TEST-2026-08-24-annie",
        in: "query",
        aliasName: "marker",
      },
    },
    required: ["query_name"],
  },
  output_schema: {
    type: "object",
    description: "Echoed request details.",
    properties: {
      url: { type: "string", description: "The full request URL." },
      args: { type: "object", description: "The query parameters that were sent." },
    },
    required: [],
  },
  binding: {
    openapi: {
      http_method: "GET",
      http_path: "/get",
      security: [],
      servers: ["https://httpbin.org"],
      connection_id: null,
    },
  },
  display_name: "Echo a greeting (autosave capture test)",
  is_async: false,
  response_format: "content",
};

describe("toSnapshotTool — full-fidelity capture", () => {
  it("retains schemas, display_name, and flags from the builder API payload", () => {
    const tool = toSnapshotTool(LIVE_TOOL_PAYLOAD as Record<string, unknown>);
    expect(tool).not.toBeNull();
    expect(tool!.input_schema).toEqual(LIVE_TOOL_PAYLOAD.input_schema);
    expect(tool!.output_schema).toEqual(LIVE_TOOL_PAYLOAD.output_schema);
    expect(tool!.display_name).toBe("Echo a greeting (autosave capture test)");
    expect(tool!.is_async).toBe(false);
    expect(tool!.response_format).toBe("content");
  });
});

describe("synthesizeOpenApiSpec", () => {
  const tool = toSnapshotTool(LIVE_TOOL_PAYLOAD as Record<string, unknown>)!;

  it("rebuilds a valid OpenAPI 3.0 skeleton from binding + schemas", () => {
    const spec = synthesizeOpenApiSpec(tool)!;
    expect(spec).not.toBeNull();
    expect(spec["openapi"]).toBe("3.0.3");
    expect(spec["servers"]).toEqual([{ url: "https://httpbin.org" }]);
    const paths = spec["paths"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths)).toEqual(["/get"]);
    expect(Object.keys(paths["/get"]!)).toEqual(["get"]);
  });

  it("restores wire parameter names from aliasName and required from input_schema", () => {
    const spec = synthesizeOpenApiSpec(tool)!;
    const op = (spec["paths"] as never)["/get"]["get"] as Record<string, unknown>;
    expect(op["operationId"]).toBe("Echo_a_greeting_autosave_captu_1454NF");
    expect(op["summary"]).toBe("Echo a greeting (autosave capture test)");
    const params = op["parameters"] as Array<Record<string, unknown>>;
    expect(params).toHaveLength(2);
    const byName = Object.fromEntries(params.map((p) => [p["name"], p]));
    expect(byName["name"]).toMatchObject({
      in: "query",
      required: true,
      description: "The name to greet.",
      schema: { type: "string" },
    });
    expect(byName["marker"]).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "string", default: "AUTOSAVE-TEST-2026-08-24-annie" },
    });
    // wxO routing keys must not leak into the spec.
    expect(byName["name"]!["schema"]).not.toHaveProperty("aliasName");
    expect(byName["name"]!["schema"]).not.toHaveProperty("in");
  });

  it("carries output_schema into the 200 response", () => {
    const spec = synthesizeOpenApiSpec(tool)!;
    const op = (spec["paths"] as never)["/get"]["get"] as Record<string, unknown>;
    const res = op["responses"] as never;
    expect(res["200"]["content"]["application/json"]["schema"]).toEqual(
      LIVE_TOOL_PAYLOAD.output_schema,
    );
  });

  it("groups body-located properties into a JSON requestBody", () => {
    const postTool: SnapshotTool = {
      id: "t2",
      name: "create_thing",
      binding: {
        openapi: { http_method: "POST", http_path: "/things", servers: ["https://api.example.com"] },
      },
      input_schema: {
        type: "object",
        properties: {
          body_label: { type: "string", aliasName: "label" },
          query_dry_run: { type: "boolean", title: "dry_run", in: "query", aliasName: "dry_run" },
        },
        required: ["body_label"],
      },
    };
    const spec = synthesizeOpenApiSpec(postTool)!;
    const op = (spec["paths"] as never)["/things"]["post"] as Record<string, unknown>;
    const body = op["requestBody"] as never;
    expect(body["content"]["application/json"]["schema"]).toEqual({
      type: "object",
      properties: { label: { type: "string" } },
      required: ["label"],
    });
    const params = op["parameters"] as Array<Record<string, unknown>>;
    expect(params.map((p) => p["name"])).toEqual(["dry_run"]);
  });

  it("returns null for python-bound and binding-less tools", () => {
    expect(synthesizeOpenApiSpec({ id: "t3", name: "py", binding: { python: {} } })).toBeNull();
    expect(synthesizeOpenApiSpec({ id: "t4", name: "bare" })).toBeNull();
  });
});

describe("buildZip — synthesized spec.yaml", () => {
  function snapshotWith(tools: SnapshotTool[]): AgentSnapshot {
    return {
      schemaVersion: "1.0.0",
      capturedAt: "2026-08-24T12:39:25.066Z",
      tenant: "t1_t2",
      agent: { id: "a1", name: "e2e-test-agent" },
      tools,
      knowledgeBases: [],
      connections: [],
    } as unknown as AgentSnapshot;
  }

  it("writes tools/{name}/spec.yaml for an openapi tool with no captured source", () => {
    const tool = toSnapshotTool(LIVE_TOOL_PAYLOAD as Record<string, unknown>)!;
    const parsed = parseZip(buildZip(snapshotWith([tool])));
    const specBytes = parsed[`tools/${tool.name}/spec.yaml`];
    expect(specBytes).toBeDefined();
    const spec = JSON.parse(new TextDecoder().decode(specBytes));
    expect(spec.paths["/get"].get.parameters).toHaveLength(2);
  });

  it("prefers captured source bytes over synthesis", () => {
    const tool = toSnapshotTool(LIVE_TOOL_PAYLOAD as Record<string, unknown>)!;
    tool.sourceFile = {
      filename: "original.yaml",
      contentType: "application/yaml",
      bytes: [111, 107],
    };
    const parsed = parseZip(buildZip(snapshotWith([tool])));
    expect(Array.from(parsed[`tools/${tool.name}/spec.yaml`]!)).toEqual([111, 107]);
  });

  it("writes no spec.yaml for python tools without source", () => {
    const tool: SnapshotTool = { id: "t9", name: "py_tool", binding: { python: {} } };
    const parsed = parseZip(buildZip(snapshotWith([tool])));
    expect(parsed["tools/py_tool/spec.yaml"]).toBeUndefined();
    expect(parsed["tools/py_tool/tool.json"]).toBeDefined();
  });
});
