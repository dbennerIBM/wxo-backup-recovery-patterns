/**
 * Content script — fetch + XHR interceptor (MAIN world).
 *
 * Runs at document_start on all watsonx Orchestrate Agent Builder pages, in the
 * page's MAIN world. This is required because overriding `window.fetch` and
 * `XMLHttpRequest.prototype` from the ISOLATED world does not affect the page's
 * own JavaScript — the two worlds have separate copies of these globals.
 *
 * Consequences of running in the MAIN world:
 *  - Chrome extension APIs (`chrome.runtime.*`) are NOT available here.
 *  - Module imports do not work (the bundler would emit a loader that calls
 *    `chrome.runtime.getURL`). Everything this script needs is inlined below.
 *  - All captured data is forwarded via `window.postMessage` to a companion
 *    bridge script (`bridge.ts`) that runs in the ISOLATED world and relays it
 *    to the background service worker with `chrome.runtime.sendMessage`.
 *
 * Interception is fully transparent: it never alters request or response
 * behaviour in any way. Captured payloads receive a lightweight credential
 * scrub here; the background applies the full scrubber as defence-in-depth.
 *
 * What is captured (confirmed live on dl.watson-orchestrate.ibm.com, Aug 2026):
 *  - JSON RESPONSE bodies: agent GET, tools GET (paginated { data: [...] }),
 *    connections GET ({ applications: [...] }), KB detail GET.
 *  - REQUEST bodies: agent PATCH (response is 204 — the body is the saved
 *    state), KB create / KB add-documents / tool upload FormData (the wxO UI
 *    sends these via axios/XHR). Files are forwarded once the response is 2xx,
 *    with the KB uuid taken from the URL or from the create response.
 *  - The x-ibm-wo-csrf header (ephemeral) and a tenant hint from the
 *    x-ibm-wo-tenant-id cookie (opaque id, not a credential).
 * The assembler de-duplicates files by filename + length, so observing an
 * upload on more than one path is harmless.
 */

// Mark this file as a module so its top-level names don't collide with
// bridge.ts under tsc. Produces no bundler import.
export {};

// ─── Bridge channel ───────────────────────────────────────────────────────────

/** postMessage channel identifier shared with bridge.ts. */
const WXO_AUTOSAVE_CHANNEL = "__wxo_autosave__";

/**
 * Shape of a message forwarded to the bridge. Mirrors ExtensionMessage in
 * ../shared/messages (which cannot be imported here), plus
 * CONNECTION_BATCH_CAPTURED which carries an array of scrubbed connections.
 */
interface CapturedMessage {
  type: string;
  payload: unknown;
}

// ─── Endpoint matchers ────────────────────────────────────────────────────────

const WXO_API_BASE = /\/mfe_builder\/api\/(v1|v2)\/(builder|orchestrate)\//;

/** Endpoints whose JSON response bodies should be captured. */
const CAPTURE_RESPONSE_PATTERNS: Array<{
  re: RegExp;
  type: string;
}> = [
  // Agent list: GET /mfe_builder/api/v2/builder/agents (list only, minimal fields)
  { re: /\/mfe_builder\/api\/v2\/builder\/agents(\/[^/?]+)?(\?|$)/, type: "AGENT_CAPTURED" },

  // Agent detail: GET /v1/builder/orchestrate/agents/{id} — response includes
  // toolsSelected[] with full tool binding. The PATCH to the same URL returns
  // 204 No Content; its REQUEST body is captured separately (see
  // AGENT_DETAIL_RE + captureAgentPatchBody below).
  { re: /\/mfe_builder\/api\/v1\/builder\/orchestrate\/agents\/[^/?]+(\?|$)/, type: "AGENT_CAPTURED" },

  // Tool batch-fetch: GET /mfe_builder/api/v2/builder/tools?ids=<uuid>&...
  // Response is a paginated envelope { data: [...], total, limit, offset }
  // (confirmed live); older tenants may return a bare array — both handled.
  { re: /\/mfe_builder\/api\/v2\/builder\/tools(\?|$)/, type: "TOOL_CAPTURED" },

  // Connections list: GET /mfe_builder/api/v1/orchestrate/connections/applications
  { re: /\/mfe_builder\/api\/v1\/orchestrate\/connections\/applications(\?|$)/, type: "CONNECTION_CAPTURED" },

  // KB detail: GET /mfe_builder/api/v1/orchestrate/knowledge-bases/{id}
  // Exclude /documents (KB-create endpoint — its response is handled by the
  // upload path), /{id}/documents and /{id}/status sub-paths.
  {
    re: /\/mfe_builder\/api\/v1\/orchestrate\/knowledge-bases\/(?!documents(?:\?|$))[^/?]+(\?|$)/,
    type: "KB_META_CAPTURED",
  },
];

/** Agent detail URL — group 1 is the agent uuid. Used for PATCH body capture. */
const AGENT_DETAIL_RE = /\/mfe_builder\/api\/v1\/builder\/orchestrate\/agents\/([^/?#]+)(?:[?#]|$)/;

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

/**
 * Tenant hint for the assembler. Some tenants' agent payloads carry no
 * `tenant_id`; the wxO session cookie `x-ibm-wo-tenant-id` does. Falls back to
 * the page hostname so the snapshot path is never rooted at "/". The value is
 * an opaque identifier, not a credential. (Mirror of tenantFromCookie in
 * ../shared/capture.ts — cannot be imported in the MAIN world.)
 */
function readTenantHint(): string {
  try {
    for (const part of document.cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== "x-ibm-wo-tenant-id") continue;
      const value = part.slice(eq + 1).trim();
      if (value !== "") return decodeURIComponent(value);
    }
  } catch {
    // document.cookie may throw in exotic contexts — fall through.
  }
  return location.hostname;
}

/** Forward a captured message to the ISOLATED-world bridge. Fire-and-forget. */
function sendToBridge(msg: CapturedMessage): void {
  window.postMessage(
    { channel: WXO_AUTOSAVE_CHANNEL, payload: msg },
    "*",
  );
}

// ─── Inline credential scrubbers ──────────────────────────────────────────────
//
// Lightweight copies of ../shared/scrubber (which cannot be imported in the
// MAIN world). The background re-applies the full scrubber before anything is
// stored, so these only need to keep obvious secrets out of the postMessage
// channel.

/** Pre-normalised (lowercased, hyphens/underscores stripped) secret key names. */
const QUICK_SECRET_KEYS = new Set([
  "apikey",
  "token",
  "password",
  "passwd",
  "clientsecret",
  "authconfig",
  "authorization",
  "secret",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "privatekey",
  "credential",
  "credentials",
]);

function isQuickSecretKey(key: string): boolean {
  return QUICK_SECRET_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/**
 * Recursive key-based redaction. Any key matching QUICK_SECRET_KEYS is
 * replaced with "[REDACTED]"; arrays are traversed; primitives pass through.
 */
function quickScrub(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(quickScrub);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = isQuickSecretKey(k) ? "[REDACTED]" : quickScrub(v);
    }
    return result;
  }
  return value;
}

/**
 * Allowlist-based extraction for connection records: keep only app_id, kind,
 * and server_url. Everything else (auth config, credentials, etc.) is dropped.
 */
function scrubConnection(raw: Record<string, unknown>): {
  app_id: string;
  kind: string;
  server_url?: string;
} {
  const app_id = String(raw["app_id"] ?? raw["name"] ?? raw["id"] ?? "");
  const kind = String(
    raw["security_scheme"] ??
      raw["kind"] ??
      raw["type"] ??
      raw["auth_scheme"] ??
      "",
  );
  const server_url =
    raw["server_url"] !== undefined && raw["server_url"] !== null
      ? String(raw["server_url"])
      : undefined;

  const result: { app_id: string; kind: string; server_url?: string } = {
    app_id,
    kind,
  };
  if (server_url !== undefined) {
    result.server_url = server_url;
  }
  return result;
}

// ─── Inline multipart parser ──────────────────────────────────────────────────
//
// Self-contained multipart/form-data decoder (module imports don't work in the
// MAIN world). Splits the body on the boundary, then splits each part into
// headers and bytes.

interface InlineMultipartFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

function bytesIndexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function parseMultipartInline(body: Uint8Array, contentType: string): InlineMultipartFile[] {
  const boundaryMatch = /boundary=("?)([^";\s]+)\1/i.exec(contentType);
  if (!boundaryMatch) return [];
  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8", { fatal: false });
  const delim = enc.encode("--" + boundaryMatch[2]);
  const headerSep = enc.encode("\r\n\r\n");
  const files: InlineMultipartFile[] = [];

  let pos = bytesIndexOf(body, delim, 0);
  while (pos !== -1) {
    let partStart = pos + delim.length;
    // "--" immediately after the delimiter marks the closing boundary.
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;
    if (body[partStart] === 0x0d && body[partStart + 1] === 0x0a) partStart += 2;
    const next = bytesIndexOf(body, delim, partStart);
    if (next === -1) break;
    let partEnd = next;
    if (partEnd >= 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) partEnd -= 2;
    const headerEnd = bytesIndexOf(body, headerSep, partStart);
    if (headerEnd !== -1 && headerEnd < partEnd) {
      const headers = dec.decode(body.slice(partStart, headerEnd));
      const filename = /filename=("?)([^";\r\n]*?)\1(?=;|$)/im.exec(headers)?.[2] ?? "";
      const ct = /^content-type:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? "";
      files.push({ filename, contentType: ct, bytes: body.slice(headerEnd + headerSep.length, partEnd) });
    }
    pos = next;
  }
  return files;
}

// ─── Body readers ─────────────────────────────────────────────────────────────

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
    return normaliseJson(json);
  } catch {
    return null;
  }
}

/** Wrap bare JSON arrays as { items: [...] } so all captures are objects. */
function normaliseJson(json: unknown): Record<string, unknown> | null {
  if (typeof json === "object" && json !== null && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  if (Array.isArray(json)) {
    return { items: json };
  }
  return null;
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

/**
 * Parse a captured multipart body and forward each file part to the bridge.
 * Used by the fetch upload path only — XHR uploads are captured by the
 * background webRequest fallback (see the XHR interceptor below).
 */
function emitMultipartFiles(
  bytes: Uint8Array,
  contentType: string,
  target: { type: "KB_FILE_CAPTURED"; kbId: string } | { type: "TOOL_FILE_CAPTURED" },
): void {
  const files = parseMultipartInline(bytes, contentType);
  for (const file of files) {
    if (file.filename === "") continue;
    if (target.type === "KB_FILE_CAPTURED") {
      sendToBridge({
        type: "KB_FILE_CAPTURED",
        payload: {
          kbId: target.kbId,
          filename: file.filename,
          contentType: file.contentType,
          bytes: Array.from(file.bytes),
        },
      });
    } else {
      sendToBridge({
        type: "TOOL_FILE_CAPTURED",
        payload: {
          filename: file.filename,
          contentType: file.contentType,
          bytes: Array.from(file.bytes),
        },
      });
    }
  }
}

/**
 * Scrub a captured JSON response and forward it to the bridge under the
 * appropriate message type. Shared by the fetch and XHR response paths.
 */
function emitCapturedResponse(type: string, data: Record<string, unknown>, url: string): void {
  if (type === "CONNECTION_CAPTURED") {
    // The connections/applications response is
    //   { tenant_id, page, limit, total, applications: [...] }
    // Fall back to { resources } or [data] for other shapes.
    const items: unknown[] = Array.isArray(data["applications"])
      ? (data["applications"] as Record<string, unknown>[])
      : Array.isArray(data["resources"])
        ? (data["resources"] as Record<string, unknown>[])
        : [data];
    // Batch all connections into a single message so the assembler receives
    // the full set atomically instead of one message per connection.
    const batch: Array<{ app_id: string; kind: string; server_url?: string }> = [];
    for (const item of items) {
      if (typeof item === "object" && item !== null) {
        batch.push(scrubConnection(item as Record<string, unknown>));
      }
    }
    sendToBridge({ type: "CONNECTION_BATCH_CAPTURED", payload: batch });
  } else if (type === "AGENT_CAPTURED") {
    const scrubbed = quickScrub(data);
    sendToBridge({
      type: "AGENT_CAPTURED",
      payload: { data: scrubbed, sourceUrl: url, tenantHint: readTenantHint() },
    });
  } else if (type === "TOOL_CAPTURED") {
    const scrubbed = quickScrub(data);
    sendToBridge({ type: "TOOL_CAPTURED", payload: { data: scrubbed, sourceUrl: url } });
  } else if (type === "KB_META_CAPTURED") {
    const scrubbed = quickScrub(data);
    sendToBridge({ type: "KB_META_CAPTURED", payload: { data: scrubbed, sourceUrl: url } });
  }
}

// ─── Upload body helpers (FormData / JSON) ────────────────────────────────────

/**
 * Read every File/Blob entry of a FormData and forward each as a captured file.
 * This is the primary upload-capture path for XHR (axios) uploads: the wxO UI
 * builds a FormData with a "files" field, so we can read the bytes directly
 * without multipart parsing.
 */
async function emitFormDataFiles(
  form: FormData,
  target: { type: "KB_FILE_CAPTURED"; kbId: string } | { type: "TOOL_FILE_CAPTURED" },
): Promise<void> {
  const jobs: Array<Promise<void>> = [];
  form.forEach((value) => {
    if (!(value instanceof Blob)) return;
    const filename = value instanceof File ? value.name : "";
    if (filename === "") return;
    jobs.push(
      value.arrayBuffer().then((buf) => {
        const bytes = Array.from(new Uint8Array(buf));
        if (target.type === "KB_FILE_CAPTURED") {
          sendToBridge({
            type: "KB_FILE_CAPTURED",
            payload: { kbId: target.kbId, filename, contentType: value.type, bytes },
          });
        } else {
          sendToBridge({
            type: "TOOL_FILE_CAPTURED",
            payload: { filename, contentType: value.type, bytes },
          });
        }
      }),
    );
  });
  await Promise.all(jobs);
}

/** kbId from a KB create / add-documents response body ({ knowledge_base: "<uuid>" }). */
function kbIdFromResponse(data: Record<string, unknown> | null): string {
  const v = data?.["knowledge_base"];
  return typeof v === "string" ? v : "";
}

/**
 * Forward an agent PATCH request body as AGENT_CAPTURED. The PATCH response is
 * 204 No Content, so the request body is the only place the saved agent state
 * is visible. Called only after a 2xx response so rejected saves are ignored.
 */
function emitAgentPatchBody(body: unknown, url: string): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  const data = { ...(body as Record<string, unknown>) };
  // Belt-and-braces: the uuid is in the URL; add it so downstream can rely on it.
  if (typeof data["id"] !== "string") {
    const m = AGENT_DETAIL_RE.exec(url);
    if (m?.[1]) data["id"] = m[1];
  }
  emitCapturedResponse("AGENT_CAPTURED", data, url);
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
  // We capture the CSRF token so the assembler can make proactive API calls.
  const csrfToken = request.headers.get("x-ibm-wo-csrf");
  if (csrfToken !== null) {
    sendToBridge({ type: "BEARER_TOKEN_OBSERVED", payload: { token: csrfToken } });
  }

  // ── Multipart request body capture (before sending) ───────────────────────
  //
  //  1. KB_CREATE_RE  — POST /v1/orchestrate/knowledge-bases/documents
  //     Creates KB + first document. kbId is not in the URL; we pass kbId=""
  //     and the assembler fills it in when the 201 response arrives.
  //  2. KB_UPLOAD_RE  — PUT  /v1/orchestrate/knowledge-bases/{id}/documents
  //     kbId is in the URL (group 1).
  //  3. TOOL_UPLOAD_RE — POST /v2/builder/tools
  //     Hand-crafted Python/OpenAPI tool upload only (not catalog tools).

  const kbUploadMatch = KB_UPLOAD_RE.exec(url);
  const isKbCreate = request.method === "POST" && KB_CREATE_RE.test(url);
  const isToolPost = request.method === "POST" && TOOL_UPLOAD_RE.test(url);
  const isAgentPatch = request.method === "PATCH" && AGENT_DETAIL_RE.test(url);

  let multipartCapture: Promise<void> | null = null;
  /** Deferred until the response arrives (KB create needs the uuid from the 201). */
  let kbCreateBody: Promise<{ bytes: Uint8Array; contentType: string } | null> | null = null;
  let agentPatchBody: Promise<unknown> | null = null;

  if (isKbCreate) {
    kbCreateBody = readMultipartBody(request);
  } else if (isAgentPatch) {
    agentPatchBody = request.clone().json().catch(() => null);
  } else if (kbUploadMatch !== null && request.method === "PUT") {
    const kbId = kbUploadMatch[1] ?? "";
    multipartCapture = readMultipartBody(request).then((result) => {
      if (result === null) return;
      emitMultipartFiles(result.bytes, result.contentType, { type: "KB_FILE_CAPTURED", kbId });
    });
  } else if (isToolPost) {
    multipartCapture = readMultipartBody(request).then((result) => {
      if (result === null) return;
      emitMultipartFiles(result.bytes, result.contentType, { type: "TOOL_FILE_CAPTURED" });
    });
  }

  // Kick off multipart capture concurrently (non-blocking).
  multipartCapture?.catch(() => undefined);

  // ── Issue the real fetch ───────────────────────────────────────────────────
  const response = await originalFetch(request);

  // ── Deferred request-body captures (need the response) ────────────────────
  if (kbCreateBody !== null && response.ok) {
    // 201 body: { knowledge_base: "<uuid>", ... } — attach files to that uuid.
    Promise.all([kbCreateBody, readJsonBody(response)]).then(([result, data]) => {
      if (result === null) return;
      emitMultipartFiles(result.bytes, result.contentType, {
        type: "KB_FILE_CAPTURED",
        kbId: kbIdFromResponse(data),
      });
    });
    return response;
  }
  if (agentPatchBody !== null) {
    if (response.ok) {
      agentPatchBody.then((body) => emitAgentPatchBody(body, url));
    }
    // A PATCH response with a JSON body (some tenants) is still captured below.
  }

  // ── Response body capture ─────────────────────────────────────────────────
  for (const { re, type } of CAPTURE_RESPONSE_PATTERNS) {
    if (!re.test(url)) continue;

    // Only capture successful responses.
    if (!response.ok) break;

    readJsonBody(response).then((data) => {
      if (data === null) return;
      emitCapturedResponse(type, data, url);
    });

    // Only apply the first matching pattern.
    break;
  }

  return response;
}

// Install the fetch interceptor.
window.fetch = interceptedFetch;

/** Parse an XHR's response as JSON, honouring responseType. Returns unknown/null. */
function readXhrJson(xhr: XMLHttpRequest): unknown {
  if (xhr.responseType === "" || xhr.responseType === "text") {
    return xhr.responseText ? JSON.parse(xhr.responseText) : null;
  }
  if (xhr.responseType === "json") return xhr.response;
  return null;
}

// ─── XHR interceptor ──────────────────────────────────────────────────────────
//
// The wxO UI issues most of its API traffic through axios, which uses
// XMLHttpRequest rather than fetch. We patch open/send/setRequestHeader on the
// prototype so every XHR on the page is observed, then apply the same
// *response* capture logic as the fetch interceptor. Request bodies are left
// to the background webRequest fallback to avoid double-capturing uploads.

interface TrackedXhr extends XMLHttpRequest {
  __wxoUrl?: string;
  __wxoMethod?: string;
}

const originalXhrOpen = XMLHttpRequest.prototype.open;
const originalXhrSend = XMLHttpRequest.prototype.send;
const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

XMLHttpRequest.prototype.open = function (
  this: TrackedXhr,
  method: string,
  url: string | URL,
  ...rest: unknown[]
): void {
  try {
    this.__wxoUrl = new URL(String(url), location.href).href;
  } catch {
    this.__wxoUrl = String(url);
  }
  this.__wxoMethod = String(method).toUpperCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalXhrOpen as any).call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.setRequestHeader = function (
  this: TrackedXhr,
  name: string,
  value: string,
): void {
  if (
    name.toLowerCase() === "x-ibm-wo-csrf" &&
    this.__wxoUrl !== undefined &&
    WXO_API_BASE.test(this.__wxoUrl)
  ) {
    sendToBridge({ type: "BEARER_TOKEN_OBSERVED", payload: { token: value } });
  }
  return originalXhrSetRequestHeader.call(this, name, value);
};

XMLHttpRequest.prototype.send = function (
  this: TrackedXhr,
  body?: Document | XMLHttpRequestBodyInit | null,
): void {
  const url = this.__wxoUrl ?? "";

  if (!WXO_API_BASE.test(url)) {
    return originalXhrSend.call(this, body);
  }

  const method = this.__wxoMethod ?? "GET";

  // ── Request-body capture (uploads + agent PATCH) ──────────────────────────
  //
  // The wxO UI sends uploads via axios/XHR with a FormData body. We read the
  // File entries directly (no multipart parsing) once the response is 2xx:
  //  - KB create  POST …/knowledge-bases/documents  → kbId from 201 body
  //  - KB upload  PUT  …/knowledge-bases/{id}/documents → kbId from URL
  //  - Tool upload POST …/v2/builder/tools           → TOOL_FILE_CAPTURED
  // The assembler de-duplicates by filename + length, so a second observation
  // of the same upload (e.g. webRequest on a redirect) is harmless.
  //
  // Agent PATCH …/agents/{uuid} returns 204; the request body is the saved
  // agent state and is forwarded as AGENT_CAPTURED after a 2xx.
  const isKbCreate = method === "POST" && KB_CREATE_RE.test(url);
  const kbUploadMatch = method === "PUT" ? KB_UPLOAD_RE.exec(url) : null;
  const isToolPost = method === "POST" && TOOL_UPLOAD_RE.test(url);
  const isAgentPatch = method === "PATCH" && AGENT_DETAIL_RE.test(url);

  if (isKbCreate || kbUploadMatch !== null || isToolPost || isAgentPatch) {
    const capturedBody = body;
    this.addEventListener("load", () => {
      try {
        if (this.status < 200 || this.status >= 300) return;

        if (isAgentPatch) {
          if (typeof capturedBody === "string") {
            emitAgentPatchBody(JSON.parse(capturedBody), url);
          }
          return;
        }

        if (!(capturedBody instanceof FormData)) return;
        if (isToolPost) {
          void emitFormDataFiles(capturedBody, { type: "TOOL_FILE_CAPTURED" });
          return;
        }
        let kbId = kbUploadMatch?.[1] ?? "";
        if (isKbCreate) {
          const data = normaliseJson(readXhrJson(this));
          kbId = kbIdFromResponse(data);
        }
        void emitFormDataFiles(capturedBody, { type: "KB_FILE_CAPTURED", kbId });
      } catch {
        // Unreadable body — skip silently.
      }
    });
    if (isAgentPatch || isKbCreate) {
      // Response-pattern capture below would double-handle these URLs
      // (204 agent PATCH has no body; KB create response is not KB meta).
      return originalXhrSend.call(this, body);
    }
  }

  // ── Response body capture ─────────────────────────────────────────────────
  for (const { re, type } of CAPTURE_RESPONSE_PATTERNS) {
    if (!re.test(url)) continue;

    this.addEventListener("load", () => {
      try {
        if (this.status < 200 || this.status >= 300) return;
        const ct = this.getResponseHeader("Content-Type") ?? "";
        if (!ct.includes("application/json") && !ct.includes("application/hal+json")) return;

        const data = normaliseJson(readXhrJson(this));
        if (data === null) return;
        emitCapturedResponse(type, data, url);
      } catch {
        // Non-JSON or unreadable body — skip silently.
      }
    });

    // Only apply the first matching pattern.
    break;
  }

  return originalXhrSend.call(this, body);
};
