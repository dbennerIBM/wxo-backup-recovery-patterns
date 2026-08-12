/**
 * Popup panel — Sub-Task 5.
 *
 * Responsibilities:
 *  1. Read settings from chrome.storage.sync (proxy port, debounce, bucket prefix).
 *  2. Read the recent-snapshot index from chrome.storage.local.
 *  3. Attempt GET /snapshots?agent=&tenant= from the proxy; fall back to the
 *     local index if the proxy is offline. Show the offline banner in that case.
 *  4. Render the current-session card and snapshot history list.
 *  5. Restore flow: preflight → credentials checklist → confirm → progress stream.
 *  6. Settings panel: read / save settings via chrome.storage.sync.
 *
 * All communication with the service worker goes through chrome.storage;
 * no chrome.runtime.sendMessage is needed for the current data model.
 */

import {
  RECENT_SNAPSHOTS_KEY,
  type RecentSnapshotEntry,
} from "../shared/index";
import {
  readSettings,
  writeSettings,
  mergeSettings,
  type PopupSettings,
} from "../shared/settings";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A snapshot row returned by the proxy GET /snapshots endpoint. */
interface ProxySnapshotRow {
  key: string;
  agentName: string;
  tenant: string;
  timestamp: string;
  size?: number;
}

/** Preflight report returned by GET /restore/preflight?key={key}. */
interface PreflightReport {
  connections_to_recredential: Array<{ app_id: string; kind: string; server_url?: string }>;
  tools_source_unavailable: string[];
  restore_order: string[];
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function show(id: string): void  { el(id).hidden = false; }
function hide(id: string): void  { el(id).hidden = true; }
function text(id: string, value: string): void { el(id).textContent = value; }

/** Format an ISO timestamp as a short human-readable string. */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ─── Proxy helpers ────────────────────────────────────────────────────────────

async function fetchProxySnapshots(
  port: number,
  agentName: string,
  tenant: string,
): Promise<ProxySnapshotRow[] | null> {
  const url = `http://localhost:${port}/snapshots?agent=${encodeURIComponent(agentName)}&tenant=${encodeURIComponent(tenant)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()) as ProxySnapshotRow[];
  } catch {
    return null;  // offline or timeout
  }
}

async function fetchPreflight(
  port: number,
  key: string,
): Promise<PreflightReport | null> {
  const url = `http://localhost:${port}/restore/preflight?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as PreflightReport;
  } catch {
    return null;
  }
}

async function postRestore(
  port: number,
  key: string,
): Promise<Response | null> {
  const url = `http://localhost:${port}/restore`;
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
  } catch {
    return null;
  }
}

// ─── Session card ─────────────────────────────────────────────────────────────

function renderSessionCard(recent: RecentSnapshotEntry[]): void {
  const latest = recent[0];
  if (!latest) {
    text("session-agent", "—");
    text("session-status", "No activity yet");
    text("session-saved", "");
    return;
  }
  text("session-agent", latest.agentName);
  text("session-status", "Last saved");
  text("session-saved", formatTime(latest.capturedAt));
  const dot = el("status-dot");
  dot.classList.remove("status-dot--saving", "status-dot--error");
  dot.classList.add("status-dot--saved");
}

// ─── Snapshot list ────────────────────────────────────────────────────────────

function renderSnapshotList(
  rows: Array<ProxySnapshotRow | RecentSnapshotEntry>,
  proxyOnline: boolean,
  port: number,
  onRestore: (key: string, agentName: string) => void,
): void {
  const list = el<HTMLUListElement>("snapshot-list");

  // Clear everything except the static empty placeholder (re-used below)
  while (list.firstChild) list.removeChild(list.firstChild);

  if (rows.length === 0) {
    const empty = document.createElement("li");
    empty.className = "snapshot-empty";
    empty.textContent = "No snapshots yet.";
    list.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const isProxy = "key" in row;
    const key         = isProxy ? (row as ProxySnapshotRow).key : "";
    const agentName   = isProxy ? (row as ProxySnapshotRow).agentName  : (row as RecentSnapshotEntry).agentName;
    const timestamp   = isProxy ? (row as ProxySnapshotRow).timestamp  : (row as RecentSnapshotEntry).capturedAt;

    const li   = document.createElement("li");
    li.className = "snapshot-row";

    const info = document.createElement("div");
    info.className = "snapshot-info";

    const nameEl = document.createElement("div");
    nameEl.className = "snapshot-agent";
    nameEl.textContent = agentName;

    const timeEl = document.createElement("div");
    timeEl.className = "snapshot-time";
    timeEl.textContent = formatTime(timestamp);

    info.appendChild(nameEl);
    info.appendChild(timeEl);
    li.appendChild(info);

    const btn = document.createElement("button");
    btn.className = "btn btn--restore";
    btn.textContent = "Restore";
    btn.disabled = !proxyOnline || !isProxy;
    btn.title = !proxyOnline
      ? "Proxy offline — restore unavailable"
      : !isProxy
        ? "Full snapshot key unavailable in local cache"
        : "";

    if (proxyOnline && isProxy && key) {
      btn.addEventListener("click", () => onRestore(key, agentName));
    }

    li.appendChild(btn);
    list.appendChild(li);
  }
}

// ─── Restore preflight overlay ────────────────────────────────────────────────

let pendingRestoreKey   = "";
let pendingRestoreName  = "";
let currentPort         = 7878;

function showPreflightOverlay(key: string, agentName: string, report: PreflightReport): void {
  pendingRestoreKey  = key;
  pendingRestoreName = agentName;

  el("preflight-key").textContent = key;

  const connSection = el("preflight-connections-section");
  const connList    = el<HTMLUListElement>("preflight-connections");
  connList.innerHTML = "";

  if (report.connections_to_recredential.length > 0) {
    connSection.hidden = false;
    for (const conn of report.connections_to_recredential) {
      const li = document.createElement("li");
      li.textContent = `${conn.app_id} — ${conn.kind}`;
      connList.appendChild(li);
    }
  } else {
    connSection.hidden = true;
  }

  const unavailSection = el("preflight-unavailable-section");
  const unavailList    = el<HTMLUListElement>("preflight-unavailable");
  unavailList.innerHTML = "";

  if (report.tools_source_unavailable.length > 0) {
    unavailSection.hidden = false;
    for (const toolName of report.tools_source_unavailable) {
      const li = document.createElement("li");
      li.textContent = toolName;
      unavailList.appendChild(li);
    }
  } else {
    unavailSection.hidden = true;
  }

  show("overlay-preflight");
}

function hidePreflightOverlay(): void {
  hide("overlay-preflight");
  pendingRestoreKey  = "";
  pendingRestoreName = "";
}

// ─── Restore progress overlay ─────────────────────────────────────────────────

function showProgressOverlay(agentName: string): void {
  text("progress-title", `Restoring "${agentName}"…`);
  el<HTMLUListElement>("progress-list").innerHTML = "";
  hide("progress-actions");
  show("overlay-progress");
}

function appendProgressItem(message: string, kind: "ok" | "error" | "skip" | "info"): void {
  const list = el<HTMLUListElement>("progress-list");
  const li = document.createElement("li");
  li.className = kind === "info" ? "" : kind;
  li.textContent = message;
  list.appendChild(li);
  li.scrollIntoView({ block: "nearest" });
}

function finaliseProgress(): void {
  show("progress-actions");
}

// ─── Restore trigger ──────────────────────────────────────────────────────────

async function handleRestoreRequest(key: string, agentName: string, port: number): Promise<void> {
  const restoreBtn = document.querySelector<HTMLButtonElement>(`[data-restore-key="${CSS.escape(key)}"]`);
  if (restoreBtn) restoreBtn.disabled = true;

  const report = await fetchPreflight(port, key);
  if (!report) {
    appendProgressItem("Preflight failed — proxy may be offline.", "error");
    finaliseProgress();
    show("overlay-progress");
    return;
  }

  showPreflightOverlay(key, agentName, report);
}

async function executeRestore(port: number): Promise<void> {
  hidePreflightOverlay();
  showProgressOverlay(pendingRestoreName);
  appendProgressItem("Sending restore request…", "info");

  const res = await postRestore(port, pendingRestoreKey);
  if (!res) {
    appendProgressItem("Proxy unreachable — restore could not be started.", "error");
    finaliseProgress();
    return;
  }

  if (!res.ok) {
    appendProgressItem(`Restore failed: HTTP ${res.status}.`, "error");
    finaliseProgress();
    return;
  }

  // Stream line-delimited JSON progress if the proxy supports it.
  // Fall back to a single success message if the body is not streaming.
  try {
    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as { artefact?: string; status?: string; message?: string };
            const label = event.artefact ?? event.message ?? trimmed;
            const kind  = event.status === "ok" ? "ok"
                        : event.status === "skipped" ? "skip"
                        : event.status === "error" ? "error"
                        : "info";
            appendProgressItem(label, kind);
          } catch {
            appendProgressItem(trimmed, "info");
          }
        }
      }
    } else {
      appendProgressItem("Restore request accepted.", "ok");
    }
  } catch {
    appendProgressItem("Restore request accepted (no progress stream).", "ok");
  }

  finaliseProgress();
}

// ─── Settings panel ───────────────────────────────────────────────────────────

function populateSettingsForm(settings: PopupSettings): void {
  el<HTMLInputElement>("setting-port").value     = String(settings.proxyPort);
  el<HTMLInputElement>("setting-debounce").value = String(settings.debounceMs / 1000);
  el<HTMLInputElement>("setting-prefix").value   = settings.bucketPrefix;
}

async function saveSettingsFromForm(): Promise<void> {
  const portVal     = Number(el<HTMLInputElement>("setting-port").value);
  const debounceVal = Number(el<HTMLInputElement>("setting-debounce").value);
  const prefix      = el<HTMLInputElement>("setting-prefix").value.trim();

  const merged = mergeSettings({ proxyPort: portVal, debounceMs: debounceVal * 1000, bucketPrefix: prefix });
  await writeSettings(merged);
  currentPort = merged.proxyPort;

  const savedMsg = el("settings-saved-msg");
  savedMsg.hidden = false;
  setTimeout(() => { savedMsg.hidden = true; }, 2000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // 1. Load settings.
  const settings = await readSettings();
  currentPort = settings.proxyPort;
  populateSettingsForm(settings);

  // 2. Load recent-snapshot index from local storage.
  const stored = await chrome.storage.local.get(RECENT_SNAPSHOTS_KEY);
  const recentLocal: RecentSnapshotEntry[] = Array.isArray(stored[RECENT_SNAPSHOTS_KEY])
    ? (stored[RECENT_SNAPSHOTS_KEY] as RecentSnapshotEntry[])
    : [];

  // 3. Render session card from local index (fast path — no network).
  renderSessionCard(recentLocal);

  // 4. Try proxy for the full history list.
  const latestLocal = recentLocal[0];
  let proxyOnline   = false;
  let rowsToRender: Array<ProxySnapshotRow | RecentSnapshotEntry> = recentLocal;

  if (latestLocal) {
    const proxyRows = await fetchProxySnapshots(
      settings.proxyPort,
      latestLocal.agentName,
      latestLocal.tenant,
    );
    if (proxyRows !== null) {
      proxyOnline  = true;
      rowsToRender = proxyRows;
    }
  } else {
    // No local history yet — still try a proxy ping to see if it's up.
    try {
      const ping = await fetch(`http://localhost:${settings.proxyPort}/snapshots`, {
        signal: AbortSignal.timeout(2000),
      });
      proxyOnline = ping.ok || ping.status < 500;
    } catch { /* offline */ }
  }

  if (!proxyOnline) show("banner-offline");

  // 5. Render snapshot history.
  renderSnapshotList(rowsToRender, proxyOnline, settings.proxyPort, (key, name) => {
    void handleRestoreRequest(key, name, currentPort);
  });

  // 6. Wire up event handlers.
  el("btn-settings").addEventListener("click", () => {
    const panel = el("section-settings");
    panel.hidden = !panel.hidden;
  });

  el("btn-save-settings").addEventListener("click", () => {
    void saveSettingsFromForm();
  });

  el("btn-cancel-restore").addEventListener("click", hidePreflightOverlay);

  el("btn-confirm-restore").addEventListener("click", () => {
    void executeRestore(currentPort);
  });

  el("btn-close-progress").addEventListener("click", () => {
    hide("overlay-progress");
  });
}

void init();
