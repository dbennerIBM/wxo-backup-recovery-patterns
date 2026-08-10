# wxO Backup & Recovery Patterns

> **An open-source browser extension + local proxy that gives IBM watsonx Orchestrate Agent Builders automatic, versioned backup and one-click restore — with zero changes to their workflow.**

[![Status: Active Development](https://img.shields.io/badge/status-active%20development-blue)](https://github.com/dbenner/wxo-backup-recovery-patterns/issues)
[![Contributions Welcome](https://img.shields.io/badge/contributions-welcome-brightgreen)](CONTRIBUTING.md)

---

## The Problem

IBM watsonx Orchestrate (wxO) provides a powerful Agent Builder UI, but **there is no built-in backup or version history**. Accidentally overwriting an agent, deleting a tool, or needing to migrate to a new tenant means rebuilding from scratch.

## The Solution

A **Chrome/Edge browser extension** (Manifest V3) paired with a **local proxy server** that:

1. **Passively captures** every meaningful change in the Agent Builder UI — agent definitions, tools, knowledge bases, and connection metadata (never credentials)
2. **Stores versioned snapshots** as zip archives in a pluggable storage backend — IBM COS, AWS S3, GCP Cloud Storage, Azure Blob, or **Google Drive**
3. **Restores** any prior state with one click, using the ADK CLI to re-import all artefacts in the correct dependency order

No changes to how you build. No manual export steps. Just an always-on safety net.

---

## Repository Structure

```
wxo-agent-backup-recovery-requirements.md   ← Full project requirements (start here)
wxo-ui-agent-autosave/                      ← Chrome/Edge extension source
  src/
    background/     ← MV3 service worker: network interception & snapshot assembly
    content/        ← Content script: fetch interceptor
    popup/          ← Extension popup UI
    proxy-server/   ← Local proxy server (to be implemented — see requirements)
    shared/         ← Pure utilities: credential scrubber, multipart decoder
  wxo-autosave-extension-plan.md            ← Detailed implementation sub-task plan
```

---

## Current Status

| Component | Status |
|---|---|
| Project scaffold (Vite, MV3, TypeScript) | ✅ Complete |
| Network interception layer (content script + webRequest) | ✅ Complete |
| Credential scrubber + multipart decoder (with tests) | ✅ Complete |
| Snapshot assembler + debounce engine | 🔲 Not started |
| Zip serialiser + snapshot format | 🔲 Not started |
| Popup UI | 🔲 Not started (scaffold only) |
| Local proxy server — S3-compatible adapter (IBM COS / AWS S3 / GCS) | 🔲 Not started |
| Local proxy server — Google Drive adapter (OAuth 2.0 + Drive API v3) | 🔲 Not started |
| Integration testing | 🔲 Not started |

---

## Getting Started

### Prerequisites

- Node.js 20+
- Chrome or Edge (for side-loading the extension)
- IBM watsonx Orchestrate ADK CLI (for restore operations)

### Build the Extension

```bash
cd wxo-ui-agent-autosave
npm install
npm run build
```

Load `wxo-ui-agent-autosave/dist/` as an unpacked extension in `chrome://extensions`.

### Run Tests

```bash
cd wxo-ui-agent-autosave
npm test
```

---

## Contributing

**We are actively looking for collaborators!** The best place to start is the [requirements document](wxo-agent-backup-recovery-requirements.md), which has a full list of functional and non-functional requirements with IDs, plus a [Contributing section](wxo-agent-backup-recovery-requirements.md#12-contributing) that lists good first issues.

Quick links:
- 📋 [Full Requirements](wxo-agent-backup-recovery-requirements.md)
- 🗺️ [Implementation Plan](wxo-ui-agent-autosave/wxo-autosave-extension-plan.md)
- 🐛 [Open an Issue](https://github.com/dbenner/wxo-backup-recovery-patterns/issues)

### Good First Issues
- **Verify wxO API endpoint paths** against a live SaaS session (see Open Decision OD-5 in the requirements)
- **Implement the Snapshot Assembler** (Sub-Task 3 in the plan)
- **Implement the Zip Serialiser** using `fflate` (Sub-Task 4 in the plan)
- **Choose and scaffold the proxy server** — Node/Express, Python/FastAPI, or Go/chi (Sub-Task 6 in the plan)
- **Implement the Google Drive storage adapter** (FR-4.6) — requires a Google Cloud project; see Open Decision OD-4 in the requirements for the OAuth flow UX choice

---

## Security

Credential safety is a hard requirement of this project. **No API keys, passwords, tokens, or OAuth secrets are ever captured, stored, or transmitted.** Connections are captured as metadata only (name, auth scheme type, server URL). See [Security Requirements](wxo-agent-backup-recovery-requirements.md#8-security-requirements) for the full specification.

---

## License

MIT
