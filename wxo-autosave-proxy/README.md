# wxO Autosave Proxy

Local HTTP proxy server for the **wxO Agent Builder Autosave** Chrome extension.

The proxy runs on your machine alongside your browser. It receives snapshot zips from the extension, stores them in IBM Cloud Object Storage (or AWS S3 / GCS), and executes one-click restores using the watsonx Orchestrate ADK CLI.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 22 |
| IBM watsonx Orchestrate ADK CLI | latest |

The ADK CLI must be installed **and** an environment must be activated before the proxy will start:

```sh
pip install ibm-watsonx-orchestrate
orchestrate env activate <your-env-name>
```

---

## Quick Start

```sh
# 1. Install dependencies
cd wxo-autosave-proxy
npm install

# 2. Set environment variables (see reference below)
export STORAGE_PROVIDER=cos
export BUCKET=my-snapshot-bucket
export COS_ENDPOINT=https://s3.us-south.cloud-object-storage.appdomain.cloud
export COS_ACCESS_KEY_ID=<your-hmac-access-key>
export COS_SECRET_ACCESS_KEY=<your-hmac-secret-key>
export COS_INSTANCE_CRN=<your-cos-instance-crn>   # optional but recommended

# 3. Start the proxy
npm start
```

The proxy listens on `http://127.0.0.1:7878` by default.

---

## Environment Variable Reference

### General

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7878` | Port the proxy listens on. Match this to the port in the extension's Settings panel. |
| `STORAGE_PROVIDER` | *(required)* | Storage backend. Valid values: `cos`, `s3`, `gcs`. |
| `BUCKET` | *(required)* | Bucket name for all providers. |
| `ALLOWED_ORIGIN` | `chrome-extension://` | Full `chrome-extension://<id>` origin to lock CORS to a specific extension install. Leave as default to allow any extension origin. |

### IBM Cloud Object Storage (`cos`)

| Variable | Required | Description |
|---|---|---|
| `COS_ENDPOINT` | ✓ | Regional COS endpoint, e.g. `https://s3.us-south.cloud-object-storage.appdomain.cloud` |
| `COS_ACCESS_KEY_ID` | ✓ | HMAC credential access key (from the COS service credentials page, with HMAC enabled) |
| `COS_SECRET_ACCESS_KEY` | ✓ | HMAC credential secret key |
| `COS_INSTANCE_CRN` | | Service instance CRN — required for bucket-level operations on some COS configurations |
| `AWS_REGION` | `us-south` | COS region code |

### AWS S3 (`s3`)

| Variable | Required | Description |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | ✓ | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | ✓ | AWS secret key |
| `AWS_REGION` | ✓ | AWS region, e.g. `us-east-1` |
| `AWS_ENDPOINT_URL` | | Optional custom endpoint (e.g. for LocalStack) |

### Google Cloud Storage — S3 interoperability (`gcs`)

| Variable | Required | Description |
|---|---|---|
| `GCS_ACCESS_KEY_ID` | ✓ | GCS HMAC access key (from Cloud Storage → Settings → Interoperability) |
| `GCS_SECRET_ACCESS_KEY` | ✓ | GCS HMAC secret |
| `GCS_ENDPOINT` | | Defaults to `https://storage.googleapis.com` |
| `AWS_REGION` | | GCS region, e.g. `us-central1` |

---

## Snapshot Storage Path

Snapshots are stored at:

```
{tenant}/{agent-name}/{ISO-8601-timestamp}.zip
```

Example:
```
myorg-us-south/my-sales-agent/2026-08-15T12:00:00.000Z.zip
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/snapshots` | Receive a zip from the extension, derive path from `manifest.json`, upload to storage. Returns `{ key, provider }`. |
| `GET` | `/snapshots?agent=&tenant=` | List all snapshots for an agent. Returns `[{ key, timestamp, size, agentName }]`, newest first. |
| `GET` | `/restore/preflight?key=` | Pre-restore report: connections to re-credential, tools with unavailable source. |
| `POST` | `/restore` | Execute restore. Body: `{ "key": "<storage-key>" }`. Streams line-delimited JSON progress. |

### Restore progress format

Each line is a JSON object:

```jsonc
{ "artefact": "connection:my-conn",  "status": "ok",      "message": "Imported" }
{ "artefact": "tool:my_python_tool", "status": "ok",      "message": "Imported" }
{ "artefact": "tool:catalog-tool",   "status": "skipped", "message": "sourceUnavailable — skipped" }
{ "artefact": "agent",               "status": "ok",      "message": "Imported" }
```

`status` is one of: `ok`, `skipped`, `error`.

---

## CORS

The proxy only accepts requests from `chrome-extension://` origins by default. To lock it to a specific extension installation, set `ALLOWED_ORIGIN` to the exact origin string shown in `chrome://extensions` for your extension (e.g. `chrome-extension://abcdefghijklmnopqrstuvwxyz012345`).

---

## Building (optional)

The proxy can run directly from TypeScript source using Node 22's built-in strip-types flag (`npm start`), or compiled to plain JS first:

```sh
npm run build        # compiles src/ → dist/
npm run start:compiled  # runs dist/index.js
```

---

## Google Drive Support

Google Drive (`gdrive`) is planned for a future release. Set `STORAGE_PROVIDER=gdrive` and the proxy will tell you it's not yet supported.
