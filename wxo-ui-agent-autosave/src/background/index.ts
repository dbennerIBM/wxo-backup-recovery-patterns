/**
 * Background service worker — Sub-Task 2: Network Interception Layer.
 *
 * Responsibilities:
 *  1. Receive typed messages from the content script fetch interceptor.
 *  2. Use chrome.webRequest.onBeforeRequest (requestBody) as a complementary
 *     mechanism to capture multipart POST bodies for KB document uploads and
 *     OpenAPI spec uploads.
 *  3. Emit structured typed events for the downstream assembler (Sub-Task 3).
 *  4. Track the last observed bearer token ephemerally (never persisted).
 *
 * Credential scrubbing is performed in the content script before messages are
 * sent here, but the background also re-applies scrubbing as a defence-in-depth
 * measure before forwarding or storing any payload.
 */

import {
  isExtensionMessage,
  type ExtensionMessage,
  type KBFilePayload,
  type ToolFilePayload,
} from "../shared/messages";
import { scrubSecrets, scrubConnectionPayload } from "../shared/scrubber";
import { parseMultipart } from "../shared/multipart";
import { registerAssembler } from "./assembler";

// ─── Ephemeral state ──────────────────────────────────────────────────────────

/**
 * Last observed bearer token from intercepted request headers.
 * Ephemeral — lives only in the service worker's memory; never written to storage.
 * Used by Sub-Task 3's proactive tool fetcher.
 */
let lastBearerToken: string | null = null;

/** Retrieve the most recently observed bearer token. */
export function getLastBearerToken(): string | null {
  return lastBearerToken;
}

// ─── Typed event emitter ──────────────────────────────────────────────────────

/**
 * All internal event listeners keyed by message type.
 * Sub-Task 3 (assembler) will register handlers here.
 */
type EventHandler<T extends ExtensionMessage> = (payload: T["payload"]) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlers = new Map<string, Array<EventHandler<any>>>();

export function on<T extends ExtensionMessage>(
  type: T["type"],
  handler: EventHandler<T>,
): void {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type)!.push(handler);
}

export function emit<T extends ExtensionMessage>(
  type: T["type"],
  payload: T["payload"],
): void {
  const list = handlers.get(type);
  if (!list) return;
  for (const h of list) {
    try {
      h(payload);
    } catch (err) {
      console.error(`[wxo-autosave] handler error for ${type}:`, err);
    }
  }
}

// ─── Message dispatch ─────────────────────────────────────────────────────────

function handleMessage(message: ExtensionMessage): void {
  switch (message.type) {
    case "BEARER_TOKEN_OBSERVED": {
      lastBearerToken = message.payload.token;
      // Do not emit — this is internal bookkeeping only.
      break;
    }

    case "AGENT_CAPTURED": {
      const scrubbed = scrubSecrets(message.payload.data) as Record<
        string,
        unknown
      >;
      emit("AGENT_CAPTURED", {
        data: scrubbed,
        sourceUrl: message.payload.sourceUrl,
        ...(typeof message.payload.tenantHint === "string" && message.payload.tenantHint !== ""
          ? { tenantHint: message.payload.tenantHint }
          : {}),
      });
      console.debug("[wxo-autosave] AGENT_CAPTURED", message.payload.sourceUrl);
      break;
    }

    case "TOOL_CAPTURED": {
      const scrubbed = scrubSecrets(message.payload.data) as Record<
        string,
        unknown
      >;
      emit("TOOL_CAPTURED", {
        data: scrubbed,
        sourceUrl: message.payload.sourceUrl,
      });
      console.debug("[wxo-autosave] TOOL_CAPTURED", message.payload.sourceUrl);
      break;
    }

    case "CONNECTION_CAPTURED": {
      // Content script already scrubbed this; re-apply allowlist as defence-in-depth.
      const scrubbed = scrubConnectionPayload({
        app_id: message.payload.app_id,
        kind: message.payload.kind,
        server_url: message.payload.server_url,
      });
      emit("CONNECTION_CAPTURED", scrubbed);
      console.debug("[wxo-autosave] CONNECTION_CAPTURED", scrubbed.app_id);
      break;
    }

    case "CONNECTION_BATCH_CAPTURED": {
      // The MAIN-world interceptor sends all connections from one response in
      // a single message. Re-apply the allowlist to each and forward as ONE
      // batch event so the assembler applies them in a single read-modify-write.
      const items = Array.isArray(message.payload) ? message.payload : [];
      const scrubbedBatch = items
        .filter((item) => typeof item === "object" && item !== null)
        .map((item) =>
          scrubConnectionPayload({
            app_id: item.app_id,
            kind: item.kind,
            server_url: item.server_url,
          }),
        );
      emit("CONNECTION_BATCH_CAPTURED", scrubbedBatch);
      console.debug("[wxo-autosave] CONNECTION_BATCH_CAPTURED", `${items.length} connections`);
      break;
    }

    case "KB_META_CAPTURED": {
      const scrubbed = scrubSecrets(message.payload.data) as Record<
        string,
        unknown
      >;
      emit("KB_META_CAPTURED", {
        data: scrubbed,
        sourceUrl: message.payload.sourceUrl,
      });
      console.debug("[wxo-autosave] KB_META_CAPTURED", message.payload.sourceUrl);
      break;
    }

    case "KB_FILE_CAPTURED": {
      // Bytes arrive as a plain number[] (JSON-serialisable); re-wrap as Uint8Array.
      const payload: KBFilePayload = {
        ...message.payload,
        bytes: message.payload.bytes,
      };
      emit("KB_FILE_CAPTURED", payload);
      console.debug(
        "[wxo-autosave] KB_FILE_CAPTURED",
        payload.filename,
        `(${payload.bytes.length} bytes)`,
      );
      break;
    }

    case "TOOL_FILE_CAPTURED": {
      const payload: ToolFilePayload = { ...message.payload };
      emit("TOOL_FILE_CAPTURED", payload);
      console.debug(
        "[wxo-autosave] TOOL_FILE_CAPTURED",
        payload.filename,
        `(${payload.bytes.length} bytes)`,
      );
      break;
    }
  }
}

// ─── chrome.runtime.onMessage listener ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isExtensionMessage(message)) return false;
  handleMessage(message);
  // Acknowledge synchronously so the content script doesn't wait.
  sendResponse({ ok: true });
  return false; // We don't need to keep the channel open.
});

// ─── chrome.webRequest.onBeforeRequest — multipart fallback ──────────────────

/**
 * KB document upload: POST /v2/orchestrate/knowledge-bases/{id}/documents
 *
 * chrome.webRequest.onBeforeRequest with requestBody gives us the raw form
 * data bytes as an ArrayBuffer fragment array. We decode it here as a
 * complementary/fallback path alongside the content script interceptor.
 */
// CONFIRMED from HAR 4 (Aug 2026):
//   - Host: *.watson-orchestrate.cloud.ibm.com
//   - KB create:   POST /mfe_builder/api/v1/orchestrate/knowledge-bases/documents
//   - KB upload:   PUT  /mfe_builder/api/v1/orchestrate/knowledge-bases/{id}/documents
//   - Tool upload: POST /mfe_builder/api/v2/builder/tools (multipart; hand-crafted only)
//   - Catalog tools use JSON create-from-template — no webRequest interception needed.
const KB_CREATE_URL_FILTER =
  "*://*.watson-orchestrate.cloud.ibm.com/mfe_builder/api/v1/orchestrate/knowledge-bases/documents*";
const KB_UPLOAD_URL_FILTER =
  "*://*.watson-orchestrate.cloud.ibm.com/mfe_builder/api/v1/orchestrate/knowledge-bases/*/documents*";
const TOOL_UPLOAD_URL_FILTER =
  "*://*.watson-orchestrate.cloud.ibm.com/mfe_builder/api/v2/builder/tools*";

// Alternate URL filters for watson-orchestrate.ibm.com (without "cloud.")
const KB_CREATE_URL_FILTER_ALT =
  "*://*.watson-orchestrate.ibm.com/mfe_builder/api/v1/orchestrate/knowledge-bases/documents*";
const KB_UPLOAD_URL_FILTER_ALT =
  "*://*.watson-orchestrate.ibm.com/mfe_builder/api/v1/orchestrate/knowledge-bases/*/documents*";
const TOOL_UPLOAD_URL_FILTER_ALT =
  "*://*.watson-orchestrate.ibm.com/mfe_builder/api/v2/builder/tools*";

const KB_CREATE_RE =
  /\/mfe_builder\/api\/v1\/orchestrate\/knowledge-bases\/documents(\?|$)/;
const KB_UPLOAD_RE =
  /\/mfe_builder\/api\/v1\/orchestrate\/knowledge-bases\/([^/?]+)\/documents(\?|$)/;
const TOOL_UPLOAD_RE = /\/mfe_builder\/api\/v2\/builder\/tools(\?|$)/;

/**
 * Reconstruct the raw bytes from a webRequest requestBody.
 * Returns null if the body format is not raw bytes (e.g. formData map).
 */
function rawBytesFromRequestBody(
  requestBody: chrome.webRequest.WebRequestBody,
): Uint8Array | null {
  const raw = requestBody.raw;
  if (!raw || raw.length === 0) return null;
  // Concatenate all ArrayBuffer chunks.
  const totalLength = raw.reduce(
    (sum, chunk) => sum + (chunk.bytes?.byteLength ?? 0),
    0,
  );
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of raw) {
    if (chunk.bytes) {
      combined.set(new Uint8Array(chunk.bytes), offset);
      offset += chunk.bytes.byteLength;
    }
  }
  return combined;
}

function decodeAndEmitMultipart(
  bytes: Uint8Array,
  contentType: string,
  kbId: string | null,
): void {
  const files = parseMultipart(bytes, contentType);
  for (const file of files) {
    if (file.filename === "") continue;
    if (kbId !== null) {
      const payload: KBFilePayload = {
        kbId,
        filename: file.filename,
        contentType: file.contentType,
        bytes: Array.from(file.bytes),
      };
      emit("KB_FILE_CAPTURED", payload);
      console.debug(
        "[wxo-autosave] KB_FILE_CAPTURED (webRequest)",
        file.filename,
      );
    } else {
      const payload: ToolFilePayload = {
        filename: file.filename,
        contentType: file.contentType,
        bytes: Array.from(file.bytes),
      };
      emit("TOOL_FILE_CAPTURED", payload);
      console.debug(
        "[wxo-autosave] TOOL_FILE_CAPTURED (webRequest)",
        file.filename,
      );
    }
  }
}

const ALL_UPLOAD_URL_FILTERS = [
  KB_CREATE_URL_FILTER,
  KB_UPLOAD_URL_FILTER,
  TOOL_UPLOAD_URL_FILTER,
  KB_CREATE_URL_FILTER_ALT,
  KB_UPLOAD_URL_FILTER_ALT,
  TOOL_UPLOAD_URL_FILTER_ALT,
];

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // KB create is POST; KB doc upload is PUT; tool upload is POST.
    const method = details.method;
    if (method !== "POST" && method !== "PUT") return;
    if (!details.requestBody) return;

    const url = details.url;

    const isKbCreate   = method === "POST" && KB_CREATE_RE.test(url);
    const kbUploadMatch = method === "PUT"  ? KB_UPLOAD_RE.exec(url) : null;
    const isToolUpload  = method === "POST" && TOOL_UPLOAD_RE.test(url);

    if (!isKbCreate && kbUploadMatch === null && !isToolUpload) return;

    const bytes = rawBytesFromRequestBody(details.requestBody);
    if (bytes === null || bytes.length === 0) return;

    // Look up the stored Content-Type (set by onBeforeSendHeaders).
    //
    // NOTE: Chrome fires onBeforeRequest BEFORE onBeforeSendHeaders, so on the
    // first pass this is normally empty and we return here — the content
    // script's fetch/XHR interceptors are the primary upload-capture path
    // (they read the FormData / body directly). This listener only helps on
    // redirects (same requestId, headers already seen). Files reach the
    // assembler once regardless: attachFilesToKnowledgeBase() de-duplicates by
    // filename + byte length.
    const contentType = pendingContentTypes.get(details.requestId);
    if (!contentType) {
      return;
    }
    pendingContentTypes.delete(details.requestId);

    // kbId="" for KB_CREATE (unknown until response arrives); group[1] for PUT.
    const kbId = isKbCreate ? "" : (kbUploadMatch ? (kbUploadMatch[1] ?? null) : null);
    decodeAndEmitMultipart(bytes, contentType, kbId);
  },
  { urls: ALL_UPLOAD_URL_FILTERS, types: ["xmlhttprequest", "other"] },
  ["requestBody"],
);

/**
 * Capture the Content-Type header for multipart requests so that
 * onBeforeRequest can decode the multipart boundary correctly.
 *
 * Keyed by requestId; entries are cleaned up after use or on completion.
 */
const pendingContentTypes = new Map<string, string>();

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Accept POST (KB create, tool upload) and PUT (KB doc upload).
    if (details.method !== "POST" && details.method !== "PUT") return;
    const ct = details.requestHeaders?.find(
      (h) => h.name.toLowerCase() === "content-type",
    );
    if (ct?.value?.includes("multipart/form-data")) {
      pendingContentTypes.set(details.requestId, ct.value);
    }
  },
  { urls: ALL_UPLOAD_URL_FILTERS, types: ["xmlhttprequest", "other"] },
  ["requestHeaders"],
);

// Clean up any stale entries when the request completes or fails.
function cleanupRequest(
  details: chrome.webRequest.WebRequestDetailsType,
): void {
  pendingContentTypes.delete(details.requestId);
}
chrome.webRequest.onCompleted.addListener(cleanupRequest, {
  urls: ALL_UPLOAD_URL_FILTERS,
  types: ["xmlhttprequest", "other"],
});
chrome.webRequest.onErrorOccurred.addListener(cleanupRequest, {
  urls: ALL_UPLOAD_URL_FILTERS,
  types: ["xmlhttprequest", "other"],
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[wxo-autosave] extension installed/updated:", details.reason);
});

registerAssembler({ on, emit });

console.log("[wxo-autosave] background service worker initialised");
