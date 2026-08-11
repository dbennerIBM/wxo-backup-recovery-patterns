/**
 * Content script — fetch interceptor.
 *
 * Runs at document_start on all watsonx Orchestrate Agent Builder pages.
 *
 * Overrides window.fetch to:
 *  1. Capture JSON response bodies for wxO API endpoints of interest.
 *  2. Capture multipart request bodies for KB document and tool spec uploads.
 *  3. Forward captured data to the background service worker via
 *     chrome.runtime.sendMessage.
 *
 * The interceptor is fully transparent: it never alters request or response
 * behaviour in any way. If the background port is unavailable, capture is
 * silently skipped.
 */

import type { ExtensionMessage } from "../shared/messages";

// ─── Endpoint matchers ────────────────────────────────────────────────────────
//
// CONFIRMED from HAR inspection (us-south, Aug 2026) — 4 HARs total:
//
// Auth: session cookie + x-ibm-wo-csrf header. NO Authorization: Bearer.
//
// Confirmed endpoints and their versions:
//
//   TOOLS (v2/builder):
//     GET  /mfe_builder/api/v2/builder/tools
//          ?&ids=<uuid>&ids=<uuid>&...&show_bundled=true&include=global&workspace_id=...
//          — Batch-fetch tools by UUID list. Response is a bare JSON array.
//          — binding.python.connections / binding.mcp.connections = { app_id: conn_uuid }
//
//     POST /mfe_builder/api/v1/builder/tools/create-from-template?parent_agent_id=<uuid>
//          — Catalog tool add (JSON body, NOT multipart). Response: { id: ["<uuid>"] }
//
//   AGENT SAVE (v1/builder):
//     PATCH /mfe_builder/api/v1/builder/orchestrate/agents/<uuid>
//          — Richest single capture: tools[], toolsSelected[] with full binding,
//            llm, instructions, guidelines, knowledge_base[], collaborators[].
//
//   CONNECTIONS (v1/orchestrate):
//     GET  /mfe_builder/api/v1/orchestrate/connections/applications?connectionIds=
//          — Response: { tenant_id, page, limit, total, applications: [...] }
//          — security_scheme: null for MCP connections; "api_key_auth" etc. for others.
//
//   KNOWLEDGE BASES (v1/orchestrate) — CONFIRMED HAR 4:
//     POST /mfe_builder/api/v1/orchestrate/knowledge-bases/documents
//          — Creates KB + uploads first document in one multipart call.
//            form field "knowledge_base": JSON config (id, display_name, description, ...)
//            form field "files": binary document bytes
//            Response: { tool, vector_index, doc_collection, knowledge_base: "<uuid>" }
//
//     GET  /mfe_builder/api/v1/orchestrate/knowledge-bases/<uuid>
//          — Full KB detail. Response: { id, name, display_name, description,
//            vector_index: { embeddings_model_name, chunk_size, ... },
//            conversational_search_tool: { ... }, status, ... }
//
//     PUT  /mfe_builder/api/v1/orchestrate/knowledge-bases/<uuid>/documents
//          — Upload additional documents to existing KB. Multipart form field "files".
//            Response: { knowledge_base: "<uuid>", documents: ["<doc-uuid>", ...] }
//            NOTE: method is PUT, not POST.
//
//     GET  /mfe_builder/api/v1/orchestrate/knowledge-bases/<uuid>/status
//          — Polling endpoint. NOT captured (noisy, no new structural data).
//
// Key architectural corrections (HAR 1–4):
//   1. ALL KB paths are /v1/orchestrate/, NOT /v2/builder/ (original plan was wrong).
//   2. KB document upload is PUT, not POST.
//   3. KB create is a single multipart POST to /knowledge-bases/documents (no separate
//      "create KB then upload" — they happen in one request).
//   4. Agent PATCH toolsSelected[] is the gold mine — no proactive tool fetch needed.

const WXO_API_BASE = /\/mfe_builder\/api\/(v1|v2)\/(builder|orchestrate)\//;

/** Endpoints whose JSON response bodies should be captured. */
const CAPTURE_RESPONSE_PATTERNS: Array<{
  re: RegExp;
  type: ExtensionMessage["type"];
}> = [
  // Agent list: GET /mfe_builder/api/v2/builder/agents (list only, minimal fields)
  { re: /\/mfe_builder\/api\/v2\/builder\/agents(\/[^/?]+)?(\?|$)/, type: "AGENT_CAPTURED" },

  // Agent detail + PATCH: /v1/builder/orchestrate/agents/{id}
  // PATCH is the richest capture — includes toolsSelected[] with full tool binding.
  { re: /\/mfe_builder\/api\/v1\/builder\/orchestrate\/agents\/[^/?]+(\?|$)/, type: "AGENT_CAPTURED" },

  // Tool batch-fetch: GET /mfe_builder/api/v2/builder/tools?ids=<uuid>&...
  // Response is a bare JSON array (not wrapped in { data: [...] }).
  { re: /\/mfe_builder\/api\/v2\/builder\/tools(\?|$)/, type: "TOOL_CAPTURED" },

  // Connections list: GET /mfe_builder/api/v1/orchestrate/connections/applications
  { re: /\/mfe_builder\/api\/v1\/orchestrate\/connections\/applications(\?|$)/, type: "CONNECTION_CAPTURED" },

  // KB detail: GET /mfe_builder/api/v1/orchestrate/knowledge-bases/{id}
  // CONFIRMED HAR 4: path is v1/orchestrate, NOT v2/builder.
  // Exclude /documents and /status sub-paths.
  {
    re: /\/mfe_builder\/api\/v1\/orchestrate\/knowledge-bases\/[^/?]+(\?|$)/,
    type: "KB_META_CAPTURED",
  },
];

/**
 * Multipart upload endpoints whose REQUEST bodies should be captured.
 *
 * KB_CREATE_RE — POST /v1/orchestrate/knowledge-bases/documents
 *   Creates a new KB and uploads the first document in one call.
 *   Form field "knowledge_base" contains the KB config JSON.
 *   Form field "files" contains the document bytes.
 *   Response: { tool, vector_index, doc_collection, knowledge_base: "<uuid>" }
 *
 * KB_UPLOAD_RE — PUT /v1/orchestrate/knowledge-bases/{id}/documents
 *   Uploads additional documents to an existing KB. Method is PUT, not POST.
 *   Group 1 = KB id.
 *
 * TOOL_UPLOAD_RE — POST /v2/builder/tools
 *   Only fires for hand-crafted Python/OpenAPI tool uploads (not catalog tools).
 */
const KB_CREATE_RE = /\/mfe_builder\/api\/v1\/orchestrate\/knowledge-bases\/documents(\?|$)/;
const KB_UPLOAD_RE = /\/mfe_builder\/api\/v1\/orchestrate\/knowledge-bases\/([^/?]+)\/documents(\?|$)/;
const TOOL_UPLOAD_RE = /\/mfe_builder\/api\/v2\/builder\/tools(\?|$)/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Send a message to the background service worker. Fire-and-forget. */
function sendToBackground(msg: ExtensionMessage): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      // Background SW may be inactive — silently ignore.
    });
  } catch {
    // Extension context may be invalidated (e.g. after reload).
  }
}

/**
 * Attempt to clone and read the response body as JSON.
 * Returns null if the body is not JSON or cannot be read.
 */
async function readJsonBody(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const ct = response.headers.get("Content-Type") ?? "";
    if (!ct.includes("application/json") && !ct.includes("application/hal+json")) {
      return null;
    }
    const cloned = response.clone();
    const json = await cloned.json();
    if (typeof json === "object" && json !== null && !Array.isArray(json)) {
      return json as Record<string, unknown>;
    }
    // If the response is a JSON array (e.g. a list endpoint), wrap it.
    return { items: json };
  } catch {
    return null;
  }
}

/**
 * Read a Request's multipart body bytes.
 * Returns null if the body cannot be read or is not multipart.
 */
async function readMultipartBody(
  request: Request,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const ct = request.headers.get("Content-Type") ?? "";
    if (!ct.includes("multipart/form-data")) return null;
    const cloned = request.clone();
    const buffer = await cloned.arrayBuffer();
    return { bytes: new Uint8Array(buffer), contentType: ct };
  } catch {
    return null;
  }
}

// ─── Fetch interceptor ────────────────────────────────────────────────────────

const originalFetch = window.fetch.bind(window);

async function interceptedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Build a Request object so we always have a uniform interface.
  const request = new Request(input, init);
  const url = request.url;

  // Only act on wxO API calls.
  if (!WXO_API_BASE.test(url)) {
    return originalFetch(request);
  }

  // ── CSRF token observation (replaces Bearer token for wxO SaaS UI) ────────
  // The wxO UI authenticates via session cookie + x-ibm-wo-csrf header.
  // There is no Authorization: Bearer on these requests.
  // We capture the CSRF token so the assembler can make proactive API calls.
  const csrfToken = request.headers.get("x-ibm-wo-csrf");
  if (csrfToken !== null) {
    sendToBackground({ type: "BEARER_TOKEN_OBSERVED", payload: { token: csrfToken } });
  }

  // ── Multipart request body capture (before sending) ───────────────────────
  //
  // Three multipart shapes (HAR 4 confirmed):
  //
  //  1. KB_CREATE_RE  — POST  /v1/orchestrate/knowledge-bases/documents
  //     Creates KB + first document. kbId extracted from the response (not the URL).
  //     We pass kbId="" here; the assembler fills it in when the 201 response arrives.
  //
  //  2. KB_UPLOAD_RE  — PUT   /v1/orchestrate/knowledge-bases/{id}/documents
  //     kbId is in the URL (group 1). Method is PUT.
  //
  //  3. TOOL_UPLOAD_RE — POST /v2/builder/tools
  //     Hand-crafted Python/OpenAPI tool upload only (not catalog tools).

  const kbUploadMatch = KB_UPLOAD_RE.exec(url);    // PUT .../knowledge-bases/{id}/documents
  const isKbCreate   = request.method === "POST" && KB_CREATE_RE.test(url);
  const isToolPost   = request.method === "POST" && TOOL_UPLOAD_RE.test(url);

  let multipartCapture: Promise<void> | null = null;

  if (isKbCreate) {
    // POST /knowledge-bases/documents — creates KB and uploads first file.
    // kbId is not in the URL; it comes back in the 201 response body.
    // We emit with kbId="" — the assembler must correlate with the response.
    multipartCapture = readMultipartBody(request).then((result) => {
      if (result === null) return;
      import("../shared/multipart").then(({ parseMultipart }) => {
        const files = parseMultipart(result.bytes, result.contentType);
        for (const file of files) {
          if (file.filename !== "") {
            sendToBackground({
              type: "KB_FILE_CAPTURED",
              payload: {
                kbId: "",   // filled by assembler from the POST 201 response
                filename: file.filename,
                contentType: file.contentType,
                bytes: Array.from(file.bytes),
              },
            });
          }
        }
      });
    });
  } else if (kbUploadMatch !== null && request.method === "PUT") {
    // PUT /knowledge-bases/{id}/documents — uploads additional files to existing KB.
    const kbId = kbUploadMatch[1] ?? "";
    multipartCapture = readMultipartBody(request).then((result) => {
      if (result === null) return;
      import("../shared/multipart").then(({ parseMultipart }) => {
        const files = parseMultipart(result.bytes, result.contentType);
        for (const file of files) {
          if (file.filename !== "") {
            sendToBackground({
              type: "KB_FILE_CAPTURED",
              payload: {
                kbId,
                filename: file.filename,
                contentType: file.contentType,
                bytes: Array.from(file.bytes),
              },
            });
          }
        }
      });
    });
  } else if (isToolPost) {
    multipartCapture = readMultipartBody(request).then((result) => {
      if (result === null) return;
      import("../shared/multipart").then(({ parseMultipart }) => {
        const files = parseMultipart(result.bytes, result.contentType);
        for (const file of files) {
          if (file.filename !== "") {
            sendToBackground({
              type: "TOOL_FILE_CAPTURED",
              payload: {
                filename: file.filename,
                contentType: file.contentType,
                bytes: Array.from(file.bytes),
              },
            });
          }
        }
      });
    });
  }

  // Kick off multipart capture concurrently (non-blocking).
  multipartCapture?.catch(() => undefined);

  // ── Issue the real fetch ───────────────────────────────────────────────────
  const response = await originalFetch(request);

  // ── Response body capture ─────────────────────────────────────────────────
  for (const { re, type } of CAPTURE_RESPONSE_PATTERNS) {
    if (!re.test(url)) continue;

    // Only capture successful responses.
    if (!response.ok) break;

    readJsonBody(response).then((data) => {
      if (data === null) return;

      if (type === "CONNECTION_CAPTURED") {
        // Connection payloads need the scrubbed connection helper.
        import("../shared/scrubber").then(({ scrubConnectionPayload }) => {
          // CONFIRMED from HAR 2+3: the real connections/applications response is
          //   { tenant_id, page, limit, total, applications: [...] }
          // NOT { resources: [...] } (that was an incorrect assumption).
          // Fall back to [data] for a single-connection response shape.
          const items: unknown[] = Array.isArray(data["applications"])
            ? (data["applications"] as Record<string, unknown>[])
            : Array.isArray(data["resources"])
              ? (data["resources"] as Record<string, unknown>[])
              : [data];
          for (const item of items) {
            if (typeof item === "object" && item !== null) {
              const scrubbed = scrubConnectionPayload(
                item as Record<string, unknown>,
              );
              sendToBackground({ type: "CONNECTION_CAPTURED", payload: scrubbed });
            }
          }
        });
      } else if (type === "AGENT_CAPTURED") {
        import("../shared/scrubber").then(({ scrubSecrets }) => {
          const scrubbed = scrubSecrets(data) as Record<string, unknown>;
          sendToBackground({
            type: "AGENT_CAPTURED",
            payload: { data: scrubbed, sourceUrl: url },
          });
        });
      } else if (type === "TOOL_CAPTURED") {
        import("../shared/scrubber").then(({ scrubSecrets }) => {
          const scrubbed = scrubSecrets(data) as Record<string, unknown>;
          sendToBackground({
            type: "TOOL_CAPTURED",
            payload: { data: scrubbed, sourceUrl: url },
          });
        });
      } else if (type === "KB_META_CAPTURED") {
        import("../shared/scrubber").then(({ scrubSecrets }) => {
          const scrubbed = scrubSecrets(data) as Record<string, unknown>;
          sendToBackground({
            type: "KB_META_CAPTURED",
            payload: { data: scrubbed, sourceUrl: url },
          });
        });
      }
    });

    // Only apply the first matching pattern.
    break;
  }

  return response;
}

// Install the interceptor.
window.fetch = interceptedFetch;

console.log("[wxo-autosave] content script loaded — fetch interceptor installed on", location.hostname);
