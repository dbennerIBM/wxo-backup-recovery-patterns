/**
 * Content script — MAIN world → background bridge (ISOLATED world).
 *
 * The interceptor in ./index.ts runs in the page's MAIN world, where
 * `chrome.runtime` is unavailable. It posts captured data to `window` on the
 * `__wxo_autosave__` channel; this script (ISOLATED world, same page, same
 * document_start timing) validates each message and relays it to the
 * background service worker with `chrome.runtime.sendMessage`.
 *
 * IMPORTANT: this file must NOT import any modules. The bundler emits a
 * `chrome.runtime.getURL` loader for content scripts with imports, which
 * changes execution timing and can break the document_start guarantee.
 */

// Mark this file as a module so its top-level names don't collide with
// index.ts under tsc. Produces no bundler import.
export {};

const WXO_AUTOSAVE_CHANNEL = "__wxo_autosave__";

/** Message types accepted from the MAIN-world interceptor. */
const ALLOWED_TYPES = new Set([
  "AGENT_CAPTURED",
  "TOOL_CAPTURED",
  "CONNECTION_CAPTURED",
  "CONNECTION_BATCH_CAPTURED",
  "KB_META_CAPTURED",
  "KB_FILE_CAPTURED",
  "TOOL_FILE_CAPTURED",
  "BEARER_TOKEN_OBSERVED",
]);

window.addEventListener("message", (event: MessageEvent) => {
  // Only accept messages from this window (the MAIN-world script), never from
  // iframes or other origins.
  if (event.source !== window) return;

  const data = event.data as { channel?: unknown; payload?: unknown } | null;
  if (typeof data !== "object" || data === null) return;
  if (data.channel !== WXO_AUTOSAVE_CHANNEL) return;

  const msg = data.payload as { type?: unknown; payload?: unknown } | null;
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string" || !ALLOWED_TYPES.has(msg.type)) {
    console.warn("[wxo-autosave] bridge: dropped invalid message", msg);
    return;
  }

  try {
    chrome.runtime.sendMessage({ type: msg.type, payload: msg.payload }).catch((err: unknown) => {
      // Background SW may be inactive or the extension was reloaded.
      console.warn("[wxo-autosave] bridge: sendMessage failed", err);
    });
  } catch (err) {
    console.error("[wxo-autosave] bridge: extension context unavailable", err);
  }
});
