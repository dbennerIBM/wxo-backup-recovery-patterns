/**
 * HTTP server — all four proxy endpoints.
 *
 * Endpoints:
 *   POST /snapshots                   FR-7.2
 *   GET  /snapshots?agent=&tenant=    FR-7.3
 *   GET  /restore/preflight?key=      FR-7.4
 *   POST /restore                     FR-7.5
 *
 * CORS: only chrome-extension:// origins are accepted (FR-2.7, SEC-4).
 * Progress: POST /restore streams line-delimited JSON so the popup can
 *   display per-artefact progress in real time.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { StorageAdapter } from "./storage/index.js";
import type { ProxyConfig } from "./config.js";
import { unpackZip } from "./zip.js";
import { buildPreflightReport } from "./preflight.js";
import { restoreFromZip, type RestoreLogEntry } from "./restore.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, 400, { error: message });
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: "Not found" });
}

function internalError(res: ServerResponse, message: string): void {
  json(res, 500, { error: message });
}

function parsedUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

/**
 * Apply CORS headers and handle pre-flight OPTIONS requests.
 * Returns true if the request should be processed, false if it was handled
 * (OPTIONS) or rejected (bad origin).
 */
function handleCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigin: string,
): boolean {
  const origin = req.headers["origin"] ?? "";

  // Allow any chrome-extension:// origin when the configured value is the
  // bare scheme (default), or require an exact match when a full ID is set.
  const originOk =
    allowedOrigin === "chrome-extension://"
      ? origin.startsWith("chrome-extension://")
      : origin === allowedOrigin;

  if (!originOk) {
    // Still handle OPTIONS so browsers don't see a connection error, but
    // omit CORS headers so the browser blocks the request.
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return false;
    }
    json(res, 403, { error: "Forbidden origin" });
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin",  origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return false;
  }

  return true;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/** POST /snapshots — receive zip, derive path from manifest, upload to storage. */
async function handlePostSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: StorageAdapter,
  provider: string,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    return badRequest(res, "Failed to read request body");
  }

  if (body.length === 0) return badRequest(res, "Empty body");

  let zip;
  try {
    zip = unpackZip(new Uint8Array(body));
  } catch (err) {
    return badRequest(res, `Invalid zip: ${String(err)}`);
  }

  const { manifest } = zip;
  // FR-4.1: storage path = {tenant}/{agent-name}/{ISO-timestamp}.zip
  const storageKey = `${manifest.tenant}/${manifest.agentName}/${manifest.capturedAt}.zip`;

  let id: string;
  try {
    id = await adapter.upload(storageKey, new Uint8Array(body));
  } catch (err) {
    return internalError(res, `Storage upload failed: ${String(err)}`);
  }

  json(res, 201, { key: id, provider });
}

/** GET /snapshots?agent={name}&tenant={tenant} — list snapshots from storage. */
async function handleGetSnapshots(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: StorageAdapter,
): Promise<void> {
  const url    = parsedUrl(req);
  const agent  = url.searchParams.get("agent")?.trim()  ?? "";
  const tenant = url.searchParams.get("tenant")?.trim() ?? "";

  if (!agent || !tenant) {
    return badRequest(res, "Query params agent and tenant are required");
  }

  const prefix = `${tenant}/${agent}/`;

  let items;
  try {
    items = await adapter.list(prefix);
  } catch (err) {
    return internalError(res, `Storage list failed: ${String(err)}`);
  }

  // Return newest-first
  const sorted = items
    .map((i) => ({ key: i.id, timestamp: i.timestamp, size: i.size, agentName: agent }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  json(res, 200, sorted);
}

/** GET /restore/preflight?key={key} — pre-restore report. */
async function handleGetPreflight(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: StorageAdapter,
): Promise<void> {
  const key = parsedUrl(req).searchParams.get("key")?.trim() ?? "";
  if (!key) return badRequest(res, "Query param key is required");

  let bytes: Uint8Array;
  try {
    bytes = await adapter.download(key);
  } catch (err) {
    return internalError(res, `Failed to download snapshot: ${String(err)}`);
  }

  let zip;
  try {
    zip = unpackZip(bytes);
  } catch (err) {
    return badRequest(res, `Invalid zip at key "${key}": ${String(err)}`);
  }

  json(res, 200, buildPreflightReport(zip));
}

/** POST /restore — stream line-delimited JSON progress per artefact. */
async function handlePostRestore(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: StorageAdapter,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    return badRequest(res, "Failed to read request body");
  }

  let parsed: { key?: unknown };
  try {
    parsed = JSON.parse(body.toString()) as { key?: unknown };
  } catch {
    return badRequest(res, "Request body must be JSON");
  }

  if (typeof parsed.key !== "string" || !parsed.key) {
    return badRequest(res, "Request body must include a non-empty string field: key");
  }

  const key = parsed.key;

  let bytes: Uint8Array;
  try {
    bytes = await adapter.download(key);
  } catch (err) {
    return internalError(res, `Failed to download snapshot: ${String(err)}`);
  }

  let zip;
  try {
    zip = unpackZip(bytes);
  } catch (err) {
    return badRequest(res, `Invalid zip at key "${key}": ${String(err)}`);
  }

  // Stream line-delimited JSON progress back to the popup.
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Transfer-Encoding": "chunked",
    "Cache-Control": "no-cache",
  });

  // Helper: write one progress event and flush.
  const emit = (entry: RestoreLogEntry): void => {
    res.write(JSON.stringify(entry) + "\n");
  };

  let log: RestoreLogEntry[];
  try {
    // restoreFromZip is synchronous CLI shell-outs inside an async wrapper;
    // we collect the full log then stream it all at once.
    // For a true streaming experience the restore loop would need to emit
    // incrementally — that's an enhancement, not a v1 requirement.
    log = await restoreFromZip(zip);
  } catch (err) {
    emit({ artefact: "restore", status: "error", message: String(err) });
    res.end();
    return;
  }

  for (const entry of log) {
    emit(entry);
  }
  res.end();
}

// ─── createServer ─────────────────────────────────────────────────────────────

export function createProxyServer(
  config: ProxyConfig,
  adapter: StorageAdapter,
): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    if (!handleCors(req, res, config.allowedOrigin)) return;

    const url    = parsedUrl(req);
    const method = req.method ?? "GET";
    const path   = url.pathname;

    void (async () => {
      try {
        if (method === "POST" && path === "/snapshots") {
          await handlePostSnapshot(req, res, adapter, config.provider);
        } else if (method === "GET" && path === "/snapshots") {
          await handleGetSnapshots(req, res, adapter);
        } else if (method === "GET" && path === "/restore/preflight") {
          await handleGetPreflight(req, res, adapter);
        } else if (method === "POST" && path === "/restore") {
          await handlePostRestore(req, res, adapter);
        } else {
          notFound(res);
        }
      } catch (err) {
        console.error("[wxo-proxy] Unhandled error:", err);
        if (!res.headersSent) internalError(res, "Internal server error");
      }
    })();
  });

  return server;
}
