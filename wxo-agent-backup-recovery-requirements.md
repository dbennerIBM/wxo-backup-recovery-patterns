# wxO Agent Builder — Backup & Recovery: Project Requirements

> **Status:** Draft v1.0 — open for community collaboration  
> **Maintainer:** @dbenner  
> **Repo:** [wxO Backup Recovery Patterns](https://github.com/dbenner/wxo-backup-recovery-patterns)  
> **Contributions welcome:** Please open an Issue or PR. See [Contributing](#contributing) for guidance.

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
11. [Glossary](#11-glossary)
12. [Contributing](#12-contributing)

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
- The proxy stores versioned snapshot archives in IBM Cloud Object Storage (or any S3-compatible bucket).
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
- Versioned zip snapshots stored in IBM Cloud Object Storage (COS)
- One-click restore to the same or a different wxO environment via the local proxy
- Support for all four agent artefact types: **agent definitions**, **tools** (Python and OpenAPI), **knowledge bases** (including uploaded source documents), and **connections** (metadata only — never credentials)
- Local proxy server (runs on the builder's machine); proxy technology (Node, Python, Go) is an open decision
- Side-load deployment only (no Chrome Web Store publishing required for v1)

### Out of Scope — v1

- Firefox support
- Snapshot diff / merge between versions
- Multi-tenant concurrent sessions in the same browser
- Cloud-hosted proxy
- Syncing credentials during restore (the builder re-enters credentials; the system captures connection shape only)
- Automated migration between wxO API versions

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
│  │  wxO Agent Builder  │──(POST bodies)▶│  (MV3 service    │ │
│  │  SaaS UI            │                │   worker)        │ │
│  └─────────────────────┘                │  - Assembler     │ │
│                                         │  - Debounce      │ │
│  ┌─────────────────────┐                │  - Zip builder   │ │
│  │  Extension Popup    │◀───────────────│                  │ │
│  │  (History & Restore)│  chrome.storage└──────────────────┘ │
│  └─────────────────────┘                         │           │
│                                                  │ POST /snapshots
└──────────────────────────────────────────────────┼───────────┘
                                                   │ http://localhost:7878
                                        ┌──────────▼──────────┐
                                        │  Local Proxy Server │
                                        │  (Node / Python /   │
                                        │   Go)               │
                                        │  - COS upload       │
                                        │  - Restore via ADK  │
                                        └──────────┬──────────┘
                                                   │
                              ┌────────────────────▼──────────────┐
                              │  IBM Cloud Object Storage         │
                              │  {tenant}/{agent}/{timestamp}.zip │
                              └───────────────────────────────────┘
```

**Data flow summary:**

1. Builder uses the wxO Agent Builder UI normally.
2. The content script's `fetch` interceptor captures every JSON response from wxO API endpoints of interest, as well as multipart upload request bodies (KB documents, OpenAPI spec files).
3. The `chrome.webRequest.onBeforeRequest` listener in the background service worker provides a complementary capture path for multipart POST bodies.
4. All captured events flow to the **Snapshot Assembler** in the background service worker, which coalesces them into a single `AgentSnapshot` object.
5. After 3 seconds of inactivity (debounced), the assembler serialises the snapshot into a zip archive and POSTs it to the local proxy at `http://localhost:7878/snapshots`.
6. The proxy derives the bucket key (`{tenant}/{agent-name}/{ISO-timestamp}.zip`), uploads the zip to IBM COS, and responds with the stored object key.
7. The extension popup queries the proxy's `/snapshots` endpoint to list available snapshots and can initiate a restore via `/restore`.
8. On restore, the proxy downloads the zip from COS, unpacks it to a temp directory, and runs the ADK CLI to re-import artefacts in dependency order.

---

## 6. Functional Requirements

### FR-1 Passive Capture

| ID | Requirement |
|---|---|
| FR-1.1 | The extension MUST capture agent definitions from `GET /v2/orchestrate/agents/unified` and `GET /v2/orchestrate/agents/{id}` responses without any builder action. |
| FR-1.2 | The extension MUST capture tool metadata from `GET /v2/orchestrate/tools`, `GET /v2/orchestrate/tools/{id}`, and the `POST /v2/orchestrate/tools` creation response. |
| FR-1.3 | The extension MUST capture the `app_id` association and `expectedCredentials` for each tool at both creation time (POST response) and on subsequent GET responses. |
| FR-1.4 | The extension MUST capture knowledge base metadata from `GET /v2/orchestrate/knowledge-bases` and `GET /v2/orchestrate/knowledge-bases/{id}`. |
| FR-1.5 | The extension MUST capture raw file bytes and filenames from multipart `POST /v2/orchestrate/knowledge-bases/{id}/documents` uploads. |
| FR-1.6 | The extension MUST capture raw spec file bytes and filenames from multipart `POST /v2/orchestrate/tools` uploads (for OpenAPI spec tools). |
| FR-1.7 | The extension MUST capture connection metadata from `GET /v2/orchestrate/connections` and `GET /v2/orchestrate/connections/{id}`. |
| FR-1.8 | When the assembler receives an `AGENT_CAPTURED` event and the agent references tools that have not yet been captured in the current session, the assembler MUST proactively fetch those tool details via `GET /v2/orchestrate/tools/{name}` using the most recently observed session bearer token. |
| FR-1.9 | For any tool whose source file cannot be obtained from the API, the snapshot MUST record a `sourceUnavailable: true` flag in the tool's metadata so that the restore path can warn the builder rather than silently failing. |
| FR-1.10 | The capture pipeline MUST be fully transparent: it MUST NOT alter any request or response observed by the wxO UI in any way. |
| FR-1.11 | The assembler MUST debounce snapshot saves; the debounce window MUST default to 3 seconds after the last captured event and MUST be user-configurable. |
| FR-1.12 | The background service worker MUST track the most recently observed IBM IAM bearer token in ephemeral memory (never persisted to any storage) for use in proactive tool fetching (FR-1.8). |

---

### FR-2 Credential Safety

| ID | Requirement |
|---|---|
| FR-2.1 | The extension MUST NEVER capture, store, log, or transmit credential values. This includes API keys, bearer tokens, passwords, client secrets, OAuth tokens, and any value stored under a key matching the credential pattern (see FR-2.4). |
| FR-2.2 | Connection artefacts MUST be captured as metadata only: `app_id` (the connection name/identifier), `kind` (the authentication scheme type, e.g. `API_KEY_AUTH`, `BASIC_AUTH`, `BEARER_TOKEN`), and `server_url` if present. All other connection fields MUST be dropped. |
| FR-2.3 | A credential scrubber MUST run on every captured payload before the payload is stored, emitted, or forwarded. The scrubber MUST be applied in both the content script (first pass) and the background service worker (second pass, defence-in-depth). |
| FR-2.4 | The scrubber MUST redact any key (case-insensitive, ignoring `-` and `_` separators) that matches: `api_key`, `apikey`, `token`, `password`, `passwd`, `client_secret`, `clientsecret`, `auth_config`, `authorization`, `secret`, `access_token`, `refresh_token`, `id_token`, `private_key`, `credential`, `credentials`. |
| FR-2.5 | The local proxy MUST read storage credentials exclusively from environment variables or a local config file on the proxy host machine — never from the extension, the browser, or any network-transmitted payload. |
| FR-2.6 | The proxy CORS configuration MUST restrict requests to the extension's own origin (`chrome-extension://{extension-id}`) only. |

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
| FR-3.2 | The zip archive MUST be deterministic: identical snapshots MUST produce byte-for-byte identical zips (stable file ordering) to enable deduplication at the storage layer. |
| FR-3.3 | The `manifest.json` MUST include a `schemaVersion` field so that future format changes can be detected and migrated. The initial version is `"1.0"`. |
| FR-3.4 | The `manifest.json` MUST include a `restore_warnings` array listing any tool names where `sourceUnavailable` is true, so that the restore UI can surface them before the builder confirms. |
| FR-3.5 | The zip serialiser (`buildZip`) MUST be implemented using a browser-compatible, pure-JS library (`fflate` is the reference choice) so it can run inside the MV3 service worker without Node APIs. |
| FR-3.6 | The zip deserialiser (`parseZip`) MUST be implemented on the proxy side and MUST produce an object that round-trips through `buildZip → parseZip` with deep equality. |
| FR-3.7 | The snapshot's `AgentSnapshot` TypeScript type MUST be defined in the `src/shared/` directory so it is usable by both the extension and the proxy-server package. |

---

### FR-4 Storage

| ID | Requirement |
|---|---|
| FR-4.1 | The proxy MUST store each snapshot zip in IBM Cloud Object Storage using the key path: `{tenant}/{agent-name}/{ISO-8601-timestamp}.zip`. |
| FR-4.2 | The proxy MUST use the COS S3-compatible API (the AWS SDK v3 `@aws-sdk/client-s3` with a custom `endpoint` is the reference implementation). |
| FR-4.3 | The storage adapter MUST be abstracted behind an interface so that AWS S3, GCP Cloud Storage, and Azure Blob Storage can be substituted without changing the proxy's business logic. |
| FR-4.4 | COS credentials (`COS_ENDPOINT`, `COS_API_KEY`, `COS_BUCKET`, `COS_INSTANCE_CRN`) MUST be read from environment variables or a local config file, never hardcoded. |
| FR-4.5 | The extension MUST maintain a local index of the most recent 5 snapshots in `chrome.storage.local` (tenant, agent name, timestamp, and proxy URL only — no file bytes) so that the popup can display recent history even when the proxy is temporarily offline. |
| FR-4.6 | In-flight assembly state in the background service worker MUST be persisted to `chrome.storage.session` (not in-memory only) so that brief MV3 service worker suspensions do not lose a partially assembled snapshot. |

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
| FR-6.7 | The popup MUST include a settings panel (stored in `chrome.storage.sync`) with: configurable proxy port (default `7878`), debounce delay in seconds, and bucket path prefix override. |
| FR-6.8 | When the local proxy is offline, the popup MUST fall back to the locally cached snapshot index from `chrome.storage.local` and display a warning that live history and restore are unavailable. |
| FR-6.9 | The popup bundle MUST NOT include any server-side Node APIs and MUST be kept as small as practical (no heavy UI framework required). |

---

### FR-7 Local Proxy Server

| ID | Requirement |
|---|---|
| FR-7.1 | The proxy MUST start with a single command and listen on a configurable port (default `7878`). |
| FR-7.2 | `POST /snapshots` — accept a zip binary body, parse the embedded `manifest.json` to derive the bucket key, upload to the configured object storage provider, return HTTP 201 with the stored object key. |
| FR-7.3 | `GET /snapshots?agent={name}&tenant={tenant}` — list all snapshot objects under the `{tenant}/{agent-name}/` prefix; return a JSON array of `{ key, timestamp, size }`. |
| FR-7.4 | `GET /restore/preflight?key={zip-key}` — see FR-5.1 and FR-5.2. |
| FR-7.5 | `POST /restore` — see FR-5.3 through FR-5.10. |
| FR-7.6 | The proxy MUST enforce CORS such that only `chrome-extension://{extension-id}` origins are accepted. |
| FR-7.7 | The proxy MUST read all storage and ADK configuration from environment variables or a local config file. |
| FR-7.8 | The proxy MUST include a `README.md` with installation instructions, environment variable reference, and a start command. |
| FR-7.9 | The proxy MUST require that the wxO ADK CLI is installed and authenticated (`orchestrate env activate`) on the same machine before restore operations can run. |

---

## 7. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | **Transparency** | The extension MUST be a passive observer. It MUST NOT modify any request, delay any response, or in any way alter the behaviour of the wxO Agent Builder UI. |
| NFR-2 | **Performance** | Network interception and event dispatch MUST add no perceptible latency to wxO UI interactions. The debounce mechanism ensures that snapshot assembly and zip serialisation happen out-of-band. |
| NFR-3 | **Reliability** | The extension MUST continue to function correctly after MV3 service worker suspension events. In-flight assembly state MUST be preserved across suspensions using `chrome.storage.session`. |
| NFR-4 | **Extensibility** | The object storage adapter MUST be designed behind an interface so that IBM COS, AWS S3, GCP Cloud Storage, and Azure Blob can be used without changes to the rest of the proxy. |
| NFR-5 | **Testability** | The credential scrubber and multipart decoder MUST be implemented as pure functions with no browser dependencies and MUST have unit tests. The zip serialiser MUST have a round-trip test. |
| NFR-6 | **Maintainability** | If wxO changes its REST API paths, only the endpoint pattern list in the content script needs to be updated. No business logic should be hardcoded to specific API paths. |
| NFR-7 | **Developer Experience** | A single `npm run build` in the extension project MUST produce a fully loadable Chrome extension in `dist/`. The proxy MUST start with a single command. |
| NFR-8 | **Schema Versioning** | Every snapshot zip MUST carry a `schemaVersion` field in `manifest.json` so that future breaking format changes can be detected and migrated programmatically. |

---

## 8. Security Requirements

| ID | Requirement |
|---|---|
| SEC-1 | Credential data (API keys, bearer tokens, passwords, OAuth secrets) MUST NEVER appear in any snapshot zip, extension storage, log file, or network transmission. |
| SEC-2 | The credential scrubber MUST be applied at two independent points in the pipeline (content script and background service worker) as a defence-in-depth measure. |
| SEC-3 | The IBM IAM bearer token observed from wxO requests MUST be stored only in the background service worker's in-memory state. It MUST NOT be written to `chrome.storage`, transmitted to the proxy, or included in any log. |
| SEC-4 | The local proxy MUST NOT accept requests from any origin other than the extension itself (enforced via CORS `chrome-extension://{extension-id}`). |
| SEC-5 | Storage credentials MUST be supplied to the proxy exclusively via environment variables or a local config file on the proxy's host machine. |
| SEC-6 | The proxy MUST validate the structure of every received zip before unpacking it, to defend against path traversal attacks in malformed zip archives. |
| SEC-7 | The extension MUST request only the minimum Chrome permissions necessary: `storage`, `tabs`, `webRequest`, and `host_permissions` scoped to the wxO SaaS hostname and `localhost`. |

---

## 9. Constraints & Boundaries

| Constraint | Detail |
|---|---|
| **Chrome Manifest V3** | MV3 service workers cannot use `XMLHttpRequest` or read response bodies directly via `webRequest`. The content script `window.fetch` interceptor is the primary mechanism for response body capture. `webRequest.onBeforeRequest` with `requestBody` is used exclusively for multipart POST body capture. |
| **No response body in webRequest (MV3)** | Unlike MV3, the older `webRequestBlocking` API is not available to ordinary extensions. The content script fetch interceptor is the only standards-compliant path for response body capture. |
| **Proxy is always local** | The proxy runs on the builder's own machine. It is not a cloud service. Builders must run the proxy process themselves. |
| **ADK CLI dependency** | Restore operations require the IBM watsonx Orchestrate ADK CLI to be installed and authenticated on the same machine as the proxy. The proxy shells out to the CLI. |
| **Source file availability** | The wxO API may not return original source files (Python `.py`, OpenAPI `.yaml`) in GET responses for pre-existing tools. In these cases the snapshot records what is available and flags `sourceUnavailable: true`. |
| **Connection credentials** | By design, connection credential values are never captured. After a restore, the builder must re-enter credentials via the wxO UI or CLI. The restore system creates the connection shape only. |
| **Single active agent session** | v1 captures one active agent at a time. Multiple concurrent agent builder sessions in different tabs are not supported. |

---

## 10. Open Decisions

The following decisions require resolution before or during implementation. Community input is welcome via GitHub Issues.

| ID | Decision | Options | Notes |
|---|---|---|---|
| OD-1 | **Proxy server technology** | Node.js/Express, Python/FastAPI, Go/chi | No functional dependency on choice; pick based on contributor preference |
| OD-2 | **Response body interception strategy** | Content script `window.fetch` override (current) vs. offscreen document vs. other | Content script fetch override is the current design; confirm this holds against CSP policies on the wxO SaaS domain |
| OD-3 | **Proxy authentication** | None (localhost only) vs. shared-secret request header | Localhost-only is sufficient for v1; a shared secret may be warranted for teams sharing a proxy over a local network |
| OD-4 | **Additional cloud storage providers for v1** | IBM COS only vs. also ship AWS S3 adapter | The interface is designed for extensibility; the question is whether to ship two adapters in v1 or just the interface stub |
| OD-5 | **wxO API endpoint verification** | Paths in these requirements are derived from ADK documentation and DevTools inspection; they require confirmation against a live wxO SaaS session before Sub-Task 2 implementation finalises | A contributor with wxO SaaS access should verify the endpoint list and open an Issue if any paths differ |
| OD-6 | **Extension distribution** | Side-load only (current) vs. Chrome Web Store for v2 | Side-load is sufficient for v1; Web Store submission is a future consideration |

---

## 11. Glossary

| Term | Definition |
|---|---|
| **ADK** | watsonx Orchestrate Agent Developer Kit — the CLI and SDK for programmatically managing wxO agents, tools, KBs, and connections |
| **Agent Artefact** | Any resource associated with an agent: the agent definition itself, its tools, its knowledge bases, and its connections |
| **app_id** | The identifier for a wxO connection object. Tools reference connections by `app_id`. It is the connection name, not a credential. |
| **COS** | IBM Cloud Object Storage — the default S3-compatible blob storage target for snapshot zips |
| **Content Script** | A JavaScript file injected by the extension into the wxO Agent Builder page, with access to the page's DOM and JavaScript context, including `window.fetch` |
| **Debounce** | A technique that delays an action until a specified period of inactivity has passed, preventing a flood of identical operations |
| **expectedCredentials** | Metadata embedded in a tool definition that names the connection (`app_id`) and credential type a tool requires at runtime |
| **kind** | The authentication scheme type of a wxO connection (e.g. `API_KEY_AUTH`, `BASIC_AUTH`, `BEARER_TOKEN`, `OAUTH_CLIENT_CREDENTIALS`) |
| **MV3** | Chrome Extension Manifest Version 3 — the current extension format that replaces MV2; it uses a service worker instead of a background page |
| **Proactive fetch** | When the assembler detects that a referenced tool has not been captured in the current session, it issues an authenticated API request to capture that tool's details |
| **Proxy server** | A local HTTP server (runs on the builder's machine) that holds storage credentials, accepts snapshots from the extension, and executes restores via the ADK CLI |
| **Scrubber** | A pure function that removes credential values from a captured payload before it is stored, emitted, or transmitted |
| **Service Worker (MV3)** | The background execution context for a Manifest V3 Chrome extension; it is ephemeral and may be suspended by the browser at any time |
| **Snapshot** | A complete, versioned zip archive of all artefacts associated with a single agent at a point in time |
| **sourceUnavailable** | A flag set on a tool's metadata when the API does not return the original source file (Python or OpenAPI spec); the tool metadata is captured but it cannot be fully restored |
| **Tenant** | The wxO SaaS organisation identifier, extracted from the browser tab URL or agent API response |
| **wxO** | IBM watsonx Orchestrate — the AI agent platform whose Agent Builder UI is the target of this project |

---

## 12. Contributing

This project is open to community contributions. Here are the best ways to help:

### Good First Issues
- **Verify wxO API endpoint paths** against a live SaaS session and open an Issue with confirmed paths (OD-5)
- **Implement the zip serialiser** (`buildZip` / `parseZip` with `fflate`) — the interface is specified in FR-3, the format in FR-3.1
- **Implement the Snapshot Assembler** in the background service worker — the design is specified in the plan file (`wxo-autosave-extension-plan.md`, Sub-Task 3)
- **Choose and scaffold the proxy server** (OD-1) — Node/Express, Python/FastAPI, or Go/chi are all welcome

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
wxo-ui-agent-autosave/        # Chrome/Edge extension (TypeScript, Vite, MV3)
  src/
    background/               # MV3 service worker — network interception, assembler
    content/                  # Content script — fetch interceptor
    popup/                    # Extension popup UI
    proxy-server/             # Placeholder — local proxy server (to be implemented)
    shared/                   # Pure utilities shared by extension and proxy
      messages.ts             # Typed internal message schema
      scrubber.ts             # Credential scrubber (pure, tested)
      multipart.ts            # Multipart decoder (pure, tested)
  wxo-autosave-extension-plan.md   # Detailed implementation plan with sub-tasks
wxo-agent-backup-recovery-requirements.md   # This file
```

---

*Requirements document generated from planning sessions. For questions, open a GitHub Issue.*
