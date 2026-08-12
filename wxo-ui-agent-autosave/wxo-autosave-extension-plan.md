# wxO Agent Builder — Browser Extension Autosave Plan

## Top-Level Overview

**Goal:** Build a Chrome/Edge browser extension (Manifest V3) that passively intercepts all
relevant network activity in the watsonx Orchestrate Agent Builder UI, assembles a complete,
versioned snapshot of every agent artefact (agent definition, tools, knowledge-base source
documents, connection metadata — never credentials), and stores those snapshots in an IBM Cloud
Object Storage bucket (S3-compatible; AWS/GCP/Azure extensible later) via a thin local proxy
server. A popup panel lets the user browse snapshot history and trigger a one-click restore, which
is executed on the proxy side using the ADK CLI/MCP tooling — not by driving the browser UI
directly.

**Scope:**
- Chrome/Edge only, Manifest V3
- Passive capture: zero manual steps to save
- Single versioned zip per save cycle: `{tenant}/{agent-name}/{ISO-timestamp}.zip`
- Restore delegates to the local proxy (ADK CLI) — extension only initiates the request
- No secrets ever leave the browser or enter extension storage
- Local proxy technology is left as an open decision (Node, Python, Go are all viable)

**Non-goals (v1):**
- Firefox support
- Diff/merge of snapshots
- Multi-tenant concurrent sessions
- Cloud-hosted proxy (proxy is always local)

---

## Confirmed deviations from initial assumptions

These changes are now confirmed by 4 live HAR recording sessions against `us-south.watson-orchestrate.cloud.ibm.com` (Aug 2026) and should be treated as the source of truth over the original plan assumptions below.

- **wxO SaaS hostname corrected:** from `*.watson-orchestrate.ibm.com` to `*.watson-orchestrate.cloud.ibm.com`
- **Manifest/network strategy corrected:** the extension uses a content-script `fetch` interceptor for response bodies and `chrome.webRequest` for multipart request bodies; `declarativeNetRequest` is not part of the current design
- **Live API surface corrected:** the UI uses `mfe_builder/api/...` endpoints with a mix of `v1` and `v2`, not the original generic `/v2/orchestrate/...` paths assumed in the draft
- **Auth model corrected:** wxO SaaS UI requests use session cookie + `x-ibm-wo-csrf`; there is no `Authorization: Bearer` header on the captured UI traffic
- **Agent PATCH is the primary snapshot trigger:** `PATCH /mfe_builder/api/v1/builder/orchestrate/agents/{uuid}` includes `toolsSelected[]` with full binding objects, so proactive tool fetch is now a fallback path rather than the common path
- **KB create/upload flow corrected:** KB creation plus first document upload is a single multipart `POST /mfe_builder/api/v1/orchestrate/knowledge-bases/documents`; subsequent document uploads use `PUT /mfe_builder/api/v1/orchestrate/knowledge-bases/{uuid}/documents`
- **Connections response shape corrected:** the response envelope is `{ applications: [...] }`, not `{ resources: [...] }`
- **Catalog tool source limitation confirmed:** catalog tools added via `create-from-template` use presigned S3 artefacts, so source files are not capturable from `mfe_builder`; only metadata and binding can be captured in that path

## Implementation status reality check

- **Sub-Task 1:** complete
- **Sub-Task 2:** complete in implemented architecture, with endpoint/auth assumptions corrected from the original draft
- **Sub-Task 3:** in progress — the assembler exists and persists per-agent state in `chrome.storage.session`, but `SNAPSHOT_READY` bus emission, zip serialisation, proxy POST, and recent-snapshot local index are not yet implemented

## Sub-Tasks

---

### Sub-Task 1 — Project Scaffold and Toolchain

**Intent:**
Establish the project structure, build tooling, and TypeScript configuration for a Manifest V3
Chrome extension. This foundation determines every subsequent sub-task so it must be settled first.

**Expected Outcomes:**
- Repository has a working `npm run build` that produces a valid, loadable Chrome extension in
  `dist/`
- Manifest V3 `manifest.json` is present with correct permissions declared
- TypeScript, ESLint, and Prettier are configured
- Directory structure is established for all planned components

**Todo List:**
1. Initialise `package.json` with a build script (Vite + `vite-plugin-web-extension`, or webpack
   — choose based on MV3 service-worker support)
2. Add TypeScript, `@types/chrome`, ESLint, Prettier
3. Create `manifest.json` declaring:
   - `permissions`: `storage`, `tabs`, `declarativeNetRequest`
   - `host_permissions`: the wxO SaaS hostname pattern (`*.watson-orchestrate.ibm.com/*`) plus
     `http://localhost/*` for the proxy
   - `background.service_worker`: points to the compiled background entry
   - `content_scripts`: matches wxO Agent Builder URL pattern
   - `action`: popup entry point
4. Create directory skeleton:
   ```
   src/
     background/      # service worker
     content/         # content script
     popup/           # popup panel UI
     proxy-server/    # local proxy (separate package or monorepo workspace)
     shared/          # types, constants, utilities shared across all
   ```
5. Verify `npm run build` loads without errors in `chrome://extensions`

**Relevant Context:**
- MV3 service workers cannot use `XMLHttpRequest`; all async work uses `fetch` and message passing
- `declarativeNetRequest` is the MV3 replacement for the old blocking `webRequest`; however,
  intercepting _response bodies_ still requires `webRequest` with `extraHeaders` — confirm which
  APIs are needed per Chrome's current policy before finalising the manifest permissions
- The extension will be side-loaded (no Chrome Web Store publishing required for v1)

**Toolchain decisions (recorded at completion of Sub-Task 1):**
- **Build tool:** Vite v5.4 + `@samrum/vite-plugin-web-extension` v4.0.1
  - Chosen over `aklinker1/vite-plugin-web-extension` because the `samrum` variant has explicit
    MV3 service-worker documentation and is not moving to maintenance mode
  - Confirmed: plugin rewrites `manifest.json` in `dist/` with correct resolved entry paths
    (`serviceWorker.js`, `src/content/index.js`, `src/popup/index.html`)
- **TypeScript:** v5.4, strict mode, `moduleResolution: bundler`
- **ESLint:** v9 flat config using `typescript-eslint` v8 (the unified package); `@typescript-eslint`
  v7 was rejected because it requires ESLint v8 — the v8 unified package supports ESLint v9
- **Prettier:** v3.2
- **Icons:** placed in `public/icons/` so Vite's static asset pipeline copies them to `dist/icons/`
  automatically without any extra copy plugin
- **`webRequest` vs `declarativeNetRequest`:** manifest currently declares `webRequest` (for
  Sub-Task 2's request body capture); `webRequestBlocking` was intentionally omitted from the
  MV3 manifest — MV3 does not support the blocking variant for ordinary extensions;
  `declarativeNetRequest` will be added in Sub-Task 2 if needed for redirect-based interception

**Status:** [x] done

**Recorded deviation from original draft:**
- Manifest permissions settled on `webRequest` rather than `declarativeNetRequest`
- Host permissions corrected to `*.watson-orchestrate.cloud.ibm.com/*`

---

### Sub-Task 2 — Network Interception Layer

**Intent:**
Implement the background service worker logic that intercepts wxO API responses and KB upload
requests, extracts the relevant data, and emits structured events to the assembler.

**Expected Outcomes:**
- Every relevant wxO REST response (agent GET, tool GET, connection GET) is captured as a typed
  object in the background script
- Every multipart KB document upload POST is intercepted; raw file bytes and filename are
  extracted before the request completes
- All captured data is emitted via the extension's internal message bus with a consistent event
  schema
- No credentials (API keys, tokens, passwords) appear in any captured payload — they are stripped
  at this layer

**Todo List:**
1. Define the set of wxO API endpoints to intercept. Starting set (confirm by inspecting browser
   DevTools against a live session):
   - `GET /v2/orchestrate/agents/unified` — agent list
   - `GET /v2/orchestrate/agents/{id}` — agent detail
   - `GET /v2/orchestrate/tools` — tool list
   - `GET /v2/orchestrate/tools/{id}` — tool detail including `app_id` and `expected_credentials`
   - `POST /v2/orchestrate/tools` — tool creation response (captures `app_id` association at
     creation time, which may not be present in subsequent GET responses)
   - `GET /v2/orchestrate/connections` — connection metadata list (must capture `kind`/type field,
     not just `app_id` name)
   - `GET /v2/orchestrate/connections/{id}` — connection detail
   - `GET /v2/orchestrate/knowledge-bases` — KB list
   - `GET /v2/orchestrate/knowledge-bases/{id}` — KB detail
   - `POST /v2/orchestrate/knowledge-bases/{id}/documents` — KB file upload
   - `POST /v2/orchestrate/tools` (multipart) — OpenAPI spec file upload; extract raw spec bytes
     in the same way as KB document uploads
2. Use `chrome.webRequest.onBeforeRequest` (with `requestBody`) to capture the multipart POST body
   for KB document uploads and OpenAPI spec uploads; decode the multipart boundary to extract raw
   file bytes and original filenames
3. Use `chrome.webRequest.onCompleted` + `fetch` re-request (or a content script `fetch`
   interceptor) to capture JSON response bodies for the GET and POST endpoints — note MV3 cannot
   read response bodies directly from the service worker via `webRequest`; evaluate whether a
   content script fetch interceptor (overriding `window.fetch`) or a `declarativeNetRequest`
   redirect approach is needed; resolve this before starting implementation
4. Implement a credential-scrubbing pass: before emitting any captured payload, strip any field
   matching a known secrets pattern (e.g. `api_key`, `token`, `password`, `client_secret`,
   `auth_config`, `Authorization` header values). Connections are captured as metadata only:
   `app_id`, `kind` (connection type such as API_KEY_AUTH, BASIC_AUTH, BEARER_TOKEN), and
   `server_url` — never the credential values themselves
5. Define and emit typed internal messages: `AGENT_CAPTURED`, `TOOL_CAPTURED`,
   `CONNECTION_CAPTURED`, `KB_META_CAPTURED`, `KB_FILE_CAPTURED`
6. Write unit tests for the credential scrubber and the multipart decoder

**Relevant Context:**
- MV3 `webRequest` can read `requestBody` for POST requests but cannot read response bodies —
  this is a known MV3 constraint; the content script fetch interceptor pattern (overriding
  `window.fetch`) is the most practical workaround
- The wxO SaaS UI authenticates via IBM IAM bearer tokens; those tokens will appear in
  `Authorization` headers — the credential scrubber must also suppress all header captures
- KB source documents and OpenAPI spec files are both uploaded as multipart/form-data; the
  boundary parser must handle both text and binary content
- The `app_id` association for an OpenAPI tool may be set at creation time (in the POST body or
  response) rather than appearing in subsequent GET responses — intercept both to be safe;
  confirm via DevTools inspection before finalising the endpoint list
- Connection capture must include the connection `kind` field (the authentication scheme type)
  alongside the `app_id` and `server_url`, as this is the information needed to reconstruct the
  connection on restore (without it the user cannot know which credential type to re-enter)

**Status:** [x] done

**Recorded deviations from original draft:**
- Endpoint list corrected to confirmed `mfe_builder/api/...` paths
- Response capture is implemented via content-script `fetch` interception, not `webRequest.onCompleted` re-fetching
- Auth model corrected from bearer-token assumptions to session cookie + `x-ibm-wo-csrf`
- KB document create/upload flow corrected: create is atomic POST; additional uploads are PUT
- Connections response envelope corrected from `resources` to `applications`
- Catalog tool source capture is not possible in the `create-from-template` path because the source is not transmitted to `mfe_builder`

---

### Sub-Task 3 — Snapshot Assembler and Debounce Engine

**Intent:**
Collect all events emitted by the interception layer, coalesce them into a complete in-memory
snapshot for the active agent, and trigger a save to the local proxy after a debounce window of
inactivity. This prevents a flood of network saves for every individual field edit.

**Expected Outcomes:**
- A single `AgentSnapshot` object is maintained per active agent session in the service worker
- Snapshot is rebuilt from all captured artefacts on every mutation
- A debounced save (default: 3 seconds after last mutation) sends the assembled snapshot to the
  local proxy
- The snapshot format matches the specified zip contents exactly
- The assembler can handle partial state (e.g. KB metadata arrived but documents have not yet
  been uploaded)

**Todo List:**
1. Define the `AgentSnapshot` TypeScript type:
   ```ts
   interface AgentSnapshot {
     schemaVersion: string;        // for future migration
     capturedAt: string;           // ISO timestamp
     tenant: string;               // extracted from the wxO URL/session
     agent: AgentDefinition;       // agent YAML equivalent as object
     tools: ToolArtifact[];        // see note on proactive fetching below
     knowledgeBases: KBSnapshot[]; // { meta: KBDefinition; files: FileBlob[] }
     connections: ConnectionMeta[]; // { app_id, kind, server_url } — no secrets ever
   }
   // ToolArtifact carries the app_id association alongside the source
   interface ToolArtifact {
     name: string;
     kind: 'python' | 'openapi' | 'mcp' | 'flow';
     app_id?: string;              // the connection app_id bound to this tool, if any
     expectedCredentials?: Array<{ app_id: string; type: string | string[] }>;
     source?: Uint8Array;          // raw file bytes (python .py or openapi .yaml)
     requirements?: string;        // requirements.txt content for python tools
     meta: object;                 // full tool GET response (minus any scrubbed fields)
   }
   ```
2. Implement the assembler as a stateful module in the background service worker that merges
   incoming events into the live snapshot
3. **Proactive tool detail fetching:** when the assembler receives an `AGENT_CAPTURED` event and
   sees tool names in the agent definition, it must check whether each tool already has a full
   `ToolArtifact` entry in the current snapshot. For any tool that is referenced by name but has
   no captured detail (i.e. it pre-existed in the platform and was never uploaded this session),
   the assembler must proactively issue an authenticated `GET /v2/orchestrate/tools/{name}` using
   the session bearer token observed from prior intercepted requests. This ensures pre-existing
   custom tools are fully captured, not just referenced by name
4. Implement a debounce timer (configurable, default 3 s); reset on every new event, fire
   `SNAPSHOT_READY` when it expires
5. On `SNAPSHOT_READY`, serialise the snapshot into the zip format (see Sub-Task 4) and POST it
   to the local proxy at `http://localhost:{port}/snapshots`
6. Store the last 5 snapshots in `chrome.storage.local` as lightweight index entries (no file
   bytes — just tenant, agent name, timestamp, and proxy URL) so the popup can list recent saves
   even if the proxy is temporarily unavailable
7. Detect the active tenant and agent name from the browser tab URL or from the captured agent
   payload

**Relevant Context:**
- MV3 service workers are ephemeral — they can be suspended; use `chrome.storage.session` for
  in-flight assembly state that must survive a brief suspension, and `chrome.storage.local` for
  the persisted index
- The debounce value should be user-configurable via the popup settings panel (Sub-Task 5)
- The proactive fetch in step 3 requires the assembler to track the last observed bearer token
  from intercepted request headers; this token is ephemeral and must be refreshed when the session
  renews — the assembler should always use the most recently seen token, never cache it long-term
- Pre-existing tools fetched proactively will return their metadata and `expected_credentials`
  from the API response; however their original source files (Python or OpenAPI spec) may or may
  not be returned by the API — if source is not available in the response, record what is available
  and flag the tool in the snapshot manifest as `sourceUnavailable: true` so the restore path can
  warn the user rather than silently failing

**Status:** [-] in progress

**Recorded deviations from original draft:**
- `AgentSnapshot` is now defined in `src/shared/index.ts` and the assembler is implemented in `src/background/assembler.ts`
- Agent PATCH with `toolsSelected[]` is the primary snapshot trigger, reducing the need for proactive tool detail fetching in the common path
- The current implementation persists in-flight assembly state in `chrome.storage.session`
- `SNAPSHOT_READY` bus emission is now implemented (commit `2856cad`)
- Zip serialisation is now implemented via `src/shared/zip.ts` (Sub-Task 4 complete)
- The current implementation does **not yet** POST to the proxy or maintain the recent-snapshot index in `chrome.storage.local`

---

### Sub-Task 4 — Zip Serialiser and Snapshot Format

**Intent:**
Define the exact zip archive structure and implement the serialisation/deserialisation logic that
both the extension and the proxy share.

**Expected Outcomes:**
- A `buildZip(snapshot: AgentSnapshot): Uint8Array` function produces a deterministic,
  self-contained zip
- A `parseZip(bytes: Uint8Array): AgentSnapshot` function restores the full snapshot object
- The zip structure matches the agreed format
- The shared serialiser is usable by both the extension (in the browser) and the proxy (in Node/
  Python)

**Todo List:**
1. Define the zip internal layout:
   ```
   manifest.json              # snapshot metadata: schema version, timestamp, agent name, tenant
                              # also contains: restore_warnings[] for any sourceUnavailable tools
   agent/
     agent.yaml               # agent definition
   tools/
     {tool-name}/
       tool.json              # tool metadata: name, kind, app_id, expectedCredentials, sourceUnavailable flag
       source.py | spec.yaml  # tool source or OpenAPI spec (absent if sourceUnavailable)
       requirements.txt       # if Python tool
   knowledge_bases/
     {kb-name}/
       kb.yaml                # KB spec
       documents/
         {filename}           # raw source document bytes
   connections/
     {connection-name}.yaml   # connection metadata: app_id, kind, server_url — no secrets
   ```
2. Implement `buildZip` using `fflate` (browser-compatible, zero-dependency zip library) in the
   extension; the proxy can use its native zip tooling
3. Implement `parseZip` for the proxy's restore path
4. Write round-trip tests: `parseZip(buildZip(snapshot))` must deep-equal the original
5. Version the schema via `manifest.json#schemaVersion` so future format changes can be migrated

**Relevant Context:**
- `fflate` is the recommended choice for MV3 service workers because it is pure JS and does not
  require Node APIs
- The zip must be deterministic (stable file ordering) so that identical snapshots produce
  identical zips for deduplication purposes

**Status:** [ ] pending

---

### Sub-Task 5 — Popup Panel UI

**Intent:**
Build the browser extension popup that gives the user visibility into autosave activity and lets
them browse snapshot history and initiate a restore.

**Expected Outcomes:**
- Popup opens when the user clicks the extension icon
- Shows the current agent name, last-saved timestamp, and save status (saving/saved/error)
- Lists all snapshots for the current agent from the proxy (paginated if many)
- "Restore" button on any snapshot row triggers a restore request to the proxy
- Settings panel: configurable debounce delay, proxy port, and bucket path prefix
- Works without any framework bloat — vanilla TS + minimal CSS or a lightweight UI library

**Todo List:**
1. Create `popup.html` and `popup.ts` entry points
2. Implement the "current session" status card: agent name, save indicator, last-saved time
3. Implement the snapshot history list: fetch `GET http://localhost:{port}/snapshots?agent={name}`
   from the proxy, render each row with timestamp and a "Restore" button
4. Implement the restore trigger:
   a. Before showing the Restore button as active, POST
      `http://localhost:{port}/restore/preflight` with the snapshot key to fetch a pre-restore
      report from the proxy: which connections need re-credentialing (app_id + kind for each),
      and which tools are flagged `sourceUnavailable`
   b. Render a **credentials checklist** in the popup before the user confirms: one row per
      connection showing `app_id` and `kind` (e.g. "my-salesforce-conn — API_KEY_AUTH"), with
      a note that credentials must be re-entered after restore. For `sourceUnavailable` tools,
      show a warning that the source file could not be captured and the tool will not be restored
   c. Only after the user acknowledges the checklist, POST
      `http://localhost:{port}/restore` with the snapshot key; show streaming progress and final
      result per artefact
5. Implement the settings panel (stored in `chrome.storage.sync`):
   - Proxy port (default: 7878)
   - Debounce delay in seconds
   - Bucket path prefix override
6. Handle the "proxy offline" state gracefully — show the locally cached index from
   `chrome.storage.local` with a warning that restore is unavailable

**Relevant Context:**
- The popup runs in a separate renderer context from the service worker; all data must flow
  through `chrome.runtime.sendMessage` / `chrome.storage`
- Keep the popup bundle small — it has no access to Node APIs

**Status:** [ ] pending

---

### Sub-Task 6 — Local Proxy Server

**Intent:**
Build the local HTTP server that acts as the secure bridge between the extension and object
storage. It holds COS credentials, accepts snapshot POSTs from the extension, stores zips in the
bucket, and serves the history list and restore trigger endpoints.

**Expected Outcomes:**
- Server starts on a configurable port (default 7878) with a single command
- `POST /snapshots` — accepts a zip binary body, derives the bucket key from the included
  `manifest.json`, uploads to IBM COS, returns 201 with the object key
- `GET /snapshots?agent={name}&tenant={tenant}` — lists all snapshot objects in the bucket for
  the given agent, returns JSON array of `{ key, timestamp, size }`
- `POST /restore` — accepts `{ key }`, downloads the zip from COS, unpacks it to a temp
  directory, calls the ADK CLI (or MCP tools) to re-import all artefacts in the correct order,
  returns 200 with a structured result log
- Credentials are read from environment variables or a local config file — never from the
  extension or the browser
- CORS is restricted to `chrome-extension://{extension-id}` only

**Todo List:**
1. Scaffold the proxy server project (tech stack TBD — note: Node/Express, Python/FastAPI, and
   Go/chi are all viable; choose at implementation time based on team preference)
2. Implement `POST /snapshots`: receive binary body, parse `manifest.json` from the zip to extract
   tenant/agent-name/timestamp for the bucket key, upload to IBM COS S3-compatible API
3. Implement `GET /snapshots`: list objects in the bucket under the `{tenant}/{agent-name}/`
   prefix using the COS S3 API (`ListObjectsV2`)
4. Implement `GET /restore/preflight?key={zip-key}`:
   a. Download and unpack the zip from COS (or use a local cache if recently downloaded)
   b. Parse every `tools/{name}/tool.json` to collect all `app_id` + `expectedCredentials`
      entries and any `sourceUnavailable` flags
   c. Parse every `connections/{name}.yaml` to collect `app_id` and `kind`
   d. Return a structured preflight report:
      ```json
      {
        "connections_to_recredential": [
          { "app_id": "my-salesforce-conn", "kind": "API_KEY_AUTH", "server_url": "..." }
        ],
        "tools_source_unavailable": ["legacy-crm-tool"],
        "restore_order": ["connections", "tools", "knowledge_bases", "agent"]
      }
      ```
5. Implement `POST /restore`:
   a. Download the requested zip from COS
   b. Unpack to a temp directory following the layout from Sub-Task 4
   c. For each Python tool source file, statically parse `expected_credentials` from the
      `@tool` decorator using a regex or AST parse; cross-check against the `tool.json` entry
      to ensure the `--app-id` flag is passed correctly on import
   d. Run ADK CLI commands in the correct dependency order:
      1. `orchestrate connections import` for each connection yaml (creates the connection
         shape; user must re-enter credentials separately via UI or CLI — this is expected)
      2. `orchestrate tools import` for each tool that has source available, passing
         `--app-id {app_id}` where declared; skip `sourceUnavailable` tools and log a warning
      3. `orchestrate knowledge-bases import` for each KB yaml, then upload documents
      4. `orchestrate agents import` for the agent yaml
   e. Return a structured log of each step (success/failure/skipped per artefact)
5. Add IBM COS credential configuration: read `COS_ENDPOINT`, `COS_API_KEY`, `COS_BUCKET`,
   `COS_INSTANCE_CRN` from environment; add a thin adapter interface so AWS S3, GCP GCS, and
   Azure Blob can be plugged in later without changing the rest of the proxy
6. Add a `README.md` explaining how to start the proxy and configure credentials

**Relevant Context:**
- IBM COS is S3-compatible; the AWS SDK v3 (`@aws-sdk/client-s3`) works against COS with a
  custom `endpoint` — this is the recommended client regardless of tech stack
- The ADK CLI must be installed and authenticated (`orchestrate env activate`) on the same machine
  as the proxy; the proxy shells out to the CLI or calls the MCP tools programmatically
- The restore import order matters: connections must exist before tools that depend on them, tools
  before the agent that references them, and KBs before the agent that references them

**Status:** [ ] pending

---

### Sub-Task 7 — Integration Testing and End-to-End Validation

**Intent:**
Validate the full capture-store-restore round-trip against a real (or dev-edition) wxO instance
before considering the project complete.

**Expected Outcomes:**
- A test scenario document describes the manual or automated steps to verify each component
- The extension captures a complete snapshot when an agent with tools, KBs, and connections is
  created in the wxO UI
- The snapshot zip is correctly stored in COS
- The restore flow re-imports all artefacts into a clean wxO environment with no manual
  intervention beyond clicking "Restore" in the popup
- Edge cases are documented: proxy offline, partial KB upload, connection with no documents

**Todo List:**
1. Document the test scenario: environment requirements (wxO SaaS tenant, local ADK CLI,
   running proxy, COS bucket)
2. Create a sample agent with at least one Python tool, one KB with two source documents, and
   one connection (metadata only) to serve as the test fixture
3. Capture a snapshot end-to-end and inspect the zip contents manually
4. Validate the proxy's `/snapshots` list endpoint returns the snapshot
5. Run the restore to a fresh environment and confirm all four artefact types are re-created
6. Test the "proxy offline" UI state in the popup
7. Document any wxO API endpoint changes that would break the interception layer (as a
   maintenance note)

**Relevant Context:**
- wxO SaaS API paths should be confirmed against a live session using browser DevTools before
  Sub-Task 2 begins — the paths listed in Sub-Task 2 are best-effort based on public ADK docs
  and may differ in the live UI
- The wxO Developer Edition (local Docker) can be used for integration testing without a SaaS
  account

**Status:** [ ] pending

---

## Open Decisions

| Decision | Options | Notes |
|---|---|---|
| Proxy server tech stack | Node/Express, Python/FastAPI, Go/chi | Defer to implementation; no functional dependency |
| Response body interception strategy | Content script `fetch` proxy vs. offscreen document vs. other | Must be resolved in Sub-Task 2; MV3 constraint |
| Extension build tooling | Vite + vite-plugin-web-extension vs. webpack + copy-webpack-plugin | Vite is simpler; confirm MV3 service worker support |
| Proxy authentication | None (localhost only) vs. shared secret header | Localhost-only is sufficient for v1 |

---

## Dependency Order

```
Sub-Task 1 (Scaffold)
  └─> Sub-Task 2 (Network Interception)
        └─> Sub-Task 3 (Snapshot Assembler)
              ├─> Sub-Task 4 (Zip Serialiser)   ← also feeds Sub-Task 6
              └─> Sub-Task 5 (Popup UI)
  └─> Sub-Task 6 (Local Proxy)
        └─> Sub-Task 7 (Integration Testing)
```
