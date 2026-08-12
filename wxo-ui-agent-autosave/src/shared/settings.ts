/**
 * User-configurable popup settings — stored in chrome.storage.sync.
 *
 * Exported from shared/ so both the popup and the assembler can read settings
 * without duplicating key names.
 */

import { PROXY_DEFAULT_PORT, DEBOUNCE_DEFAULT_MS } from "./index";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PopupSettings {
  /** Local proxy port. Default: 7878 */
  proxyPort: number;
  /** Debounce delay in milliseconds. Default: 3000 */
  debounceMs: number;
  /** Optional bucket path prefix for snapshot keys. Default: "" */
  bucketPrefix: string;
}

export const SETTINGS_STORAGE_KEY = "popupSettings";

export const DEFAULT_SETTINGS: Readonly<PopupSettings> = {
  proxyPort: PROXY_DEFAULT_PORT,
  debounceMs: DEBOUNCE_DEFAULT_MS,
  bucketPrefix: "",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Merge a partial stored value with defaults.
 * Safe against corrupt/missing/partial storage entries.
 */
export function mergeSettings(stored: unknown): PopupSettings {
  const base: PopupSettings = { ...DEFAULT_SETTINGS };
  if (typeof stored !== "object" || stored === null) return base;
  const obj = stored as Record<string, unknown>;

  if (typeof obj["proxyPort"] === "number" && obj["proxyPort"] > 0) {
    base.proxyPort = obj["proxyPort"];
  }
  if (typeof obj["debounceMs"] === "number" && obj["debounceMs"] >= 0) {
    base.debounceMs = obj["debounceMs"];
  }
  if (typeof obj["bucketPrefix"] === "string") {
    base.bucketPrefix = obj["bucketPrefix"];
  }
  return base;
}

/**
 * Read settings from chrome.storage.sync, falling back to defaults if absent
 * or corrupt.
 *
 * NOTE: this function uses the chrome global — only call it from popup or
 * background contexts, not from unit tests (use mergeSettings directly).
 */
export async function readSettings(): Promise<PopupSettings> {
  const stored = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
  return mergeSettings(stored[SETTINGS_STORAGE_KEY]);
}

/**
 * Persist a full settings object to chrome.storage.sync.
 */
export async function writeSettings(settings: PopupSettings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_STORAGE_KEY]: settings });
}
