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
/**
 * All entries are pre-normalized (lowercased, hyphens/underscores stripped) so
 * that isSecretKey's normalisation of the incoming key matches correctly.
 * e.g. "auth_config" → "authconfig", "client_secret" → "clientsecret".
 */
const SECRET_KEYS = new Set([
  "apikey",        // api_key, apikey, api-key
  "token",         // token
  "password",      // password
  "passwd",        // passwd
  "clientsecret",  // client_secret, clientsecret, client-secret
  "authconfig",    // auth_config, auth-config
  "authorization", // authorization
  "secret",        // secret
  "accesstoken",   // access_token, access-token
  "refreshtoken",  // refresh_token, refresh-token
  "idtoken",       // id_token, id-token
  "privatekey",    // private_key, private-key
  "credential",    // credential
  "credentials",   // credentials
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
  // CONFIRMED from HAR 3: the connections/applications/authtype endpoint uses
  // security_scheme as the stable kind identifier (e.g. "api_key_auth", "oauth2",
  // "bearer_token", "basic_auth", "key_value_creds"). auth_type is a sub-type
  // qualifier (e.g. "oauth2_auth_code") but is empty string for non-OAuth connections.
  // We prefer security_scheme as the kind value; fall back through known aliases.
  const kind = String(
    raw["security_scheme"] ??
    raw["kind"] ??
    raw["type"] ??
    raw["auth_scheme"] ??
    ""
  );
  const server_url =
    raw["server_url"] !== undefined && raw["server_url"] !== null
      ? String(raw["server_url"])
      : undefined;

  const result: ScrubbedConnection = { app_id, kind };
  if (server_url !== undefined) {
    result.server_url = server_url;
  }
  return result;
}
