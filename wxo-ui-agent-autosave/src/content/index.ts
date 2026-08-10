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

const WXO_API_BASE = /\/v2\/orchestrate\//;

/** Endpoints whose JSON response bodies should be captured. */
const CAPTURE_RESPONSE_PATTERNS: Array<{
  re: RegExp;
  type: ExtensionMessage["type"];
}> = [
  // Agent list: GET /v2/orchestrate/agents/unified
  // Agent detail: GET /v2/orchestrate/agents/{id}
  { re: /\/v2\/orchestrate\/agents(\/unified|\/[^/?]+)?(\?|$)/, type: "AGENT_CAPTURED" },
  // Tool list: GET /v2/orchestrate/tools
  // Tool detail / creation response: GET|POST /v2/orchestrate/tools/{id}
  { re: /\/v2\/orchestrate\/tools(\/[^/?]+)?(\?|$)/, type: "TOOL_CAPTURED" },
  // Connection list: GET /v2/orchestrate/connections
  // Connection detail: GET /v2/orchestrate/connections/{id}
  { re: /\/v2\/orchestrate\/connections(\/[^/?]+)?(\?|$)/, type: "CONNECTION_CAPTURED" },
  // KB list: GET /v2/orchestrate/knowledge-bases
  // KB detail: GET /v2/orchestrate/knowledge-bases/{id}
  // Exclude /documents sub-path (handled separately as file upload)
  {
    re: /\/v2\/orchestrate\/knowledge-bases(\/[^/?]+)?(\?|$)(?!.*\/documents)/,
    type: "KB_META_CAPTURED",
  },
];

/**
 * Multipart upload endpoints whose REQUEST bodies should be captured.
 * Pattern also captures the optional KB ID group for routing.
 *
 * Group 1 = KB id (if present)
 */
const KB_UPLOAD_RE = /\/v2\/orchestrate\/knowledge-bases\/([^/?]+)\/documents/;
const TOOL_UPLOAD_RE = /\/v2\/orchestrate\/tools(\?|$)/;

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
 * Extract a bearer token from the headers of a Request, if present.
 * Returns the raw token string (without the "Bearer " prefix) or null.
 */
function extractBearer(headers: Headers): string | null {
  const auth = headers.get("Authorization") ?? headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
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

  // ── Bearer token observation ──────────────────────────────────────────────
  const token = extractBearer(request.headers);
  if (token !== null) {
    sendToBackground({ type: "BEARER_TOKEN_OBSERVED", payload: { token } });
  }

  // ── Multipart request body capture (before sending) ───────────────────────
  const kbMatch = KB_UPLOAD_RE.exec(url);
  const isToolPost =
    request.method === "POST" && TOOL_UPLOAD_RE.test(url);

  let multipartCapture: Promise<void> | null = null;

  if (kbMatch !== null && request.method === "POST") {
    const kbId = kbMatch[1] ?? "";
    multipartCapture = readMultipartBody(request).then((result) => {
      if (result === null) return;
      // Use a web worker-safe import of parseMultipart; we import lazily to
      // keep the content script startup cost minimal.
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
          // The API may return a list ({ resources: [...] }) or a single object.
          const resources = Array.isArray(data["resources"])
            ? (data["resources"] as Record<string, unknown>[])
            : [data];
          for (const item of resources) {
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
