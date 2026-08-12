# wxO Agent Builder — Backup & Recovery: Project Requirements

> **Status:** v1.2 — updated to reflect completed v1 implementation (Aug 2026)
> **Maintainer:** @dbenner
> **Repo:** [wxO Backup Recovery Patterns](https://github.com/dbenner/wxo-backup-recovery-patterns)
> **Contributions welcome:** Please open an Issue or PR. See [Contributing](#contributing) for guidance.

---

## Change Log

| Version | Date | Summary |
|---|---|---|
| v1.0 | Aug 2026 | Initial draft — endpoints derived from ADK documentation and plan assumptions |
| v1.1 | Aug 2026 | **API corrections from 4 live HAR recordings.** All endpoint paths updated to confirmed values. Auth model corrected. KB paths fully revised. Proactive fetch requirement revised. See [§ Deviations from v1.0](#deviations-from-v10-confirmed-by-har-analysis) for a full summary of changes. |
| v1.2 | Aug 2026 | **Implementation complete.** All 7 sub-tasks shipped. Proxy technology resolved to Node.js TypeScript. COS/S3/GCS adapters shipped; Google Drive and Azure Blob deferred to follow-up. `SNAPSHOT_READY` bus wiring complete. FR-4.5 corrected: IBM COS uses HMAC credentials (`COS_ACCESS_KEY_ID` / `COS_SECRET_ACCESS_KEY`), not `COS_API_KEY`. OD-1, OD-2, OD-3 closed. Contributing section updated to reflect current repo layout. See [§ Implementation Record](#12-implementation-record) for a full summary. |

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Vision](#2-vision)
3. [Personas & Stakeholders](#3-personas--stakeholders)
4. [Scope](#4-scope)
5. [Architecture Overview](#5-architecture-overview)
6. [Functional Requirements](#6-functional-requirements)
   - [FR-1 Passive Capture](#fr-1-passive-capture)
   - [FR-2 Credential Safety](#fr-2-credential-safety)
   - [FR-3 Snapshot Format](#fr-3-snapshot-format)
   - [FR-4 Storage](#fr-4-storage)
   - [FR-5 Restore](#fr-5-restore)
   - [FR-6 Popup UI](#fr-6-popup-ui)
   - [FR-7 Local Proxy Server](#fr-7-local-proxy-server)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [Security Requirements](#8-security-requirements)
9. [Constraints & Boundaries](#9-constraints--boundaries)
10. [Open Decisions](#10-open-decisions)
11. [Deviations from v1.0](#11-deviations-from-v10-confirmed-by-har-analysis)
12. [Implementation Record](#12-implementation-record)
13. [Glossary](#13-glossary)
14. [Contributing](#14-contributing)

---

## 1. Problem Statement

IBM watsonx Orchestrate (wxO) gives agent builders a powerful UI to compose agents from tools, knowledge bases, and connections. **However, the UI currently provides no backup or version history.** If an agent definition is accidentally overwritten, if a tool is deleted, or if a team needs to migrate an agent to a new tenant or environment, the builder must manually recreate all artefacts from scratch.

The wxO ADK CLI can import and export agents programmatically, but it is a technical tool that requires developers to know what to export and when to do it. There is no passive, automatic safety net for UI builders who may not be running the CLI alongside every session.

**The gap this project fills:** an always-on safety net that silently captures every meaningful change made in the wxO Agent Builder UI and stores a versioned, restorable snapshot — with zero extra steps from the builder.

---

## 2. Vision

> *Every agent built in the wxO UI should be automatically versioned and recoverable in one click, with no change to the builder's workflow.*

The solution is a **Chrome/Edge browser extension** (Manifest V3) paired with a **local proxy server**. Together they form a passive capture-and-restore pipeline:

- The extension observes every relevant wxO API call in the background, assembles a complete snapshot of the active agent and all its dependencies, and transmits it to the local proxy.
- The proxy stores versioned snapshot archives in a user-configured storage backend: IBM Cloud Object Storage, AWS S3, or GCP Cloud Storage (v1); Google Drive and Azure Blob are planned for a follow-up.
- The extension popup lets the builder browse snapshot history and restore any prior state with a single click.

The restore is executed by the proxy using the **ADK CLI** — the same tooling watsonx Orchestrate already uses for CI/CD — so the restored agent is identical to what the ADK would have imported by hand.

---

## 3. Personas & Stakeholders

| Persona | Description | Primary Need |
|---|---|---|
| **Agent Builder** | A non-technical or semi-technical user designing agents in the wxO UI | Zero-friction backup and recovery — no CLI, no manual steps |
| **Platform Engineer** | Sets up and maintains the local proxy and bucket credentials | Simple setup, no credential leakage risk, scriptable operations |
| **Enterprise Admin** | Manages multiple wxO tenants or team environments | Audit trail of agent changes; ability to replicate agents across tenants |
| **Open Source Contributor** | Community developer contributing features or fixes | Clear requirements, documented design decisions, testable scope |

---

## 4. Scope

### In Scope — v1

- Chrome and Edge browsers only (Manifest V3)
- Passive, zero-configuration capture: the builder changes nothing about how they work
- Versioned zip snapshots stored in a pluggable storage backend: IBM COS (default), AWS S3, or GCP Cloud Storage
- One-click restore to the same or a different wxO environment via the local proxy
- Support for all four agent artefact types: **agent definitions**, **tools** (Python and OpenAPI), **knowledge bases** (including uploaded source documents), and **connections** (metadata only — never credentials)
- Local proxy server implemented in **Node.js TypeScript** (runs on the builder's machine)
- Side-load deployment only (no Chrome Web Store publishing required for v1)

### Out of Scope — v1

- Firefox support
- Snapshot diff / merge between versions
- Multi-tenant concurrent sessions in the same browser
- Cloud-hosted proxy
- Syncing credentials during restore (the builder re-enters credentials; the system captures connection shape only)
- Automated migration between wxO API versions
- **Google Drive storage adapter** — deferred to follow-up; the `StorageAdapter` interface is fully specified, and `STORAGE_PROVIDER=gdrive` returns a clear unsupported error
- **Azure Blob storage adapter** — deferred to follow-up; same interface contract applies

### Out of Scope — v1 (clarified in implementation)

- `debounceMs` setting wiring from popup into the assembler — the popup saves the value to `chrome.storage.sync` but the assembler still reads `DEBOUNCE_DEFAULT_MS` (3 s); this is a straightforward follow-up
- Chrome Web Store distribution (OD-6)

---

## 5. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Chrome / Edge Browser                                       │
│                                                              │
│  ┌─────────────────────┐    chrome.runtime.sendMessage       │
│  │  Content Script     │──────────────────────────────────┐  │
│  │  (fetch interceptor)│                                  │  │
│  └─────────────────────┘                                  ▼  │
│                                         ┌──────────────────┐ │
│  ┌─────────────────────┐  webRequest    │  Background SW   │ │
│  │  wxO Agent Builder  │──(POST/PUT)───▶│  (MV3 service    │ │
│  │  SaaS UI            │                │   worker)        │ │
│  └─────────────────────┘                │  - Assembler     │ │
│                                         │  - Debounce      │ │
│  ┌─────────────────────┐                │  - Zip builder   │ │
│  │  Extension Popup    │◀───────────────│  - SNAPSHOT_READY│ │
│  │  (History & Restore)│  chrome.storage│    bus emit      │ │
│  └─────────────────────┘                └──────────────────┘ │
│                                                  │           │
│                                                  │ POST /snapshots
└──────────────────────────────────────────────────┼───────────┘
                                                   │ http://localhost:7878
                                        ┌──────────▼──────────┐
                                        │  Local Proxy Server │
                                        │  (Node.js TypeScript│
                                        │   no framework)     │
                                        │  - Storage upload   │
                                        │  - Restore via ADK  │
                                        └──────────┬──────────┘
                                                   │
                              ┌────────────────────▼──────────────┐
                              │  Storage Backend (pluggable)      │
                              │  IBM COS / AWS S3 / GCP GCS       │
                              │  {tenant}/{agent}/{timestamp}.zip │
                              └───────────────────────────────────┘
```

**Data flow summary:**

1. Builder uses the wxO Agent Builder UI normally.
2. The content script's `fetch` interceptor captures every JSON response from wxO API endpoints of interest, as well as multipart request bodies for KB document uploads.
3. The `chrome.webRequest.onBeforeRequest` listener in the background service worker provides a complementary capture path for multipart POST and PUT bodies.
4. All captured events flow to the **Snapshot Assembler** in the background service worker, which coalesces them into a single `AgentSnapshot` object.
5. After 3 seconds of inactivity (debounced), the assembler serialises the snapshot into a zip archive and POSTs it to the local proxy at `http://localhost:7878/snapshots`.
6. The proxy derives the storage path (`{tenant}/{agent-name}/{ISO-timestamp}.zip`), uploads the zip to the configured storage backend, and responds with the stored object key or file ID.
7. The extension popup queries the proxy's `/snapshots` endpoint to list available snapshots and can initiate a restore via `/restore`.
8. On restore, the proxy downloads the zip from the configured storage backend, unpacks it to a temp directory, and runs the ADK CLI to re-import artefacts in dependency order.

---

## 6. Functional Requirements

### FR-1 Passive Capture

> **Note — v1.1 update:** All endpoint paths in FR-1 have been corrected from the original draft to reflect confirmed values from 4 live HAR recordings. See [§ Deviations from v1.0](#11-deviations-from-v10-confirmed-by-har-analysis) for the full mapping of old → new paths.

| ID | Requirement |
|---|---|
| FR-1.1 | The extension MUST capture agent definitions from `GET /mfe_builder/api/v2/builder/agents` (list, minimal fields) and `GET /mfe_builder/api/v1/builder/orchestrate/agents/{uuid}` (full detail) responses without any builder action. |
| FR-1.2 | The extension MUST capture the full agent state from `PATCH /mfe_builder/api/v1/builder/orchestrate/agents/{uuid}` responses, which include `toolsSelected[]` with complete tool binding objects. This PATCH response is the richest single capture point and is the primary snapshot trigger. |
| FR-1.3 | The extension MUST capture tool metadata from `GET /mfe_builder/api/v2/builder/tools?ids={uuid}&ids={uuid}&...` (batch-fetch by UUID list). The response is a bare JSON array. |
| FR-1.4 | The extension MUST capture connection metadata from `GET /mfe_builder/api/v1/orchestrate/connections/applications`. The response envelope is `{ applications: [...] }` — not `{ resources: [...] }`. |
| FR-1.5 | The extension MUST capture knowledge base metadata from `GET /mfe_builder/api/v1/orchestrate/knowledge-bases/{uuid}`. |
| FR-1.6 | The extension MUST capture raw file bytes and filenames from the multipart `POST /mfe_builder/api/v1/orchestrate/knowledge-bases/documents` request body. This single request both creates the KB and uploads the first document; the KB UUID is returned in the `201` response body (`knowledge_base` field) rather than in the URL. The assembler MUST correlate pending file bytes with the UUID from the response. |
| FR-1.7 | The extension MUST capture raw file bytes and filenames from the multipart `PUT /mfe_builder/api/v1/orchestrate/knowledge-bases/{uuid}/documents` request body. Note: the method is `PUT`, not `POST`. |
| FR-1.8 | The extension MUST capture raw spec file bytes and filenames from multipart `POST /mfe_builder/api/v2/builder/tools` uploads (hand-crafted Python/OpenAPI tools only). Catalog tools added via the UI use a JSON `POST /mfe_builder/api/v1/builder/tools/create-from-template` request; their source files reside in S3 and are NOT transmitted to the mfe_builder API. For catalog tools, the snapshot records metadata and binding only, and sets `sourceUnavailable: true`. |
| FR-1.9 | For any tool whose source file cannot be obtained from the API, the snapshot MUST record a `sourceUnavailable: true` flag in the tool's metadata so that the restore path can warn the builder rather than silently failing. |
| FR-1.10 | The capture pipeline MUST be fully transparent: it MUST NOT alter any request or response observed by the wxO UI in any way. |
| FR-1.11 | The assembler MUST debounce snapshot saves; the debounce window MUST default to 3 seconds after the last captured event and MUST be user-configurable. **Implementation note:** the default 3-second window is implemented and wired to `DEBOUNCE_DEFAULT_MS`. The user-configurable wiring from popup settings into the assembler is deferred to a follow-up. |
| FR-1.12 | The background service worker MUST track the most recently observed `x-ibm-wo-csrf` header value in ephemeral memory (never persisted to any storage). ~~This is an IBM IAM bearer token~~ — **correction**: the wxO SaaS UI authenticates via session cookie plus `x-ibm-wo-csrf` header; there is no `Authorization: Bearer` header on UI requests. The CSRF token is session-scoped only and is captured solely for use in any proactive assembler API calls within the same browser session. |
| FR-1.13 | The following high-frequency polling endpoints MUST NOT be captured: `GET .../agents/{uuid}/environment`, `GET .../knowledge-bases/{uuid}/status`. Capturing them would generate excessive noise with no useful snapshot data. |

---

### FR-2 Credential Safety

| ID | Requirement |
|---|---|
| FR-2.1 | The extension MUST NEVER capture, store, log, or transmit credential values. This includes API keys, bearer tokens, passwords, client secrets, OAuth tokens, and any value stored under a key matching the credential pattern (see FR-2.4). |
| FR-2.2 | Connection artefacts MUST be captured as metadata only: `app_id` (the connection name/identifier), `kind` (the authentication scheme type — see FR-2.6), and `server_url` if present. All other connection fields MUST be dropped. |
| FR-2.3 | A credential scrubber MUST run on every captured payload before the payload is stored, emitted, or forwarded. The scrubber MUST be applied in both the content script (first pass) and the background service worker (second pass, defence-in-depth). |
| FR-2.4 | The scrubber MUST redact any key (case-insensitive, ignoring `-` and `_` separators) that matches: `api_key`, `apikey`, `token`, `password`, `passwd`, `client_secret`, `clientsecret`, `auth_config`, `authorization`, `secret`, `access_token`, `refresh_token`, `id_token`, `private_key`, `credential`, `credentials`. |
| FR-2.5 | The local proxy MUST read storage credentials exclusively from environment variables or a local config file on the proxy host machine — never from the extension, the browser, or any network-transmitted payload. |
| FR-2.6 | The connection `kind` field MUST be populated from the `security_scheme` field of the connections API response (confirmed values: `api_key_auth`, `basic_auth`, `bearer_token`, `key_value_creds`, `oauth2`). For MCP toolkit connections, `security_scheme` is `null` and `kind` MUST be recorded as an empty string — the `server_url` field still provides meaningful restore context in this case. |
| FR-2.7 | The proxy CORS configuration MUST restrict requests to the extension's own origin (`chrome-extension://{extension-id}`) only. |

---

### FR-3 Snapshot Format

| ID | Requirement |
|---|---|
| FR-3.1 | Each snapshot MUST be a single zip archive with the following internal structure: |

```
manifest.json                   # snapshot metadata: schema version, timestamp,
                                # agent name, tenant, restore_warnings[]
agent/
  agent.yaml                    # agent definition (ADK-compatible YAML)
tools/
  {tool-name}/
    tool.json                   # tool metadata: name, kind, app_id,
                                # expectedCredentials, sourceUnavailable flag
    source.py | spec.yaml       # tool source or OpenAPI spec (absent if sourceUnavailable)
    requirements.txt            # if Python tool with dependencies
knowledge_bases/
  {kb-name}/
    kb.yaml                     # knowledge base spec (ADK-compatible YAML)
    documents/
      {filename}                # raw source document bytes (binary-safe)
connections/
  {connection-name}.yaml        # connection metadata: app_id, kind, server_url only
```

| ID | Requirement |
|---|---|
| FR-3.2 | The zip archive MUST be deterministic: identical snapshots MUST produce byte-for-byte identical zips (stable file ordering) to enable deduplication at the storage layer. **Implementation note:** `fflate` `zipSync` with per-file `mtime` pinned to `snapshot.capturedAt` achieves determinism. |
| FR-3.3 | The `manifest.json` MUST include a `schemaVersion` field so that future format changes can be detected and migrated. The initial version is `"1.0"`. |
| FR-3.4 | The `manifest.json` MUST include a `restore_warnings` array listing any tool names where `sourceUnavailable` is true, so that the restore UI can surface them before the builder confirms. |
| FR-3.5 | The zip serialiser (`buildZip`) MUST be implemented using a browser-compatible, pure-JS library (`fflate` is the reference choice) so it can run inside the MV3 service worker without Node APIs. **Implemented:** `src/shared/zip.ts` using `fflate`. |
| FR-3.6 | The zip deserialiser (`parseZip`) MUST be implemented on the proxy side and MUST produce an object that round-trips through `buildZip → parseZip` with deep equality. **Implemented:** `wxo-autosave-proxy/src/zip.ts`. |
| FR-3.7 | The snapshot's `AgentSnapshot` TypeScript type MUST be defined in the `src/shared/` directory so it is usable by both the extension and the proxy-server package. **Implemented:** `src/shared/index.ts`. |
| FR-3.8 | **Implementation note — YAML files are JSON-encoded:** `.yaml` files in the zip (agent, tool, kb, connection) are serialised as JSON rather than YAML-formatted text. JSON is valid YAML 1.2 and the ADK CLI accepts it. This avoids a YAML serialiser dependency in the MV3 service worker. |

---

### FR-4 Storage

| ID | Requirement |
|---|---|
| FR-4.1 | The proxy MUST store each snapshot zip using the logical path: `{tenant}/{agent-name}/{ISO-8601-timestamp}.zip`, interpreted appropriately by each storage adapter (as an object key for S3-compatible stores; as a nested folder path for Google Drive). |
| FR-4.2 | The proxy MUST implement a **storage adapter interface** with at minimum one concrete adapter shipped in v1: an **S3-compatible adapter** covering IBM COS, AWS S3, and GCP Cloud Storage (using the AWS SDK v3 `@aws-sdk/client-s3` with a configurable `endpoint`). A **Google Drive adapter** is specified here but deferred to a follow-up (see note below). |
| FR-4.3 | The storage adapter interface MUST define the following operations: `upload(path, bytes) → id`, `download(id) → bytes`, `list(prefix) → { id, path, timestamp, size }[]`, and `delete(id)`. All other proxy logic MUST depend only on this interface, never on a concrete adapter. |
| FR-4.4 | The active storage backend MUST be selected via a `STORAGE_PROVIDER` environment variable or config file key. Valid values in v1: `cos`, `s3`, `gcs`. The value `gdrive` MUST be accepted but MUST return a clear unsupported error until the adapter is implemented. |
| FR-4.5 | For the S3-compatible adapter, credentials MUST be read from environment variables or a local config file, never hardcoded. **v1.2 correction from v1.1:** IBM COS requires HMAC credentials — `COS_ACCESS_KEY_ID` and `COS_SECRET_ACCESS_KEY` (not `COS_API_KEY`). When `COS_INSTANCE_CRN` is set, the `ibm-service-instance-id` header is injected automatically via AWS SDK middleware. Standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` are used for AWS S3. GCS uses an S3-compatible endpoint (`storage.googleapis.com`) with GCS HMAC credentials. |
| FR-4.6 | For the Google Drive adapter (deferred): (a) the proxy MUST implement the OAuth 2.0 authorization code flow using a Google Cloud project's client ID and secret, stored in environment variables (`GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`); (b) the resulting OAuth tokens MUST be persisted to a local token cache file (path configurable, default `~/.wxo-autosave/gdrive-token.json`) and refreshed automatically using the refresh token; (c) on first run with `gdrive` provider, the proxy MUST print an authorization URL for the user to visit and accept a callback code, completing the one-time auth flow; (d) snapshots MUST be stored in a Google Drive folder named `wxo-autosave` (created automatically if absent), with subfolders mirroring the `{tenant}/{agent-name}/` path structure. |
| FR-4.7 | The extension MUST maintain a local index of the most recent 5 snapshots in `chrome.storage.local` (tenant, agent name, timestamp, and proxy URL only — no file bytes) so that the popup can display recent history even when the proxy is temporarily offline. **Implemented:** `RECENT_SNAPSHOTS_KEY` in `src/shared/index.ts`; written by `appendRecentSnapshot()` in the assembler on each successful proxy POST. |
| FR-4.8 | In-flight assembly state in the background service worker MUST be persisted to `chrome.storage.session` (not in-memory only) so that brief MV3 service worker suspensions do not lose a partially assembled snapshot. **Implemented:** `agentSnapshots` and `pendingKbFiles` storage keys in the assembler. |

---

### FR-5 Restore

| ID | Requirement |
|---|---|
| FR-5.1 | The proxy MUST provide a `GET /restore/preflight?key={zip-key}` endpoint that returns a structured report before any restore action is taken. |
| FR-5.2 | The preflight report MUST include: (a) a list of connections that will need credential re-entry after restore, with `app_id` and `kind` for each; (b) a list of tools flagged `sourceUnavailable`; (c) the planned restore order. |
| FR-5.3 | The proxy MUST provide a `POST /restore` endpoint that accepts a snapshot key and executes the full restore via ADK CLI commands. |
| FR-5.4 | The restore MUST execute artefacts in the following dependency order to satisfy the ADK import requirements: (1) connections, (2) tools, (3) knowledge bases, (4) agent definition. |
| FR-5.5 | For each connection, the proxy MUST run `orchestrate connections import` to recreate the connection shape. The builder is expected to re-enter credentials via the wxO UI after restore — this is by design, not a defect. |
| FR-5.6 | For each tool that has a source file, the proxy MUST run `orchestrate tools import` and MUST pass `--app-id {app_id}` when the tool's `tool.json` records an `app_id`. |
| FR-5.7 | For each tool flagged `sourceUnavailable`, the proxy MUST skip that tool and include a warning in the restore result log. |
| FR-5.8 | For each knowledge base, the proxy MUST run `orchestrate knowledge-bases import` and then upload all captured documents. |
| FR-5.9 | For the agent definition, the proxy MUST run `orchestrate agents import`. |
| FR-5.10 | The `POST /restore` endpoint MUST return a structured result log containing the status (success, skipped, or failed) of every artefact processed. |
| FR-5.11 | The restore MUST be idempotent: re-running a restore for the same snapshot MUST NOT create duplicate artefacts if the artefacts already exist in the environment. |

---

### FR-6 Popup UI

| ID | Requirement |
|---|---|
| FR-6.1 | The extension popup MUST display the name of the currently active agent (derived from the browser tab URL or from a captured agent payload). |
| FR-6.2 | The popup MUST display the last-saved timestamp and a save status indicator (saving / saved / error). |
| FR-6.3 | The popup MUST list all available snapshots for the current agent by querying `GET http://localhost:{port}/snapshots?agent={name}`, showing timestamp and size for each. |
| FR-6.4 | Each snapshot row MUST include a "Restore" button. Clicking it MUST first call `GET /restore/preflight` and render the preflight report before any restore action is taken. |
| FR-6.5 | The preflight display MUST show: one row per connection requiring re-credentialing (showing `app_id` and `kind`), and a warning for any `sourceUnavailable` tools. The builder MUST explicitly acknowledge this list before the restore proceeds. |
| FR-6.6 | After the builder confirms, the popup MUST POST to `/restore` and display streaming progress and the final per-artefact result log. |
| FR-6.7 | The popup MUST include a settings panel (stored in `chrome.storage.sync`) with: configurable proxy port (default `7878`), debounce delay in seconds, storage path prefix override, and a read-only display of the active storage provider reported by the proxy. |
| FR-6.8 | When the local proxy is offline, the popup MUST fall back to the locally cached snapshot index from `chrome.storage.local` and display a warning that live history and restore are unavailable. |
| FR-6.9 | The popup bundle MUST NOT include any server-side Node APIs and MUST be kept as small as practical (no heavy UI framework required). |

---

### FR-7 Local Proxy Server

| ID | Requirement |
|---|---|
| FR-7.1 | The proxy MUST start with a single command and listen on a configurable port (default `7878`). **Implemented:** `npm start` in `wxo-autosave-proxy/` runs via Node 22 `--experimental-strip-types` (no compile step). |
| FR-7.2 | `POST /snapshots` — accept a zip binary body, parse the embedded `manifest.json` to derive the storage path, upload via the active storage adapter, return HTTP 201 with `{ key, provider }` where `provider` identifies the backend used. |
| FR-7.3 | `GET /snapshots?agent={name}&tenant={tenant}` — list all snapshot objects under the `{tenant}/{agent-name}/` prefix; return a JSON array of `{ key, timestamp, size }`. |
| FR-7.4 | `GET /restore/preflight?key={zip-key}` — see FR-5.1 and FR-5.2. |
| FR-7.5 | `POST /restore` — see FR-5.3 through FR-5.10. Progress is streamed as NDJSON lines so the popup can render live status. |
| FR-7.6 | The proxy MUST enforce CORS such that only `chrome-extension://{extension-id}` origins are accepted. |
| FR-7.7 | The proxy MUST read all storage and ADK configuration from environment variables or a local config file. |
| FR-7.8 | The proxy MUST include a `README.md` with installation instructions, environment variable reference, and a start command. **Implemented:** `wxo-autosave-proxy/README.md`. |
| FR-7.9 | The proxy MUST require that the wxO ADK CLI is installed and authenticated (`orchestrate env activate`) on the same machine before restore operations can run. **Implemented:** `validateAdkCli()` is called at startup and exits with a clear error if the CLI is absent or unauthenticated. |

---

## 7. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | **Transparency** | The extension MUST be a passive observer. It MUST NOT modify any request, delay any response, or in any way alter the behaviour of the wxO Agent Builder UI. |
| NFR-2 | **Performance** | Network interception and event dispatch MUST add no perceptible latency to wxO UI interactions. The debounce mechanism ensures that snapshot assembly and zip serialisation happen out-of-band. |
| NFR-3 | **Reliability** | The extension MUST continue to function correctly after MV3 service worker suspension events. In-flight assembly state MUST be preserved across suspensions using `chrome.storage.session`. |
| NFR-4 | **Extensibility** | The storage adapter interface MUST decouple all backend-specific logic so that IBM COS, AWS S3, GCP Cloud Storage, Azure Blob, and Google Drive can all be used without changes to the proxy's core business logic. Adding a new backend requires only implementing the four-method adapter interface and registering it by name. |
| NFR-5 | **Testability** | The credential scrubber and multipart decoder MUST be implemented as pure functions with no browser dependencies and MUST have unit tests. The zip serialiser MUST have a round-trip test. **Achieved:** 333 extension tests + 81 proxy tests = 414 total, all passing. |
| NFR-6 | **Maintainability** | If wxO changes its REST API paths, only the endpoint pattern list in the content script needs to be updated. No business logic should be hardcoded to specific API paths. |
| NFR-7 | **Developer Experience** | A single `npm run build` in the extension project MUST produce a fully loadable Chrome extension in `dist/`. The proxy MUST start with a single command. |
| NFR-8 | **Schema Versioning** | Every snapshot zip MUST carry a `schemaVersion` field in `manifest.json` so that future breaking format changes can be detected and migrated programmatically. |

---

## 8. Security Requirements

| ID | Requirement |
|---|---|
| SEC-1 | Credential data (API keys, bearer tokens, passwords, OAuth secrets) MUST NEVER appear in any snapshot zip, extension storage, log file, or network transmission. |
| SEC-2 | The credential scrubber MUST be applied at two independent points in the pipeline (content script and background service worker) as a defence-in-depth measure. |
| SEC-3 | The `x-ibm-wo-csrf` header value observed from wxO requests MUST be stored only in the background service worker's in-memory state. It MUST NOT be written to `chrome.storage`, transmitted to the proxy, or included in any log. ~~(Previously described as an IBM IAM bearer token — corrected in v1.1; the wxO SaaS UI does not use Authorization: Bearer.)~~ |
| SEC-4 | The local proxy MUST NOT accept requests from any origin other than the extension itself (enforced via CORS `chrome-extension://{extension-id}`). |
| SEC-5 | Storage credentials MUST be supplied to the proxy exclusively via environment variables or a local config file on the proxy's host machine. |
| SEC-6 | The proxy MUST validate the structure of every received zip before unpacking it, to defend against path traversal attacks in malformed zip archives. **Implemented:** `unpackZip()` in `wxo-autosave-proxy/src/zip.ts` rejects any entry whose resolved path escapes the temp directory. |
| SEC-7 | The extension MUST request only the minimum Chrome permissions necessary: `storage`, `tabs`, `webRequest`, and `host_permissions` scoped to `*://*.watson-orchestrate.cloud.ibm.com/*` and `http://localhost/*`. |

---

## 9. Constraints & Boundaries

| Constraint | Detail |
|---|---|
| **Chrome Manifest V3** | MV3 service workers cannot use `XMLHttpRequest` or read response bodies directly via `webRequest`. The content script `window.fetch` interceptor is the primary mechanism for response body capture. `webRequest.onBeforeRequest` with `requestBody` is used for multipart request body capture (both POST and PUT). |
| **No response body in webRequest (MV3)** | Unlike MV2, the `webRequestBlocking` API is not available to ordinary MV3 extensions. The content script fetch interceptor is the only standards-compliant path for response body capture. |
| **Proxy is always local** | The proxy runs on the builder's own machine. It is not a cloud service. Builders must run the proxy process themselves. |
| **ADK CLI dependency** | Restore operations require the IBM watsonx Orchestrate ADK CLI to be installed and authenticated on the same machine as the proxy. The proxy shells out to the CLI. |
| **Source file availability** | Catalog tools added via the wxO UI are created from a pre-signed S3 URL; the source file is never transmitted to the `mfe_builder` API. Hand-crafted Python/OpenAPI tools uploaded as multipart form data CAN be captured. In all cases, if source is not available the snapshot flags `sourceUnavailable: true`. |
| **Connection credentials** | By design, connection credential values are never captured. After a restore, the builder must re-enter credentials via the wxO UI or CLI. The restore system creates the connection shape only. |
| **Single active agent session** | v1 captures one active agent at a time. Multiple concurrent agent builder sessions in different tabs are not supported. |
| **KB create is a single atomic request** | Creating a new knowledge base and uploading the first document happens in a single `POST /v1/orchestrate/knowledge-bases/documents` multipart request. The KB UUID is not known until the `201` response body arrives. The assembler must buffer the captured file bytes and correlate them with the UUID from the response. |
| **Node 22 required for proxy** | The proxy uses Node 22 `--experimental-strip-types` to run directly from `.ts` source without a build step. Node < 22 is not supported. |
| **`exactOptionalPropertyTypes: true`** | Both the extension and proxy `tsconfig.json` set `exactOptionalPropertyTypes: true`. Optional properties may not be set to `undefined` explicitly — they must be omitted. |

---

## 10. Open Decisions

| ID | Decision | Status | Resolution / Notes |
|---|---|---|---|
| OD-1 | **Proxy server technology** | ✅ **Resolved** | **Node.js TypeScript, no framework.** Uses Node 22 `--experimental-strip-types`. The proxy uses only the Node standard `http` module plus `@aws-sdk/client-s3` and `fflate`. No Express or other framework. |
| OD-2 | **Response body interception strategy** | ✅ **Resolved** | **Content script `window.fetch` override.** Confirmed design; validated against 4 HAR recordings on `us-south.watson-orchestrate.cloud.ibm.com`. |
| OD-3 | **Proxy authentication** | ✅ **Resolved** | **Localhost-only, no shared secret for v1.** CORS enforcement limits requests to the extension origin. A shared secret may be warranted in a future version for teams sharing a proxy over a local network. |
| OD-4 | **Google Drive OAuth flow UX** | 🔲 **Open** | Relevant when the Google Drive adapter is implemented (deferred). The proxy could open the browser automatically (`open`/`xdg-open`) or print the URL for the user to visit. |
| OD-5 | **wxO API endpoint verification** | ✅ **Resolved** | All endpoint paths confirmed against 4 live HAR recordings on `us-south.watson-orchestrate.cloud.ibm.com` (Aug 2026). |
| OD-6 | **Extension distribution** | 🔲 **Open** | Side-load is sufficient for v1. Chrome Web Store publishing is a v2 consideration. |
| OD-7 | **Google Drive shared drives** | 🔲 **Open** | Relevant when the Google Drive adapter is implemented. v1 targets personal Drive only. |

---

## 11. Deviations from v1.0 — Confirmed by HAR Analysis

> **Background:** The v1.0 requirements were written against ADK documentation and plan assumptions. After analysing 4 live HAR recordings from a real wxO SaaS session (`us-south.watson-orchestrate.cloud.ibm.com`, Aug 2026), several assumptions were found to be incorrect. This section records every deviation so contributors and reviewers can understand what changed and why.

### 11.1 Authentication model

| v1.0 assumption | v1.1 confirmed reality |
|---|---|
| wxO UI authenticates via `Authorization: Bearer <IBM-IAM-token>` header on API requests | wxO UI authenticates via **session cookie + `x-ibm-wo-csrf` header**. There is NO `Authorization: Bearer` header on any `mfe_builder` API request. |
| FR-1.12 and SEC-3 referred to "IBM IAM bearer token" | Updated to refer to CSRF token. The token is session-scoped only and suitable for same-session proactive fetches, but NOT a persistent API key. |

**Impact:** The `BEARER_TOKEN_OBSERVED` message type name is retained for backward compatibility but its payload carries the CSRF token value, not a bearer token. The assembler design is unchanged — it still stores the most recent captured token for same-session proactive API calls.

---

### 11.2 API endpoint paths — complete mapping

All `mfe_builder` API paths were either wrong or missing in v1.0. Confirmed values:

| Resource | v1.0 path (wrong) | v1.1 confirmed path |
|---|---|---|
| Agent list | `GET /v2/orchestrate/agents/unified` | `GET /mfe_builder/api/v2/builder/agents` |
| Agent detail | `GET /v2/orchestrate/agents/{id}` | `GET /mfe_builder/api/v1/builder/orchestrate/agents/{uuid}` |
| Agent save | *(not captured)* | **`PATCH /mfe_builder/api/v1/builder/orchestrate/agents/{uuid}`** — this is the richest capture point; response body includes `toolsSelected[]` with full tool binding |
| Tool list/batch | `GET /v2/orchestrate/tools` | `GET /mfe_builder/api/v2/builder/tools?ids={uuid}&ids={uuid}&...` — bare JSON array response |
| Tool detail | `GET /v2/orchestrate/tools/{id}` | *(subsumed by PATCH toolsSelected — individual tool GETs not needed)* |
| Tool create (catalog) | `POST /v2/orchestrate/tools` (multipart) | `POST /mfe_builder/api/v1/builder/tools/create-from-template` — **JSON body, not multipart; source file not capturable** |
| Tool upload (hand-crafted) | `POST /v2/orchestrate/tools` (multipart) | `POST /mfe_builder/api/v2/builder/tools` (multipart — same intent, different path) |
| Connections | `GET /v2/orchestrate/connections` | `GET /mfe_builder/api/v1/orchestrate/connections/applications` |
| Connection detail | `GET /v2/orchestrate/connections/{id}` | *(subsumed by list — individual connection GETs not needed)* |
| KB list | `GET /v2/orchestrate/knowledge-bases` | *(no list endpoint observed; detail is captured per-KB)* |
| KB detail | `GET /v2/orchestrate/knowledge-bases/{id}` | `GET /mfe_builder/api/v1/orchestrate/knowledge-bases/{uuid}` — **v1/orchestrate, not v2/builder** |
| KB create | *(not modelled)* | `POST /mfe_builder/api/v1/orchestrate/knowledge-bases/documents` — creates KB **and** uploads first document in one multipart request |
| KB upload | `POST /v2/orchestrate/knowledge-bases/{id}/documents` | `PUT /mfe_builder/api/v1/orchestrate/knowledge-bases/{uuid}/documents` — **method is PUT, not POST; v1/orchestrate, not v2/builder** |

---

### 11.3 Connection response envelope

| v1.0 assumption | v1.1 confirmed reality |
|---|---|
| Connections response wrapped as `{ resources: [...] }` | Response is `{ tenant_id, page, limit, total, **applications**: [...] }` |
| Connection `kind` read from a `kind` or `type` field | Connection authentication scheme read from `security_scheme` field (e.g. `"api_key_auth"`, `"oauth2"`). `auth_type` is always `""` for non-OAuth connections. MCP toolkit connections have `security_scheme: null`. |

**Impact:** A bug in the content script's `CONNECTION_CAPTURED` handler (iterating `data["resources"]` instead of `data["applications"]`) was found and fixed during validation testing.

---

### 11.4 Agent PATCH as primary snapshot trigger

| v1.0 assumption | v1.1 confirmed reality |
|---|---|
| Agent detail comes only from GET responses; tool binding requires separate tool GET calls | `PATCH /v1/builder/orchestrate/agents/{uuid}` response body contains `toolsSelected[]` with **complete binding objects** for all tools (including `binding.python.connections` / `binding.mcp.connections` maps). This is the richest single capture point. |
| FR-1.8 required proactive tool fetching for all pre-existing tools | **Proactive fetching is the fallback only**, not the primary path. The PATCH `toolsSelected[]` eliminates the need for proactive fetches in the common case (user saves agent). Proactive fetching is only required if the assembler needs tool details before the user performs a save. |

---

### 11.5 KB create atomicity

| v1.0 assumption | v1.1 confirmed reality |
|---|---|
| KB creation and document upload are separate API calls | KB creation and first document upload are a **single atomic `POST /knowledge-bases/documents` multipart request**. The KB UUID is not in the URL — it is returned in the `201` response body as `{ knowledge_base: "<uuid>", ... }`. |

**Impact:** The assembler must buffer `KB_FILE_CAPTURED` events with `kbId: ""` (emitted from the create POST) and back-fill the UUID when the `201` response is processed. Subsequent additional uploads use `PUT /{uuid}/documents` and carry the UUID in the URL.

---

### 11.6 wxO SaaS hostname

| v1.0 assumption | v1.1 confirmed reality |
|---|---|
| `*.watson-orchestrate.ibm.com` | **`*.watson-orchestrate.cloud.ibm.com`** |

**Impact:** `manifest.json` `host_permissions`, content script `matches`, and `webRequest` URL filter patterns have all been updated. The shared constant `WXO_HOSTNAME` in `src/shared/index.ts` is corrected.

---

## 12. Implementation Record

> This section records decisions made during v1 implementation that clarify, narrow, or correct the requirements. It is a factual record — not re-opened requirements — so that contributors and future maintainers understand how the built system relates to the written spec.

### 12.1 Proxy technology — Node.js TypeScript, no framework (resolves OD-1)

The local proxy is implemented as a Node.js TypeScript project in `wxo-autosave-proxy/`. Key choices:

- **No HTTP framework.** The proxy uses the Node built-in `http` module only.
- **Node 22 `--experimental-strip-types`.** The proxy runs directly from `.ts` source with `node --experimental-strip-types src/index.ts`. No `tsc` compile step is needed for development or production use. Node < 22 is not supported.
- **`@aws-sdk/client-s3` + `fflate`.** The only production dependencies. All three S3-compatible backends (COS, AWS S3, GCS) share one adapter class parameterised by endpoint.

### 12.2 IBM COS credential model (corrects FR-4.5)

IBM COS HMAC credentials are `COS_ACCESS_KEY_ID` and `COS_SECRET_ACCESS_KEY` — not `COS_API_KEY`. The v1.1 requirements listed `COS_API_KEY` in error. When `COS_INSTANCE_CRN` is set, the `ibm-service-instance-id` header is injected as a pre-request middleware hook on the AWS SDK client, enabling IBM-specific billing and resource tracking without any other SDK changes.

### 12.3 SNAPSHOT_READY bus wiring

The `SNAPSHOT_READY` event type was added to `SnapshotEventType` and `SnapshotAssemblerEvents` in the assembler. The `emitSnapshotReady()` function:

1. Calls `events.emit("SNAPSHOT_READY", { agentId, snapshot })` on the shared internal bus.
2. Iterates `snapshotReadyListeners[]` (the legacy `onSnapshotReady()` callback list) for backward compatibility.
3. POSTs the zip to the local proxy and, on success, appends a `RecentSnapshotEntry` to `chrome.storage.local`.

`emit` is now exported from `src/background/index.ts` so it can be used by any future caller (e.g., a popup-side message handler or a test harness that imports the bus directly).

### 12.4 Test strategy — "pure extracted logic"

`chrome.*` globals are unavailable in vitest (`environment: node`). All testable logic is either:

- Implemented as pure functions in `src/shared/` (scrubber, multipart decoder, zip serialiser, settings merge), or
- Extracted inline into the test file as a faithful copy of the function under test (e.g., `rawBytesFromRequestBody`, `makeEventBus`, `extractedEmitSnapshotReady` in `background.test.ts`).

This pattern means the test suite has zero mocked `chrome.*` calls. Current coverage: **333 extension tests** (9 test files) + **81 proxy tests** (4 test files) = **414 total**.

### 12.5 YAML files are JSON-encoded

All `.yaml` files written into snapshot zips (agent, tools, knowledge bases, connections) are JSON-encoded strings. JSON is valid YAML 1.2 and the ADK CLI accepts it. This choice avoids adding a YAML serialisation library to the MV3 service worker bundle.

### 12.6 Google Drive adapter deferred

`STORAGE_PROVIDER=gdrive` is accepted by the proxy config parser but returns HTTP 501 with a clear message. The `StorageAdapter` interface and factory are already structured to accommodate the adapter when implemented (FR-4.6 fully specifies it). No other proxy code needs to change.

### 12.7 debounceMs wiring deferred

The popup saves a `debounceMs` value to `chrome.storage.sync` via the settings panel, but the assembler currently reads `DEBOUNCE_DEFAULT_MS` (3 000 ms) as a constant. Reading the configured value from `chrome.storage.sync` inside `scheduleSnapshotReady()` is a straightforward follow-up change.

### 12.8 Restore progress — NDJSON streaming

The `POST /restore` endpoint streams progress as newline-delimited JSON (NDJSON). Each line is a `{ step, status, message }` object. The popup reads the response as a stream and updates the progress overlay in real time, then shows the final per-artefact result log when the stream closes.

---

## 13. Glossary

| Term | Definition |
|---|---|
| **ADK** | watsonx Orchestrate Agent Developer Kit — the CLI and SDK for programmatically managing wxO agents, tools, KBs, and connections |
| **Agent Artefact** | Any resource associated with an agent: the agent definition itself, its tools, its knowledge bases, and its connections |
| **app_id** | The identifier for a wxO connection object. Tools reference connections by `app_id`. It is the connection name, not a credential. |
| **COS** | IBM Cloud Object Storage — the default S3-compatible blob storage target for snapshot zips |
| **CSRF token** | The `x-ibm-wo-csrf` header value sent with every wxO SaaS UI API request. This is the session authentication mechanism (alongside a session cookie). It is NOT an IBM IAM bearer token and is session-scoped only. |
| **Google Drive adapter** | The storage adapter implementation that stores snapshot zips as files in a user's Google Drive, organised under a `wxo-autosave/` folder hierarchy, using the Google Drive API v3 with OAuth 2.0. Deferred to a follow-up release. |
| **OAuth 2.0 authorization code flow** | The three-legged OAuth flow used by the Google Drive adapter |
| **Storage adapter interface** | The abstract interface all storage backends implement, defining `upload`, `download`, `list`, and `delete` operations |
| **Content Script** | A JavaScript file injected by the extension into the wxO Agent Builder page, with access to the page's DOM and JavaScript context, including `window.fetch` |
| **Debounce** | A technique that delays an action until a specified period of inactivity has passed |
| **kind** | The authentication scheme type of a wxO connection, sourced from the `security_scheme` field in the connections API response (e.g. `api_key_auth`, `basic_auth`, `bearer_token`, `key_value_creds`, `oauth2`). Empty string for MCP toolkit connections where `security_scheme` is null. |
| **MV3** | Chrome Extension Manifest Version 3 |
| **NDJSON** | Newline-Delimited JSON — a streaming format where each line is a valid JSON object. Used by the proxy's `POST /restore` endpoint to stream per-artefact progress to the popup. |
| **Proactive fetch** | When the assembler detects that a referenced tool has not been captured in the current session before a PATCH fires, it may issue an authenticated API request using the session CSRF token to capture that tool's details. This is a fallback path — the PATCH `toolsSelected[]` covers the common case. |
| **Proxy server** | A local HTTP server (runs on the builder's machine) that holds storage credentials or OAuth tokens, accepts snapshots from the extension, and executes restores via the ADK CLI |
| **Scrubber** | A pure function that removes credential values from a captured payload before it is stored, emitted, or transmitted |
| **security_scheme** | The field name in the wxO connections API response (`/v1/orchestrate/connections/applications`) that identifies the authentication type. Used as the `kind` value in captured connection metadata. |
| **Service Worker (MV3)** | The background execution context for a Manifest V3 Chrome extension; it is ephemeral and may be suspended by the browser at any time |
| **Snapshot** | A complete, versioned zip archive of all artefacts associated with a single agent at a point in time |
| **SNAPSHOT_READY** | An internal bus event emitted by the assembler when a debounce cycle completes and a snapshot is ready to be serialised, POSTed to the proxy, and indexed. Listeners receive `{ agentId, snapshot }`. |
| **sourceUnavailable** | A flag set on a tool's metadata when the source file is not capturable (catalog tools added via UI, or pre-existing tools where the API does not return source). The tool metadata is still captured but it cannot be fully restored without the source. |
| **Tenant** | The wxO SaaS organisation identifier, extracted from the captured agent payload (`tenant_id` field) |
| **toolsSelected** | A field present in the `PATCH /v1/builder/orchestrate/agents/{uuid}` request body that contains full tool objects with binding information. This is the primary source of tool binding data for the assembler. |
| **wxO** | IBM watsonx Orchestrate — the AI agent platform whose Agent Builder UI is the target of this project |

---

## 14. Contributing

This project is open to community contributions. Here are the best ways to help:

### Good First Issues

- **Implement the Google Drive storage adapter** — interface and spec fully defined in FR-4.6; proxy factory and `StorageAdapter` interface are already in place; `STORAGE_PROVIDER=gdrive` returns a clear unsupported error today
- **Implement the Azure Blob storage adapter** — same `StorageAdapter` interface; env vars `AZURE_STORAGE_ACCOUNT` / `AZURE_STORAGE_KEY` / `AZURE_CONTAINER` are the expected config shape
- **Wire `debounceMs` from popup settings into the assembler** — the value is already saved to `chrome.storage.sync`; `scheduleSnapshotReady()` just needs to read it before setting the timer (FR-1.11)
- **Live E2E validation** — load the extension against a real wxO SaaS tenant and COS bucket; follow the runbook in `TESTING.md`

### How to Contribute

1. **Fork** this repository
2. Open an **Issue** to discuss your contribution before starting large changes
3. For requirement clarifications or additions, open a **Discussion** or Issue labelled `requirements`
4. Submit a **Pull Request** referencing the relevant requirement IDs (e.g. `FR-3.5`, `SEC-6`)

### Design Principles for Contributors

- **Zero credential capture** — any change that risks capturing a credential value must be explicitly reviewed; see SEC-1 through SEC-7
- **Transparency** — the extension must never alter wxO UI behaviour (NFR-1)
- **Minimal permissions** — the extension must not request Chrome permissions beyond what is listed in SEC-7
- **Testable building blocks** — pure functions (scrubber, multipart decoder, zip serialiser) must have unit tests before any integration work that depends on them

### Repository Structure

```
wxo-ui-agent-autosave/              # Chrome/Edge extension (TypeScript, Vite, MV3)
  src/
    background/
      index.ts                      # Service worker: message dispatch, webRequest, event bus (on/emit)
      assembler.ts                  # Snapshot assembler: KB correlation, debounce, SNAPSHOT_READY
    content/
      index.ts                      # Content script: fetch interceptor
    popup/
      index.html                    # Full popup markup
      popup.css                     # Popup styles
      popup.ts                      # Popup logic: session card, history, restore flow, settings
    shared/
      index.ts                      # AgentSnapshot, SnapshotReadyPayload, constants
      messages.ts                   # ExtensionMessage discriminated union + type guard
      scrubber.ts                   # Credential scrubber (pure, tested)
      multipart.ts                  # Multipart decoder (pure, tested)
      zip.ts                        # buildZip / parseZip using fflate (pure, tested)
      settings.ts                   # PopupSettings, mergeSettings, readSettings, writeSettings
      __tests__/                    # 333 tests across 9 files
  wxo-autosave-extension-plan.md    # Implementation plan with sub-task status and deviations

wxo-autosave-proxy/                 # Local proxy server (Node.js TypeScript, no framework)
  src/
    index.ts                        # Entry point: validateAdkCli → readConfig → createStorageAdapter → listen
    config.ts                       # readConfig, validateAdkCli, StorageProvider type
    server.ts                       # HTTP server: POST /snapshots, GET /snapshots, GET /restore/preflight, POST /restore
    zip.ts                          # unpackZip (with SEC-6 path traversal guard), zip accessors
    preflight.ts                    # buildPreflightReport (pure)
    restore.ts                      # restoreFromZip: shells out to ADK CLI in dependency order
    storage/
      adapter.ts                    # StorageAdapter interface
      cos.ts                        # S3StorageAdapter (COS / S3 / GCS)
      index.ts                      # createStorageAdapter factory
    __tests__/                      # 81 tests across 4 files
  README.md                         # Install, env var reference, API docs, restore progress format

wxo-agent-backup-recovery-requirements.md   # This file
TESTING.md                                  # E2E runbook: 4 test scenarios, environment setup
```

---

*Requirements document v1.2 — updated to reflect completed v1 implementation (Aug 2026). For questions, open a GitHub Issue.*
