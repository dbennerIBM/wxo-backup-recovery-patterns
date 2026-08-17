# E2E Testing & Validation Runbook — wxO Agent Autosave

This document covers:
1. [Unit test coverage summary](#1-unit-test-coverage-summary)
2. [Environment setup for E2E testing](#2-environment-setup)
3. [Test Scenario A — Full capture-to-restore round-trip](#3-test-scenario-a--full-capture-to-restore-round-trip)
4. [Test Scenario B — Proxy offline (popup fallback)](#4-test-scenario-b--proxy-offline)
5. [Test Scenario C — Partial KB upload](#5-test-scenario-c--partial-kb-upload)
6. [Test Scenario D — Catalog tool (sourceUnavailable)](#6-test-scenario-d--catalog-tool-sourceunavailable)
7. [Maintenance notes — wxO API endpoint changes](#7-maintenance-notes)

---

## 1. Unit Test Coverage Summary

All unit tests are automated and run without a live environment.

### Extension (`wxo-ui-agent-autosave/`)

```sh
cd wxo-ui-agent-autosave
npm test
```

| Test file | What it covers |
|---|---|
| `background.test.ts` | Message dispatch, event bus, scrubbing, KB correlation helpers, `SNAPSHOT_READY` emission |
| `messages.test.ts` | `isExtensionMessage` type guard |
| `scrubber.test.ts` | Credential scrubber — all field patterns |
| `multipart.test.ts` | Multipart form-data decoder |
| `urlPatterns.test.ts` | Endpoint URL matching patterns |
| `captureLogic.test.ts` | Content script capture logic |
| `zip.test.ts` | `buildZip` / `parseZip` / round-trips / determinism |
| `proxyPost.test.ts` | `postSnapshotToProxy` / `appendRecentSnapshot` / index capping |
| `settings.test.ts` | `mergeSettings` defaults and validation |

### Proxy (`wxo-autosave-proxy/`)

```sh
cd wxo-autosave-proxy
npm test
```

| Test file | What it covers |
|---|---|
| `zip.test.ts` | `unpackZip`, path traversal guard (SEC-6), all zip accessor functions |
| `preflight.test.ts` | `buildPreflightReport` — connections, unavailable tools, restore order |
| `config.test.ts` | `parseProvider`, `readConfig` for COS/S3, PORT validation |
| `server.test.ts` | CORS decision logic, route dispatch table |

---

## 2. Environment Setup

### Prerequisites

| Component | Minimum version | Notes |
|---|---|---|
| Chrome or Edge | Any current release | Side-load the extension from `wxo-ui-agent-autosave/dist/` |
| Node.js | 22 | Proxy uses `--experimental-strip-types` |
| IBM watsonx Orchestrate ADK CLI | Latest | `pip install ibm-watsonx-orchestrate` |
| wxO SaaS tenant | — | `us-south.watson-orchestrate.cloud.ibm.com` confirmed (Aug 2026) |
| IBM COS bucket | — | Or substitute AWS S3 / GCS with a compatible `.env` |

### Step 1 — Build the extension

```sh
cd wxo-ui-agent-autosave
npm install
npm run build
```

Load `dist/` as an unpacked extension in `chrome://extensions`.

### Step 2 — Configure and start the proxy

```sh
cd wxo-autosave-proxy
npm install
cp .env.example .env        # edit with real credentials (see README.md)
```

Minimum `.env` for IBM COS:
```sh
STORAGE_PROVIDER=cos
BUCKET=wxo-autosave-snapshots
COS_ENDPOINT=https://s3.us-south.cloud-object-storage.appdomain.cloud
COS_ACCESS_KEY_ID=<your-hmac-key>
COS_SECRET_ACCESS_KEY=<your-hmac-secret>
COS_INSTANCE_CRN=<your-crn>
```

```sh
orchestrate env activate <your-env-name>
npm start
```

Expected output:
```
[wxo-proxy] ✓ Listening on http://127.0.0.1:7878
[wxo-proxy]   Storage provider : cos
[wxo-proxy]   Bucket           : wxo-autosave-snapshots
[wxo-proxy]   Allowed origin   : chrome-extension://
```

### Step 3 — Create the test agent fixture

In the wxO Agent Builder UI, create an agent with:
- **Name:** `e2e-test-agent`
- **At least one Python tool** — upload a `.py` file (hand-crafted, not from catalog)
- **At least one knowledge base** with two source documents (e.g. two `.pdf` or `.txt` files)
- **At least one connection** (any kind — credentials not captured)

---

## 3. Test Scenario A — Full capture-to-restore round-trip

**Goal:** Verify the complete pipeline from UI action → snapshot zip in COS → one-click restore.

### Steps

1. **Trigger a capture:** In the wxO Agent Builder, open `e2e-test-agent` and make any change (e.g. edit the instructions field, then click Save). The background service worker debounces for 3 seconds and then POSTs a zip to the proxy.

2. **Confirm the proxy received it:**
   ```
   [wxo-proxy] [wxo-autosave] snapshot saved e2e-test-agent 2026-...
   ```
   Or query the proxy directly:
   ```sh
   curl -H "Origin: chrome-extension://e2e" "http://localhost:7878/snapshots?agent=e2e-test-agent&tenant=<your-tenant>"
   ```
   Expected: JSON array with at least one entry containing `key`, `timestamp`, `size`.

3. **Confirm the zip is in COS:** Open the IBM COS console and navigate to `<your-tenant>/e2e-test-agent/`. A `.zip` file should be present.

4. **Inspect the zip contents manually:**
   ```sh
   # Download the zip from COS (or copy from a local proxy debug log)
   unzip -l e2e-test-agent-snapshot.zip
   ```
   Expected structure:
   ```
   manifest.json
   agent/agent.yaml
   tools/<tool-name>/tool.json
   tools/<tool-name>/source.py
   knowledge_bases/<kb-id>/kb.yaml
   knowledge_bases/<kb-id>/documents/<filename1>
   knowledge_bases/<kb-id>/documents/<filename2>
   connections/<conn-name>.yaml
   ```

5. **Open the popup:** Click the extension icon. Verify:
   - Session card shows `e2e-test-agent` and last-saved timestamp
   - Snapshot history list shows the captured snapshot
   - Restore button is enabled

6. **Run the preflight:** Click "Restore". Verify the preflight overlay shows:
   - Your connection listed under "Connections to re-credential"
   - No tools listed under "Tools with unavailable source" (since we uploaded a real `.py`)

7. **Confirm and restore:** In a **fresh wxO environment** (different tenant or cleared environment), click "Restore". Watch the progress overlay. Expected per-artefact log:
   ```
   connection:<conn-name>    ok       Imported
   tool:<tool-name>          ok       Imported
   knowledge_base:<kb-id>    ok       KB spec imported
   knowledge_base:<kb-id>/document:<filename1>  ok  Uploaded
   knowledge_base:<kb-id>/document:<filename2>  ok  Uploaded
   agent                     ok       Imported
   ```

8. **Verify in the fresh environment:** Confirm all four artefact types appear in the wxO Agent Builder UI.

### Pass criteria
- All artefacts re-created with correct names and metadata
- No duplicate artefacts on a second restore (FR-5.11 idempotency)
- Connection credentials NOT restored (expected — builder must re-enter via UI)

---

## 4. Test Scenario B — Proxy offline

**Goal:** Verify the popup degrades gracefully when the proxy is not running.

### Steps

1. Stop the proxy process.
2. Open the extension popup.

### Expected behaviour
- Yellow offline banner displayed: "Proxy offline — showing cached history. Restore unavailable."
- Session card shows the last agent from `chrome.storage.local` index (up to 5 entries)
- All "Restore" buttons are disabled with tooltip "Proxy offline — restore unavailable"

### Pass criteria
- No JavaScript errors in the extension popup console
- Extension does not crash or show a blank popup
- Offline banner is shown and Restore is disabled

---

## 5. Test Scenario C — Partial KB upload

**Goal:** Verify the assembler handles the case where a KB document upload (`PUT`) is captured before the KB metadata (`GET`) arrives.

### Steps

1. Create a new knowledge base with the first document. The `POST /knowledge-bases/documents` multipart request fires; the KB UUID is not known until the 201 response arrives.
2. Upload a second document immediately after creation via `PUT /knowledge-bases/{uuid}/documents`.
3. Verify both documents appear in the captured snapshot's KB entry.

### Expected behaviour
- Both document files appear under `knowledge_bases/<kb-id>/documents/` in the zip
- `kb.yaml` contains the correct KB ID
- No "Unknown KB" or missing KB entries in the zip

### Pass criteria
- Zip contains exactly 2 document files under the KB
- `kb.yaml` ID matches the UUID assigned by wxO

---

## 6. Test Scenario D — Catalog tool (sourceUnavailable)

**Goal:** Verify that catalog tools (added via the wxO UI, not hand-crafted) are flagged correctly and skipped gracefully during restore.

### Steps

1. Add a catalog tool to `e2e-test-agent` (any tool from the wxO catalog — these use `POST create-from-template`, not a multipart upload).
2. Save the agent. The assembler captures the tool metadata but cannot capture source files.
3. Click "Restore" in the popup.

### Expected behaviour — preflight
- The catalog tool name appears under "Tools with unavailable source (will be skipped)"

### Expected behaviour — restore progress
- `tool:<catalog-tool-name>   skipped   sourceUnavailable — skipped`

### Pass criteria
- Restore completes without error
- All other artefacts are restored correctly
- The catalog tool is NOT imported (as expected)
- The popup shows a clear skipped status for the catalog tool

---

## 7. Maintenance Notes

### If wxO API endpoint paths change

The extension intercepts responses based on URL patterns defined in two places:

1. **[`src/content/index.ts`](wxo-ui-agent-autosave/src/content/index.ts)** — the `fetch` interceptor's URL match conditions
2. **[`src/background/index.ts`](wxo-ui-agent-autosave/src/background/index.ts)** — `chrome.webRequest` URL filters (`KB_CREATE_URL_FILTER`, `KB_UPLOAD_URL_FILTER`, `TOOL_UPLOAD_URL_FILTER`)

**No business logic is hardcoded to specific paths.** Updating the extension to new API paths requires only editing the URL patterns in those two files.

### Confirmed endpoint paths (as of Aug 2026 HAR analysis)

| Resource | Confirmed path |
|---|---|
| Agent detail / save | `PATCH /mfe_builder/api/v1/builder/orchestrate/agents/{uuid}` |
| Tool batch fetch | `GET /mfe_builder/api/v2/builder/tools?ids={uuid}&...` |
| Connections list | `GET /mfe_builder/api/v1/orchestrate/connections/applications` |
| KB detail | `GET /mfe_builder/api/v1/orchestrate/knowledge-bases/{uuid}` |
| KB create + first doc | `POST /mfe_builder/api/v1/orchestrate/knowledge-bases/documents` |
| KB doc upload | `PUT /mfe_builder/api/v1/orchestrate/knowledge-bases/{uuid}/documents` |
| Tool file upload | `POST /mfe_builder/api/v2/builder/tools` (multipart) |

Re-verify these paths against a fresh HAR recording before any significant version update.

### ADK CLI command surface

Restore shells out to these `orchestrate` sub-commands:

| Artefact | Command |
|---|---|
| Connection | `orchestrate connections import --file <yaml>` |
| Python tool | `orchestrate tools import --kind python --file <py> [--requirements <txt>] [--app-id <id>]` |
| Knowledge base | `orchestrate knowledge-bases import --file <yaml>` |
| KB document | `orchestrate knowledge-bases upload-document --kb-id <id> --file <doc>` |
| Agent | `orchestrate agents import --file <yaml>` |

If the ADK CLI renames sub-commands, update [`src/restore.ts`](wxo-autosave-proxy/src/restore.ts) accordingly.
