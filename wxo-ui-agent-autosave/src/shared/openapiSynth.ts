/**
 * OpenAPI spec synthesis for OpenAPI-bound tools captured without source.
 *
 * The new wxO builder UI parses uploaded OpenAPI specs client-side and POSTs
 * the extracted tool definition as JSON — the raw spec file never crosses the
 * network, so multipart capture (FR-1.8) can never see it. The builder API's
 * GET /v2/builder/tools?ids=… response carries everything needed to rebuild
 * an importable spec: `binding.openapi` (method/path/servers), `input_schema`
 * (parameters, with `in` + `aliasName` per property), and `output_schema`.
 *
 * This module reverses that parse: it emits a minimal OpenAPI 3.0 document
 * that `orchestrate tools import -k openapi` accepts, so the restore path
 * (FR-5.6) works for tools whose original spec was never captured.
 */

import type { SnapshotTool } from "./index";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface OpenApiBinding {
  http_method: string;
  http_path: string;
  servers: string[];
}

/** Extract binding.openapi when it has the fields synthesis needs. */
function openApiBinding(tool: SnapshotTool): OpenApiBinding | null {
  if (!isRecord(tool.binding)) return null;
  const openapi = tool.binding["openapi"];
  if (!isRecord(openapi)) return null;
  const method = openapi["http_method"];
  const path = openapi["http_path"];
  if (typeof method !== "string" || typeof path !== "string") return null;
  const servers = Array.isArray(openapi["servers"])
    ? openapi["servers"].filter((s): s is string => typeof s === "string")
    : [];
  return { http_method: method, http_path: path, servers };
}

/** Copy a property schema, dropping the wxO routing keys (`in`, `aliasName`, `title`). */
function paramSchema(prop: Record<string, unknown>): Record<string, unknown> {
  const { in: _in, aliasName: _alias, title: _title, description: _desc, ...schema } = prop;
  return schema;
}

/**
 * Synthesise an OpenAPI 3.0 document for a tool with an `openapi` binding.
 * Returns null when the tool is not OpenAPI-bound or lacks binding detail.
 *
 * Best-effort: query/path/header parameters are rebuilt from `input_schema`
 * properties carrying an `in` key (the wire name comes from `aliasName`,
 * falling back to `title`, then the property key). Properties without a
 * recognised `in` are grouped into a JSON request body. Security schemes are
 * not reconstructed — connection binding is restored separately via
 * `--app-id` (FR-5.6).
 */
export function synthesizeOpenApiSpec(tool: SnapshotTool): Record<string, unknown> | null {
  const binding = openApiBinding(tool);
  if (binding === null) return null;

  const input = isRecord(tool.input_schema) ? tool.input_schema : {};
  const properties = isRecord(input["properties"]) ? input["properties"] : {};
  const required = Array.isArray(input["required"])
    ? input["required"].filter((k): k is string => typeof k === "string")
    : [];

  const parameters: Record<string, unknown>[] = [];
  const bodyProps: Record<string, unknown> = {};
  const bodyRequired: string[] = [];

  for (const [key, rawProp] of Object.entries(properties)) {
    if (!isRecord(rawProp)) continue;
    const location = typeof rawProp["in"] === "string" ? rawProp["in"] : "";
    if (location === "query" || location === "path" || location === "header") {
      const name =
        (typeof rawProp["aliasName"] === "string" && rawProp["aliasName"]) ||
        (typeof rawProp["title"] === "string" && rawProp["title"]) ||
        key;
      parameters.push({
        name,
        in: location,
        required: location === "path" || required.includes(key),
        ...(typeof rawProp["description"] === "string"
          ? { description: rawProp["description"] }
          : {}),
        schema: paramSchema(rawProp),
      });
    } else {
      const name =
        (typeof rawProp["aliasName"] === "string" && rawProp["aliasName"]) || key;
      const { in: _in, aliasName: _alias, ...schema } = rawProp;
      bodyProps[name] = schema;
      if (required.includes(key)) bodyRequired.push(name);
    }
  }

  const operation: Record<string, unknown> = {
    operationId: tool.name,
    ...(tool.display_name ? { summary: tool.display_name } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(Object.keys(bodyProps).length > 0
      ? {
          requestBody: {
            required: bodyRequired.length > 0,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: bodyProps,
                  ...(bodyRequired.length > 0 ? { required: bodyRequired } : {}),
                },
              },
            },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "Successful response",
        ...(isRecord(tool.output_schema)
          ? { content: { "application/json": { schema: tool.output_schema } } }
          : {}),
      },
    },
  };

  return {
    openapi: "3.0.3",
    info: {
      title: tool.display_name ?? tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      version: "1.0.0",
    },
    ...(binding.servers.length > 0
      ? { servers: binding.servers.map((url) => ({ url })) }
      : {}),
    paths: {
      [binding.http_path]: {
        [binding.http_method.toLowerCase()]: operation,
      },
    },
  };
}
