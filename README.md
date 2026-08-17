# wxO Backup & Recovery Patterns

> **A browser extension + local proxy that gives IBM watsonx Orchestrate Agent Builders automatic, versioned backup and one-click restore — with zero changes to their workflow.**

---

## The Problem

IBM watsonx Orchestrate (wxO) provides a powerful Agent Builder UI, but **there is no built-in backup or version history**. Accidentally overwriting an agent, deleting a tool, or needing to migrate to a new tenant means rebuilding from scratch.

## The Solution

A **Chrome/Edge browser extension** (Manifest V3) paired with a **local proxy server** that:

1. **Passively captures** every meaningful change in the Agent Builder UI — agent definitions, tools, knowledge bases, and connection metadata (never credentials)
2. **Stores versioned snapshots** as zip archives in a pluggable storage backend — IBM COS, AWS S3, or GCP Cloud Storage
3. **Restores** any prior state with one click, using the ADK CLI to re-import all artefacts in the correct dependency order

No changes to how you build. No manual export steps. Just an always-on safety net.

---

## Architecture

```
Browser Extension (Manifest V3)
├── Content Script (MAIN world)
│   └── Overrides fetch + XHR to intercept wxO API traffic
├── Bridge Script (ISOLATED world)
│   └── Relays captured events to the background service worker
├── Background Service Worker
│   ├── Snapshot Assembler: coalesces events, debounces, builds zip
│   └── POSTs snapshots to the local proxy
└── Popup UI
    ├── Session card, snapshot history, settings
    └── Restore flow: preflight → confirm → progress stream

Local Proxy Server (Node.js)
├── POST /snapshots     Upload a snapshot zip to storage
├── GET  /snapshots     List snapshots for an agent
├── GET  /restore/preflight   Pre-restore report
├── POST /restore       Execute restore via ADK CLI (NDJSON progress)
└── GET  /health        Liveness probe

Storage Backends
├── IBM Cloud Object Storage (HMAC auth)
├── AWS S3
└── Google Cloud Storage (S3-compatible HMAC auth)
```

---

## Repository Structure

```
wxo-agent-backup-recovery-requirements.md   ← Full project requirements (v1.4)
CHANGELOG.md                                ← Version history
TESTING.md                                  ← E2E testing runbook

wxo-ui-agent-autosave/                      ← Chrome/Edge extension
  src/
    background/     ← Service worker: event dispatch, snapshot assembler
    content/        ← MAIN-world fetch/XHR interceptor + ISOLATED-world bridge
    popup/          ← Extension popup UI (session, history, restore, settings)
    shared/         ← Pure utilities: scrubber, multipart decoder, zip, capture helpers
  manifest.json

wxo-autosave-proxy/                         ← Local proxy server
  src/
    storage/        ← Pluggable storage adapters (COS / S3 / GCS)
    server.ts       ← HTTP server with 4 endpoints + CORS enforcement
    restore.ts      ← ADK CLI restore with NDJSON progress streaming
    preflight.ts    ← Pre-restore report generation
  README.md         ← Proxy-specific docs, env var reference, API details
  .env.example      ← Configuration template
```

---

## Current Status

| Component | Status |
|---|---|
| Extension scaffold (Vite, MV3, TypeScript) | ✅ Complete |
| Network capture — MAIN-world fetch + XHR interception | ✅ Complete |
| PostMessage bridge (MAIN → ISOLATED → background) | ✅ Complete |
| Credential scrubber (inline + background defence-in-depth) | ✅ Complete |
| Multipart decoder (KB / tool uploads) | ✅ Complete |
| Snapshot assembler + debounce engine | ✅ Complete |
| Zip serialiser (`fflate`) | ✅ Complete |
| Popup UI (session, history, restore flow, settings) | ✅ Complete |
| Local proxy server — all 4 endpoints | ✅ Complete |
| Storage adapters — IBM COS, AWS S3, GCS | ✅ Complete |
| Unit tests — 443 total (359 extension + 84 proxy) | ✅ All passing |
| E2E test runbook (4 scenarios) | ✅ Complete |
| Google Drive storage adapter | 🔲 Planned |
| Azure Blob storage adapter | 🔲 Planned |
| Chrome Web Store distribution | 🔲 Side-load only for now |

---

## Getting Started

### Prerequisites

- Node.js 20+ (proxy requires ≥ 22.9)
- Chrome or Edge (for side-loading the extension)
- IBM watsonx Orchestrate ADK CLI, installed and authenticated (`orchestrate env activate <env>`)

### Build & Load the Extension

```bash
cd wxo-ui-agent-autosave
npm install
npm run build
```

Load `wxo-ui-agent-autosave/dist/` as an unpacked extension in `chrome://extensions`.

### Start the Proxy

```bash
cd wxo-autosave-proxy
npm install
cp .env.example .env   # edit with your storage credentials
npm start
```

The proxy listens on `http://127.0.0.1:7878` by default. See [wxo-autosave-proxy/README.md](wxo-autosave-proxy/README.md) for the full environment variable reference and API documentation.

### Run Tests

```bash
cd wxo-ui-agent-autosave && npm test
cd ../wxo-autosave-proxy && npm test
```

---

## Security

Credential safety is a hard requirement. **No API keys, passwords, tokens, or OAuth secrets are ever captured, stored, or transmitted.** Connections are captured as metadata only (name, auth scheme type, server URL). After a restore, the builder re-enters credentials through the wxO UI. See [Security Requirements](wxo-agent-backup-recovery-requirements.md#8-security-requirements) for the full specification.

The proxy enforces CORS — only `chrome-extension://` origins are accepted. Non-browser clients cannot reach the restore endpoint, which shells out to the ADK CLI.

---

## Contributing

Contributions are welcome. The best place to start is the [requirements document](wxo-agent-backup-recovery-requirements.md).

Quick links:
- [Full Requirements](wxo-agent-backup-recovery-requirements.md)
- [Extension Implementation Plan](wxo-ui-agent-autosave/wxo-autosave-extension-plan.md)
- [Proxy Documentation](wxo-autosave-proxy/README.md)
- [E2E Testing Runbook](TESTING.md)
- [Changelog](CHANGELOG.md)

### Open Contributions

- **Google Drive storage adapter** — OAuth 2.0 + Drive API v3 (specified in FR-4.6)
- **Azure Blob storage adapter** — interface is ready, implementation needed
- **Chrome Web Store packaging** — icons, store listing, review preparation
- **Wire `debounceMs` setting** — popup saves the value but the assembler doesn't read it yet

---

## License

MIT
