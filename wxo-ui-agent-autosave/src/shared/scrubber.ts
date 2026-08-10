/**
 * Credential scrubber — pure functions with no browser dependencies.
 *
 * Used by the background service worker before any captured payload is stored
 * or forwarded. Must never be bypassed.
 */

/**
 * Set of top-level and nested keys that must always be redacted.
 * Matching is case-insensitive so that "Api_Key", "API_KEY", and "api_key" are all caught.
 */
const SECRET_KEYS = new Set([
  "api_key",
  "apikey",
  "token",
  "password",
  "passwd",
  "client_secret",
  "clientsecret",
  "auth_config",
  "authorization",
  "secret",
  "access_token",
  "refresh_token",
  "id_token",
  "private_key",
  "credential",
  "credentials",
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/**
 * Deep-scrub a plain JSON object. Any key matching the secrets pattern is
 * replaced with the string "[REDACTED]". Arrays are traversed; primitives are
 * returned unchanged.
 *
 * This function is deliberately conservative: if in doubt, redact.
 */
export function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubSecrets);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = isSecretKey(k) ? "[REDACTED]" : scrubSecrets(v);
    }
    return result;
  }
  // Primitive (string, number, boolean, null, undefined) — pass through.
  return value;
}

/**
 * Allowlist-based scrubber for connection payloads.
 *
 * Connections are captured as metadata only: app_id (or name/id), kind
 * (the authentication scheme type), and server_url. Everything else is dropped.
 */
export interface ScrubbedConnection {
  app_id: string;
  kind: string;
  server_url?: string;
}

export function scrubConnectionPayload(
  raw: Record<string, unknown>,
): ScrubbedConnection {
  const app_id =
    String(raw["app_id"] ?? raw["name"] ?? raw["id"] ?? "");
  const kind = String(raw["kind"] ?? raw["type"] ?? raw["auth_scheme"] ?? "");
  const server_url =
    raw["server_url"] !== undefined ? String(raw["server_url"]) : undefined;

  const result: ScrubbedConnection = { app_id, kind };
  if (server_url !== undefined) {
    result.server_url = server_url;
  }
  return result;
}
