import { describe, it, expect } from "vitest";
import { scrubSecrets, scrubConnectionPayload } from "../scrubber";

// ─── scrubSecrets ─────────────────────────────────────────────────────────────

describe("scrubSecrets", () => {
  // ── Basic key matching ──────────────────────────────────────────────────────

  it("redacts known secret keys at the top level", () => {
    const input = { name: "my-tool", api_key: "sk-abc123", description: "a tool" };
    const result = scrubSecrets(input) as Record<string, unknown>;
    expect(result["api_key"]).toBe("[REDACTED]");
    expect(result["name"]).toBe("my-tool");
    expect(result["description"]).toBe("a tool");
  });

  it("redacts nested secret keys", () => {
    const input = {
      tool: { auth: { token: "Bearer xyz", client_secret: "s3cr3t", url: "https://example.com" } },
    };
    const result = scrubSecrets(input) as Record<string, unknown>;
    const auth = (result["tool"] as Record<string, unknown>)["auth"] as Record<string, unknown>;
    expect(auth["token"]).toBe("[REDACTED]");
    expect(auth["client_secret"]).toBe("[REDACTED]");
    expect(auth["url"]).toBe("https://example.com");
  });

  it("redacts keys inside arrays of objects", () => {
    const input = {
      connections: [
        { app_id: "conn-1", password: "hunter2" },
        { app_id: "conn-2", password: "p@ssword" },
      ],
    };
    const result = scrubSecrets(input) as Record<string, unknown>;
    const conns = result["connections"] as Record<string, unknown>[];
    expect(conns[0]!["password"]).toBe("[REDACTED]");
    expect(conns[0]!["app_id"]).toBe("conn-1");
    expect(conns[1]!["password"]).toBe("[REDACTED]");
    expect(conns[1]!["app_id"]).toBe("conn-2");
  });

  it("redacts Authorization (case variants)", () => {
    const input = { Authorization: "Bearer abc", authorization: "Bearer xyz" };
    const result = scrubSecrets(input) as Record<string, unknown>;
    expect(result["Authorization"]).toBe("[REDACTED]");
    expect(result["authorization"]).toBe("[REDACTED]");
  });

  it("redacts auth_config at any nesting level", () => {
    const input = { agent: { auth_config: { type: "BEARER", token: "tok" } } };
    const result = scrubSecrets(input) as Record<string, unknown>;
    const agent = result["agent"] as Record<string, unknown>;
    expect(agent["auth_config"]).toBe("[REDACTED]");
  });

  it("leaves primitive values unchanged", () => {
    expect(scrubSecrets(42)).toBe(42);
    expect(scrubSecrets("hello")).toBe("hello");
    expect(scrubSecrets(null)).toBeNull();
    expect(scrubSecrets(true)).toBe(true);
  });

  it("does not mutate the original input", () => {
    const input = { api_key: "secret", name: "keep-me" };
    const before = JSON.stringify(input);
    scrubSecrets(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("handles deeply nested arrays and objects without throwing", () => {
    const input = {
      level1: { level2: [{ level3: { credentials: "creds", safe: "ok" } }] },
    };
    const result = scrubSecrets(input) as Record<string, unknown>;
    const level3 = (
      (
        (result["level1"] as Record<string, unknown>)["level2"] as Record<string, unknown>[]
      )[0]! as Record<string, unknown>
    )["level3"] as Record<string, unknown>;
    expect(level3["credentials"]).toBe("[REDACTED]");
    expect(level3["safe"]).toBe("ok");
  });

  // ── Normalisation: underscores, hyphens, mixed-case ──────────────────────

  it("redacts hyphenated key variants (api-key, client-secret, access-token)", () => {
    const input = {
      "api-key": "val1",
      "client-secret": "val2",
      "access-token": "val3",
      "refresh-token": "val4",
      "private-key": "val5",
    };
    const result = scrubSecrets(input) as Record<string, unknown>;
    expect(result["api-key"]).toBe("[REDACTED]");
    expect(result["client-secret"]).toBe("[REDACTED]");
    expect(result["access-token"]).toBe("[REDACTED]");
    expect(result["refresh-token"]).toBe("[REDACTED]");
    expect(result["private-key"]).toBe("[REDACTED]");
  });

  it("redacts UPPER_CASE and Mixed_Case key variants", () => {
    const input = {
      API_KEY: "val",
      Token: "tok",
      Password: "pw",
      CLIENT_SECRET: "cs",
      ACCESS_TOKEN: "at",
    };
    const result = scrubSecrets(input) as Record<string, unknown>;
    expect(result["API_KEY"]).toBe("[REDACTED]");
    expect(result["Token"]).toBe("[REDACTED]");
    expect(result["Password"]).toBe("[REDACTED]");
    expect(result["CLIENT_SECRET"]).toBe("[REDACTED]");
    expect(result["ACCESS_TOKEN"]).toBe("[REDACTED]");
  });

  it("covers all 14 normalised secret key patterns", () => {
    // These are the real-world forms that appear in wxO API responses and tool payloads.
    const sensitiveKeys: [string, string][] = [
      ["api_key", "v"],
      ["apikey", "v"],
      ["api-key", "v"],
      ["token", "v"],
      ["password", "v"],
      ["passwd", "v"],
      ["client_secret", "v"],
      ["clientsecret", "v"],
      ["client-secret", "v"],
      ["auth_config", "v"],
      ["auth-config", "v"],
      ["authorization", "v"],
      ["secret", "v"],
      ["access_token", "v"],
      ["refresh_token", "v"],
      ["id_token", "v"],
      ["private_key", "v"],
      ["credential", "v"],
      ["credentials", "v"],
    ];
    const input = Object.fromEntries(sensitiveKeys);
    const result = scrubSecrets(input) as Record<string, unknown>;
    for (const [key] of sensitiveKeys) {
      expect(result[key], `expected '${key}' to be [REDACTED]`).toBe("[REDACTED]");
    }
  });

  it("does NOT redact safe keys that merely contain a secret word as a substring", () => {
    // 'token_count', 'access_level', 'password_policy' are not secret values.
    const input = {
      token_count: 5,
      access_level: "admin",
      password_policy: "strong",
      description: "mentions token in text",
    };
    const result = scrubSecrets(input) as Record<string, unknown>;
    // 'token_count' normalises to 'tokencount' — not in the set → should NOT be redacted
    expect(result["token_count"]).toBe(5);
    expect(result["access_level"]).toBe("admin");
    expect(result["password_policy"]).toBe("strong");
    expect(result["description"]).toBe("mentions token in text");
  });

  it("handles an array of primitives (no crash, values pass through)", () => {
    const result = scrubSecrets(["a", 1, null, true]);
    expect(result).toEqual(["a", 1, null, true]);
  });

  it("handles an empty object", () => {
    expect(scrubSecrets({})).toEqual({});
  });

  it("handles an empty array", () => {
    expect(scrubSecrets([])).toEqual([]);
  });
});

// ─── scrubConnectionPayload ───────────────────────────────────────────────────

describe("scrubConnectionPayload", () => {
  it("keeps app_id, kind, and server_url only", () => {
    const input = {
      app_id: "my-salesforce",
      kind: "API_KEY_AUTH",
      server_url: "https://sf.example.com",
      api_key: "secret",
      client_secret: "also-secret",
      irrelevant_field: "dropped",
    };
    const result = scrubConnectionPayload(input);
    expect(result).toEqual({
      app_id: "my-salesforce",
      kind: "API_KEY_AUTH",
      server_url: "https://sf.example.com",
    });
  });

  it("falls back to name when app_id is absent", () => {
    const input = { name: "my-conn", kind: "BEARER_TOKEN" };
    const result = scrubConnectionPayload(input);
    expect(result.app_id).toBe("my-conn");
  });

  it("falls back to id when both app_id and name are absent", () => {
    const input = { id: "conn-uuid-123", kind: "BASIC_AUTH" };
    const result = scrubConnectionPayload(input);
    expect(result.app_id).toBe("conn-uuid-123");
  });

  it("omits server_url when not present in input", () => {
    const input = { app_id: "c1", kind: "NONE" };
    const result = scrubConnectionPayload(input);
    expect("server_url" in result).toBe(false);
  });

  it("reads auth_scheme as kind fallback", () => {
    const input = { app_id: "c1", auth_scheme: "OAUTH2", server_url: "https://x.com" };
    const result = scrubConnectionPayload(input);
    expect(result.kind).toBe("OAUTH2");
  });

  it("returns empty strings for app_id and kind when all fallbacks are absent", () => {
    const result = scrubConnectionPayload({});
    expect(result.app_id).toBe("");
    expect(result.kind).toBe("");
    expect("server_url" in result).toBe(false);
  });

  it("does not include any field beyond app_id, kind, server_url", () => {
    const input = {
      app_id: "c1",
      kind: "API_KEY_AUTH",
      server_url: "https://x.com",
      extra: "should-be-gone",
      token: "secret",
      nested: { credential: "deep-secret" },
    };
    const result = scrubConnectionPayload(input);
    const keys = Object.keys(result);
    expect(keys.sort()).toEqual(["app_id", "kind", "server_url"]);
  });
});
