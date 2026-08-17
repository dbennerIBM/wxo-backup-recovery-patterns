# Changelog

## 2026-08-17 — Live-tenant capture fixes (requirements v1.4)

Diagnosed from a real session on `dl.watson-orchestrate.ibm.com`: snapshots were saved only on agent GET, under a `/`-rooted key (no tenant), with no tools, no connections, and no KB documents.

### wxo-ui-agent-autosave/src/shared/capture.ts (New File) · `__tests__/capture.test.ts` (New, 26 tests)
- Pure helpers: `agentIdFromUrl`, `tenantFromCookie`, `pickTenant`, `tenantFromToolsPayload`, `extractToolsFromPayload` (now understands the `{ data: [...] }` envelope), `extractToolIds`, `sameFile` / `dedupFiles`, `kbIdFromUploadResponse`.

### wxo-ui-agent-autosave/src/content/index.ts
- **Agent PATCH request body captured** (fetch + XHR) after a 2xx → `AGENT_CAPTURED` (uuid injected from URL). The 204 response has no body.
- **XHR upload bodies captured from `FormData`** (KB create / KB add-docs / tool upload) after a 2xx; KB-create `kbId` read from the 201 body. Fetch-path KB-create also defers until the response to get the uuid.
- **`tenantHint`** (cookie `x-ibm-wo-tenant-id`, else hostname) attached to `AGENT_CAPTURED`.
- KB-detail regex excludes `…/knowledge-bases/documents`. XHR tracks method (`__wxoMethod`); shared `readXhrJson()`.

### wxo-ui-agent-autosave/src/background/assembler.ts
- Tenant via `pickTenant` (+ from tool `tenant_id`); agent id falls back to URL; `SnapshotAgent.tools[]` recorded; tools accepted when referenced by `agent.tools`; tools no longer referenced are pruned.
- `attachFilesToKnowledgeBase` de-duplicates; KB files/meta match KBs already attached; orphan KB files attach to the most recently active agent instead of being dropped.
- **Handlers serialised** through a promise queue; `CONNECTION_BATCH_CAPTURED` handled atomically (`handleConnectionsCaptured`).
- `snapshot uploaded (N bytes) → key` / `snapshot saved` now `console.info`.

### wxo-ui-agent-autosave/src/background/index.ts · shared/index.ts · shared/messages.ts
- `CONNECTION_BATCH_CAPTURED` forwarded to the assembler as one event; `AgentPayload.tenantHint`; `SnapshotAgent.tools`; webRequest comment corrected (lifecycle ordering).

### wxo-autosave-proxy/src/server.ts (+ 3 tests)
- `pathSegment()` — storage key never `/`-rooted; empty tenant → `unknown-tenant`, empty agent name → agentId.

### Docs
- Requirements → **v1.4**: FR-1.2, FR-1.3, FR-1.6, FR-1.17 corrected; FR-1.18, FR-1.19 added; § 12.15–12.18.

## 2026-08-17 — Requirements v1.3, popup fixes re-applied, CORS hardening reverted to spec, `tsx` as devDependency

### wxo-ui-agent-autosave/src/popup/popup.ts
The popup changes described in the 2026-08-16 entries were not present in the working tree (file was unmodified). Re-applied:
- **Added `PROXY_HOSTS` + `tryFetch()`** (localhost → 127.0.0.1 fallback); `fetchProxySnapshots`, `fetchPreflight`, `postRestore` route through it.
- **Added `pingProxy()`** using `GET /health`; the no-local-history liveness check now uses it and treats the proxy as online only on `res.ok`.
- **Fixed restore key cleared before use:** `executeRestore()` now captures `pendingRestoreKey` / `pendingRestoreName` into locals *before* `hidePreflightOverlay()` and aborts with an error row if the key is empty.
- **Overlay reset:** `init()` hides `overlay-preflight` and `overlay-progress` first.
- **`void init().catch(...)`** logs init failures instead of an unhandled rejection.

### wxo-ui-agent-autosave/tsconfig.json
- **`lib` now `["ES2022", "DOM", "DOM.Iterable"]`.** Popup and content scripts are DOM code; without it `tsc --noEmit` reported ~50 spurious "Cannot find name 'window'/'document'" errors. Remaining errors (test typings, `vite.config.ts` plugin types) are pre-existing.

### wxo-autosave-proxy/src/server.ts
- **Reverted the empty-Origin CORS bypass** added 2026-08-16. Extension SW / popup fetches always send `Origin: chrome-extension://…`; only non-browser clients lack it, and those must not reach `POST /restore` (SEC-4, OD-3). Existing unit test "rejects empty origin" is again consistent with the code.
- **`GET /health` is exempted** from the origin gate when no `Origin` header is present (liveness probe for curl / health checkers). Browser callers still receive CORS headers via the normal path.

### wxo-autosave-proxy/package.json
- **`tsx` moved from `dependencies` to `devDependencies`** (dev-time loader; production deps remain `@aws-sdk/client-s3` + `fflate`).
- **`start` uses `--env-file-if-exists=.env`** (was `--env-file=.env`, which hard-fails when `.env` is absent). `engines.node` bumped to `>=22.9`.

### wxo-autosave-proxy/.env.example (New File) · .gitignore
- Tracked configuration template covering every env var for `cos` / `s3` / `gcs` plus `ALLOWED_ORIGIN`. Root `.gitignore` gains `!.env.example` so it is not swallowed by `.env.*`.

### wxo-autosave-proxy/README.md · TESTING.md
- Quick Start documents `cp .env.example .env`; Building section explains why `tsx` replaces `--experimental-strip-types` (`.js` import specifiers are not resolved by the stripper); CORS section documents the empty-Origin rejection and the `/health` exemption; API table gains `/health` and the `200 []` behaviour; `COS_INSTANCE_CRN` marked deprecated/ignored. TESTING.md curl example passes `-H "Origin: chrome-extension://e2e"`.

### wxo-agent-backup-recovery-requirements.md → v1.3
- Change-log row, status line, architecture diagram + data-flow (MAIN world, bridge, XHR, 127.0.0.1 fallback).
- New FR-1.14–1.17 (MAIN world, fetch+XHR, postMessage bridge, no XHR-body capture), FR-7.10 (`/health`).
- Amended FR-2.7, FR-4.5, FR-6.8, FR-7.1, FR-7.3, FR-7.6, FR-7.9, NFR-6, SEC-4, SEC-7, § 9 constraints, OD-2, OD-3, § 11.6.
- New § 12.9–12.14 implementation record; glossary entries for Bridge / MAIN vs ISOLATED world; repo structure and Good First Issues updated.

## 2026-08-16 — MAIN-world content script, XHR interception, and postMessage bridge

Root cause addressed: the content script ran in the ISOLATED world, whose copies of `window.fetch` / `XMLHttpRequest` are separate from the page's. Overriding them there never affected the wxO UI's own requests, and the wxO UI issues its API calls via axios (XHR), which was not intercepted at all. Nothing was ever captured.

### wxo-ui-agent-autosave/src/content/index.ts (Major Rewrite)
- **Runs in the MAIN world** (`"world": "MAIN"` in manifest). Chrome extension APIs are unavailable there, so all communication now goes through `window.postMessage` to a new bridge script.
  - Removed `import type { ExtensionMessage } from "../shared/messages"`; added an inline `CapturedMessage` interface and the `WXO_AUTOSAVE_CHANNEL` (`"__wxo_autosave__"`) constant.
  - Header comment rewritten to describe the MAIN-world architecture.
  - Added `export {}` so tsc treats the file as a module (avoids top-level name collisions with `bridge.ts`); produces no bundler import.
- **Removed the 53-line HAR endpoint documentation block.** The regex patterns are unchanged.
- **`CAPTURE_RESPONSE_PATTERNS.type`** changed from `ExtensionMessage["type"]` to `string` (cannot import `ExtensionMessage` in the MAIN world).
- **`sendToBackground` → `sendToBridge`:** replaces `chrome.runtime.sendMessage(msg)` with `window.postMessage({ channel: WXO_AUTOSAVE_CHANNEL, payload: msg }, "*")`.
- **Inline credential scrubbers (new):** `quickScrub()` (recursive key-based redaction, same key set as `shared/scrubber`) and `scrubConnection()` (allowlist: `app_id`, `kind`, `server_url`). Replaces the `import("../shared/scrubber")` dynamic imports. The full scrubber still runs in the background as defence-in-depth.
- **Inline multipart parser (new):** `parseMultipartInline()` — self-contained multipart/form-data decoder replacing the `import("../shared/multipart")` dynamic imports. Used by the KB create, KB upload, and tool upload paths via a shared `emitMultipartFiles()` helper.
- **Connection batching:** the connections/applications response now emits one `CONNECTION_BATCH_CAPTURED` message carrying the array of scrubbed connections, instead of one `CONNECTION_CAPTURED` message per item.
- **Response capture** for `AGENT_CAPTURED`, `TOOL_CAPTURED`, `KB_META_CAPTURED` uses `quickScrub()` + `sendToBridge()` synchronously (shared `emitCapturedResponse()` helper) instead of dynamic-import callbacks.
- **Removed** the startup `console.log("[wxo-autosave] content script loaded …")`.
- **Added XHR interceptor (new):** the wxO UI uses axios/XHR, not fetch.
  - Overrides `XMLHttpRequest.prototype.open` to record method + absolute URL.
  - Overrides `XMLHttpRequest.prototype.setRequestHeader` to capture the `x-ibm-wo-csrf` token (`BEARER_TOKEN_OBSERVED`) and note the Content-Type.
  - Overrides `XMLHttpRequest.prototype.send` to add a `load` listener that parses 2xx JSON responses matching `CAPTURE_RESPONSE_PATTERNS` and forwards them with the same scrub + `sendToBridge` logic as the fetch path.
  - **XHR request bodies are deliberately NOT captured.** Multipart KB / tool uploads sent via axios are already captured by the background `chrome.webRequest.onBeforeRequest` fallback, and `attachFilesToKnowledgeBase()` appends without de-duplication — capturing them in the content script as well stored every uploaded file twice in `chrome.storage.session` (as JSON `number[]`, ~4× file size each), which could exhaust the 10 MB quota and make the snapshot write fail. An earlier revision of this rewrite did capture XHR `FormData` bodies; that branch has been removed.

### wxo-ui-agent-autosave/src/content/bridge.ts (New File)
- ISOLATED-world content script that bridges the MAIN-world interceptor to the background service worker.
- Listens for `window.postMessage` on channel `__wxo_autosave__` (same-window source only).
- Validates `type` against an allowlist of 8 message types (`AGENT_CAPTURED`, `TOOL_CAPTURED`, `CONNECTION_CAPTURED`, `CONNECTION_BATCH_CAPTURED`, `KB_META_CAPTURED`, `KB_FILE_CAPTURED`, `TOOL_FILE_CAPTURED`, `BEARER_TOKEN_OBSERVED`), then forwards via `chrome.runtime.sendMessage`.
- Logs only warnings/errors (invalid messages, send failures).
- Must NOT import any modules — `@samrum/vite-plugin-web-extension` emits a `chrome.runtime.getURL` loader for content scripts with imports, which breaks the MAIN-world script and alters `document_start` timing.

### wxo-ui-agent-autosave/manifest.json
- Existing `content_scripts` entry (`src/content/index.ts`) now has `"world": "MAIN"`.
- **Added second `content_scripts` entry** for `src/content/bridge.ts` (same matches, `document_start`, default ISOLATED world). The bridge entry is listed first so the ISOLATED-world listener is registered before the MAIN-world interceptor.
- Build side-effect: `dist/manifest.json` no longer needs `web_accessible_resources` for the content-script chunks, since both content scripts are now emitted as single self-contained files.

### wxo-ui-agent-autosave/src/shared/messages.ts
- **Added `CONNECTION_BATCH_CAPTURED`** to the `ExtensionMessage` union (payload: `ConnectionPayload[]`) and to the `isExtensionMessage()` type-guard list.

### wxo-ui-agent-autosave/src/background/index.ts
- **Added `CONNECTION_BATCH_CAPTURED` handler:** re-applies `scrubConnectionPayload()` to each item and fans out as individual `CONNECTION_CAPTURED` events, so the assembler is unchanged.

## 2026-08-16 — Proxy host fallback, `/health` endpoint, popup resilience

### wxo-ui-agent-autosave/src/background/assembler.ts
- **Added `PROXY_HOSTS` + `tryFetch(port, path, options)`:** tries `http://localhost:<port>` first, then `http://127.0.0.1:<port>` on network error; throws the last error if both fail.
- **`postSnapshotToProxy` uses `tryFetch(port, "/snapshots", …)`** instead of a hardcoded `http://localhost:${port}/snapshots` URL.

### wxo-ui-agent-autosave/src/popup/popup.ts
- **Added the same `PROXY_HOSTS` + `tryFetch()` helper.**
- **`fetchProxySnapshots`, `fetchPreflight`, `postRestore`** now call `tryFetch(port, path, …)` instead of hardcoded `http://localhost:${port}` URLs.
- **Health check endpoint changed:** the no-local-history proxy ping now hits `GET /health` (was `GET /snapshots`, which returned 400 without params) and treats the proxy as online only when `ping.ok` (was `ping.ok || ping.status < 500`).
- **`init()` error handler:** `void init();` → `void init().catch((err) => console.error("[wxo-autosave] popup init failed:", err))` so an init failure surfaces instead of an unhandled rejection.

### wxo-autosave-proxy/src/server.ts
- **Added `GET /health`** → `200 { "status": "ok" }`. Placed first in the routing chain.
- **`GET /snapshots` with missing `agent`/`tenant`** now returns `200 []` instead of `400 "Query params agent and tenant are required"`.

## 2026-08-16 — Alternate domain support, CORS fix, COS bug fix, and proxy improvements

### wxo-ui-agent-autosave/src/background/index.ts
- **Added alternate URL filters** for `*.watson-orchestrate.ibm.com` (without `cloud.`):
  - `KB_CREATE_URL_FILTER_ALT`
  - `KB_UPLOAD_URL_FILTER_ALT`
  - `TOOL_UPLOAD_URL_FILTER_ALT`
- All three added to `ALL_UPLOAD_URL_FILTERS` array.

### wxo-ui-agent-autosave/src/shared/index.ts
- **Added `WXO_HOSTNAME_ALT`** constant (`*.watson-orchestrate.ibm.com`) alongside the existing `WXO_HOSTNAME`.
- Updated comment to reflect both hostname variants.

### wxo-ui-agent-autosave/manifest.json
- **Added alternate host permissions:** `*://*.watson-orchestrate.ibm.com/*` and `http://127.0.0.1/*`.
- **Added alternate content_scripts match:** `*://*.watson-orchestrate.ibm.com/*`.

### wxo-ui-agent-autosave/src/popup/popup.ts
- **Overlay reset on init:** Added `hide("overlay-preflight")` and `hide("overlay-progress")` at the top of `init()`.

### wxo-ui-agent-autosave/src/popup/popup.css (Bug Fix)
- **Fixed `[hidden]` attribute ignored on overlays:** `.overlay` and `.overlay-actions` set `display: flex`, which overrides the browser's `[hidden] { display: none }`. Added `.overlay[hidden]` and `.overlay-actions[hidden]` rules with `display: none` so `hide()`/`show()` calls work correctly.

### wxo-ui-agent-autosave/src/popup/popup.ts (Bug Fix)
- **Fixed restore variables cleared before use:** `hidePreflightOverlay()` zeroed `pendingRestoreKey` and `pendingRestoreName` before they were read in `executeRestore()`. Now captures both into local variables before calling `hidePreflightOverlay()`.

### wxo-autosave-proxy/src/server.ts
- **CORS allows empty Origin header:** Added `origin === ""` check so requests with no Origin (service workers, curl, same-machine) are accepted.

### wxo-autosave-proxy/src/storage/cos.ts (Critical Bug Fix)
- **Removed `ibm-service-instance-id` CRN middleware.** The middleware injected the header at the `build` step AFTER the S3 HMAC signature was computed, causing COS to reject every write request with `BadRequest`. Replaced with a comment explaining why the header is not needed for HMAC auth.

### wxo-autosave-proxy/src/config.ts
- **ADK CLI command fix:** Changed `orchestrate env get` to `orchestrate env list` (correct subcommand name).

### wxo-autosave-proxy/package.json
- **Start script changed:** From `node --experimental-strip-types src/index.ts` to `node --env-file=.env --import tsx src/index.ts`. Uses `tsx` loader and loads `.env` automatically.
- **Added `tsx` dependency:** `"tsx": "^4.23.12"`.

### wxo-autosave-proxy/.env (New File)
- New environment configuration template with `STORAGE_PROVIDER`, `BUCKET`, `COS_ENDPOINT`, `COS_ACCESS_KEY_ID`, `COS_SECRET_ACCESS_KEY`, `COS_INSTANCE_CRN` placeholders.
