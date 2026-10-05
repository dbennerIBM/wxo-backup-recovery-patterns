/**
 * Raw-capture → ADK-spec transforms.
 *
 * The extension captures raw builder-API payloads (agent PATCH bodies, KB
 * detail responses, connection application records). The ADK CLI refuses
 * those verbatim: every importable spec must carry `spec_version`/`kind`,
 * agent tool/KB references must be *names* (the CLI dereferences names to
 * ids and hard-exits on a miss), and connection specs need an
 * `environments` block. These transforms bridge the two shapes at restore
 * time so that snapshots taken by any extension version remain restorable.
 *
 * Verified against ADK 2.14.0 (`ibm_watsonx_orchestrate` package sources).
 */

import type { ZipConnectionMeta } from "./zip.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdkAgentSpec {
  spec_version: "v1";
  kind: "native";
  name: string;
  display_name?: string;
  description: string;
  instructions?: string;
  llm?: string;
  style?: string;
  tools?: string[];
  knowledge_base?: string[];
}

export interface AdkConnectionSpec {
  spec_version: "v1";
  kind: "connection";
  app_id: string;
  environments: {
    draft: {
      kind: string;
      type: "team";
      server_url?: string;
    };
  };
}

export interface AdkKnowledgeBaseSpec {
  spec_version: "v1";
  kind: "knowledge_base";
  name: string;
  description?: string;
  documents: string[];
}

export interface TransformResult<T> {
  spec: T;
  warnings: string[];
}

// ─── Connections ──────────────────────────────────────────────────────────────

/**
 * Captured connection `kind` holds the builder API's `security_scheme` value.
 * The ADK connection spec instead wants a `ConnectionKind` under
 * `environments.<env>.kind`. Mapping per ADK `CONNECTION_KIND_SCHEME_MAPPING`
 * (oauth2 is ambiguous across the oauth_* kinds; auth-code flow is the common
 * builder default).
 */
const SECURITY_SCHEME_TO_ADK_KIND: Record<string, string> = {
  api_key_auth: "api_key",
  basic_auth: "basic",
  bearer_token: "bearer",
  key_value_creds: "key_value",
  oauth2: "oauth_auth_code_flow",
};

/**
 * Build an ADK connection import spec from captured metadata.
 * Returns null when the auth scheme is unknown (e.g. MCP toolkit connections,
 * captured with `kind: ""`) — those cannot be expressed as an import spec and
 * should fall back to `orchestrate connections add`.
 */
export function toAdkConnectionSpec(meta: ZipConnectionMeta): AdkConnectionSpec | null {
  const kind = SECURITY_SCHEME_TO_ADK_KIND[meta.kind];
  if (!kind) return null;

  const draft: AdkConnectionSpec["environments"]["draft"] = { kind, type: "team" };
  if (meta.server_url) draft.server_url = meta.server_url;

  return {
    spec_version: "v1",
    kind: "connection",
    app_id: meta.app_id,
    environments: { draft },
  };
}

// ─── Agent ────────────────────────────────────────────────────────────────────

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Build an ADK native-agent import spec from a captured agent payload.
 *
 * `toolIdToName` / `kbIdToName` map the payload's uuid references to names
 * (from the zip's tool.json / kb.yaml files). References with no mapping are
 * dropped with a warning: leaving a uuid in place would make the CLI's
 * name-based dereference hard-exit and fail the whole import.
 */
export function toAdkAgentSpec(
  raw: Record<string, unknown>,
  toolIdToName: Map<string, string>,
  kbIdToName: Map<string, string>,
): TransformResult<AdkAgentSpec> {
  const warnings: string[] = [];

  const name = asString(raw["name"]) ?? asString(raw["display_name"]);
  if (!name) throw new Error("Agent payload has no usable name");

  const spec: AdkAgentSpec = {
    spec_version: "v1",
    kind: "native",
    name,
    // `description` is mandatory (min length 1) in the ADK spec.
    description: asString(raw["description"]) ?? name,
  };

  const displayName = asString(raw["display_name"]);
  if (displayName) spec.display_name = displayName;
  const instructions = asString(raw["instructions"]);
  if (instructions) spec.instructions = instructions;
  const llm = asString(raw["llm"]);
  if (llm) spec.llm = llm;
  const style = asString(raw["style"]);
  if (style) spec.style = style;

  const tools: string[] = [];
  for (const id of asStringArray(raw["tools"])) {
    const toolName = toolIdToName.get(id);
    if (toolName) {
      tools.push(toolName);
    } else {
      warnings.push(`tool ${id} is not in the snapshot — dropped from agent spec`);
    }
  }
  if (tools.length) spec.tools = tools;

  const kbs: string[] = [];
  for (const id of asStringArray(raw["knowledge_base"])) {
    const kbName = kbIdToName.get(id);
    if (kbName) {
      kbs.push(kbName);
    } else {
      warnings.push(`knowledge base ${id} is not in the snapshot — dropped from agent spec`);
    }
  }
  if (kbs.length) spec.knowledge_base = kbs;

  return { spec, warnings };
}

// ─── Knowledge base ───────────────────────────────────────────────────────────

/**
 * Build an ADK knowledge-base import spec from captured KB metadata plus the
 * on-disk paths of the KB's documents (written to a temp dir by the caller).
 *
 * The ADK requires either `documents` or an external `index_config`; captured
 * built-in-Milvus KBs only have documents, so an empty `documentPaths` means
 * the KB cannot be imported — callers should surface that instead of calling
 * this with no documents.
 */
export function toAdkKnowledgeBaseSpec(
  rawMeta: Record<string, unknown>,
  documentPaths: string[],
): TransformResult<AdkKnowledgeBaseSpec> {
  const warnings: string[] = [];

  const name = asString(rawMeta["name"]) ?? asString(rawMeta["display_name"]) ?? asString(rawMeta["id"]);
  if (!name) throw new Error("Knowledge base metadata has no usable name");

  const spec: AdkKnowledgeBaseSpec = {
    spec_version: "v1",
    kind: "knowledge_base",
    name,
    documents: documentPaths,
  };

  const description = asString(rawMeta["description"]);
  if (description) spec.description = description;

  return { spec, warnings };
}
