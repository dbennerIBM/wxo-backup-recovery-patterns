# Setup Guide — New Machine

This guide walks through setting up the full wxO Backup & Recovery system on a new computer. It covers both components: the Chrome extension (`wxo-ui-agent-autosave`) and the local proxy server (`wxo-autosave-proxy`), with detailed instructions for the watsonx Orchestrate ADK CLI dependency.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 22.9 | Required by the proxy (`engines` field enforces this) |
| npm | ≥ 10 | Comes with Node 22 |
| Python | ≥ 3.9 | Required for the ADK CLI |
| Chrome or Edge | Any current | For the browser extension |
| Git | Any | To clone the repo |

---

## 1. Clone the repository

```bash
git clone <your-repo-url> wxo-backup-recovery-patterns
cd wxo-backup-recovery-patterns
```

---

## 2. Install the watsonx Orchestrate ADK CLI

This is the most important prerequisite for the proxy server. The proxy calls `orchestrate` commands at restore time and **validates that the CLI is installed and an environment is active at startup** — it will refuse to start without it.

### 2a. Install the CLI

```bash
pip install ibm-watsonx-orchestrate
```

Verify it installed correctly:

```bash
orchestrate --version
```

You should see version output. If you get `command not found`, your Python `bin` directory is not on your PATH. Fix that before continuing.

### 2b. Log in to your IBM Cloud account

The ADK needs your IBM Cloud credentials before you can create or activate an environment.

```bash
orchestrate login --apikey <your-ibm-cloud-api-key>
```

Alternatively, log in interactively (opens browser):

```bash
orchestrate login
```

### 2c. Create and activate an environment

An ADK "environment" points the CLI at a specific wxO tenant. You must activate one before starting the proxy — the proxy checks this at startup with `orchestrate env list`.

List existing environments (if you've used the ADK before on another machine, you may need to recreate them):

```bash
orchestrate env list
```

Create a new environment pointing at your wxO tenant:

```bash
orchestrate env create \
  --name <env-name> \
  --url  <your-wxo-instance-url>
```

The `--url` is your watsonx Orchestrate instance URL, e.g. `https://dl.watson-orchestrate.cloud.ibm.com/<your-tenant-id>`.

Activate the environment:

```bash
orchestrate env activate <env-name>
```

Confirm it's active — the active environment is starred in the list output:

```bash
orchestrate env list
```

> **Note:** The proxy runs `orchestrate env list` on startup to confirm this step is done. If it exits immediately with `"No ADK environment is activated"`, come back here.

---

## 3. Set up the proxy server (`wxo-autosave-proxy`)

### 3a. Install dependencies

```bash
cd wxo-autosave-proxy
npm install
```

### 3b. Configure environment variables

Copy the example env file:

```bash
cp .env.example .env
```

Open `.env` and fill in the values for your storage provider. The proxy supports three providers:

---

#### Option A — IBM Cloud Object Storage (default, `STORAGE_PROVIDER=cos`)

```bash
PORT=7878
STORAGE_PROVIDER=cos
BUCKET=my-snapshot-bucket

COS_ENDPOINT=https://s3.us-south.cloud-object-storage.appdomain.cloud
COS_ACCESS_KEY_ID=<your-hmac-access-key>
COS_SECRET_ACCESS_KEY=<your-hmac-secret-key>
```

To get HMAC credentials for COS:
1. Open your IBM Cloud Object Storage instance in the IBM Cloud console
2. Go to **Service credentials** → **New credential**
3. Enable **Include HMAC Credential** in the advanced options
4. Copy the `access_key_id` and `secret_access_key` from the generated credential

The `COS_ENDPOINT` is the regional endpoint for your bucket, e.g.:
- US South: `https://s3.us-south.cloud-object-storage.appdomain.cloud`
- EU GB: `https://s3.eu-gb.cloud-object-storage.appdomain.cloud`

---

#### Option B — AWS S3 (`STORAGE_PROVIDER=s3`)

```bash
PORT=7878
STORAGE_PROVIDER=s3
BUCKET=my-snapshot-bucket

AWS_ACCESS_KEY_ID=<your-access-key>
AWS_SECRET_ACCESS_KEY=<your-secret-key>
AWS_REGION=us-east-1
# AWS_ENDPOINT_URL=   # optional, for custom S3-compatible endpoints
```

---

#### Option C — Google Cloud Storage (`STORAGE_PROVIDER=gcs`)

GCS is accessed via its S3-compatible interoperability API using HMAC keys.

```bash
PORT=7878
STORAGE_PROVIDER=gcs
BUCKET=my-snapshot-bucket

GCS_ACCESS_KEY_ID=<your-hmac-access-key>
GCS_SECRET_ACCESS_KEY=<your-hmac-secret-key>
# GCS_ENDPOINT defaults to https://storage.googleapis.com
```

To get GCS HMAC keys: Cloud Console → Cloud Storage → Settings → Interoperability → Service account HMAC keys.

---

#### CORS lock-down (optional but recommended)

By default, `ALLOWED_ORIGIN=chrome-extension://` allows any Chrome extension to talk to the proxy. Once you have the extension installed and know its ID (visible in `chrome://extensions`), lock it down:

```bash
ALLOWED_ORIGIN=chrome-extension://<your-32-char-extension-id>
```

---

### 3c. Start the proxy

```bash
npm start
```

The proxy starts on `http://127.0.0.1:7878` by default. On startup it will:

1. Run `orchestrate --version` — fails if the CLI is not installed
2. Run `orchestrate env list` — fails if no environment is activated
3. Validate all required env vars — fails with a clear message if anything is missing
4. Log the active storage provider, bucket, and allowed origin

Expected startup output:

```
[wxo-proxy] ADK CLI validated
[wxo-proxy] Storage: cos  bucket: my-snapshot-bucket
[wxo-proxy] Listening on http://127.0.0.1:7878
```

If the proxy exits immediately, read the error — it will tell you exactly what is missing.

---

### 3d. (Optional) Run the proxy tests

```bash
npm test
```

109 tests covering server routes, restore logic, transform, zip parsing, storage, and config. All should pass before you use the proxy in production.

---

## 4. Build and load the Chrome extension (`wxo-ui-agent-autosave`)

### 4a. Install dependencies and build

```bash
cd ../wxo-ui-agent-autosave
npm install
npm run build
```

This produces a `dist/` folder containing the built extension.

To rebuild automatically when you edit source files (useful during development):

```bash
npm run dev
```

### 4b. Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `wxo-ui-agent-autosave/dist/` directory
5. The extension appears as **wxO Agent Builder Autosave**
6. Pin it to the toolbar for easy access

### 4c. (Optional) Run the extension tests

```bash
npm test
```

385 tests covering the shared utilities (capture, scrubber, multipart decoder, OpenAPI synthesis, zip building). These are pure unit tests with no browser dependencies.

---

## 5. Configure the extension popup

Click the extension icon in Chrome to open the popup.

In the **Settings** panel:

| Setting | Default | Notes |
|---|---|---|
| Proxy port | `7878` | Must match the `PORT` in your `.env` |
| Debounce delay | `3000` ms | Time after last API activity before a snapshot is assembled |

The popup will show **"Proxy connected"** once it can reach `http://127.0.0.1:7878/health`.

---

## 6. Verify the full system

1. Start the proxy (`npm start` in `wxo-autosave-proxy/`)
2. Load the extension in Chrome
3. Navigate to your watsonx Orchestrate Agent Builder tenant
4. Open any agent — the extension silently intercepts API traffic
5. After the debounce delay (default 3 s), a snapshot zip is assembled and POSTed to the proxy
6. The proxy uploads the zip to your configured storage bucket
7. Open the extension popup — you should see the snapshot listed under the agent name

To test a restore:
1. Click a snapshot in the popup history
2. Review the **preflight report** — it lists connections that will need re-credentialing
3. Click **Restore** — the popup streams live per-item progress
4. After restore completes, re-enter credentials for any connections in wxO

---

## 7. Snapshot storage layout

Snapshots are stored in your bucket at:

```
{tenant}/{agent-name}/{ISO-8601-timestamp}.zip
```

Example:
```
myorg-us-south/my-sales-agent/2026-08-15T12:00:00.000Z.zip
```

Each zip contains:

```
{capturedAt}.zip
├── manifest.json                          # metadata (agent name, tenant, timestamp)
├── agent/agent.yaml
├── tools/{name}/tool.json
├── tools/{name}/spec.yaml                 # OpenAPI tools
├── tools/{name}/source.py                 # Python tools
├── tools/{name}/requirements.txt
├── knowledge_bases/{kb-id}/kb.yaml
├── knowledge_bases/{kb-id}/documents/...
└── connections/{app_id}.yaml              # metadata only — no credentials stored
```

---

## 8. ADK restore details

When you trigger a restore from the popup, the proxy:

1. Downloads the snapshot zip from storage
2. Unpacks it to a temporary directory
3. Invokes ADK CLI commands in **mandatory dependency order**:
   - `orchestrate connections import --file connection.yaml`
   - `orchestrate tools import --kind python|openapi --file source.py|spec.yaml`
   - `orchestrate knowledge-bases import --file kb.yaml`
   - `orchestrate agents import --file agent.yaml`
4. Streams a JSON progress entry per artefact to the popup:
   ```json
   { "artefact": "tool:my_tool", "status": "ok", "message": "Imported" }
   ```
5. Cleans up the temporary directory

Status values: `ok`, `skipped`, `error`.

**Important:** Connections are restored without credentials — you must re-enter credentials for each connection in the wxO UI after restore. The preflight report (shown before you confirm the restore) tells you exactly which connections need re-credentialing.

If a connection import returns a 409 (already exists), the proxy treats it as `skipped` — this is safe and expected when restoring to a tenant where the connection already exists.

---

## 9. Troubleshooting

### Proxy won't start: `ADK CLI not found on PATH`

The `orchestrate` binary is not on your PATH. Locate your Python environment's bin directory and add it:

```bash
# Find where orchestrate was installed
pip show ibm-watsonx-orchestrate | grep Location
# Add the bin directory to your PATH in ~/.zshrc or ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
```

### Proxy won't start: `No ADK environment is activated`

You need to activate an environment before starting the proxy:

```bash
orchestrate env list           # see available environments
orchestrate env activate <name>
```

If no environments exist, create one first (see section 2c above).

### Proxy won't start: `Missing required environment variable`

Check your `.env` file — the error message names the specific variable. Make sure you copied `.env.example` to `.env` and filled in all required fields for your chosen storage provider.

### Extension popup shows "Proxy unreachable"

- Confirm the proxy is running (`npm start`)
- Confirm the port in the popup settings matches `PORT` in `.env` (default `7878`)
- Check that nothing else is listening on that port: `lsof -i :7878`

### Snapshots not appearing after browsing wxO

- Confirm the extension is loaded and enabled in `chrome://extensions`
- The extension only intercepts traffic on `*.watson-orchestrate.cloud.ibm.com` and `*.watson-orchestrate.ibm.com` — confirm your tenant URL matches
- Wait for the debounce delay (default 3 s after the last API call)
- Check the Chrome DevTools service worker console for errors: `chrome://extensions` → **Inspect views: service worker**

### Restore fails with `orchestrate agents import` error

- Confirm the activated ADK environment points at the correct tenant
- Re-run `orchestrate env list` to check which environment is active
- If the environment URL changed, create a new environment pointing at the correct URL and activate it, then restart the proxy

---

## 10. Running tests for both packages

```bash
# From the repo root:
cd wxo-ui-agent-autosave && npm test
cd ../wxo-autosave-proxy && npm test
```

Combined: 494 tests. All should pass on a clean install.
