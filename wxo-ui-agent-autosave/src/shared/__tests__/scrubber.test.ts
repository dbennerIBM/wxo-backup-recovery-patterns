import { describe, it, expect } from "vitest";
import { scrubSecrets, scrubConnectionPayload } from "../scrubber";

describe("scrubSecrets", () => {
  it("redacts known secret keys at the top level", () => {
    const input = {
      name: "my-tool",
      api_key: "sk-abc123",
      description: "a tool",
    };
    const result = scrubSecrets(input) as Record<string, unknown>;
    expect(result["api_key"]).toBe("[REDACTED]");
    expect(result["name"]).toBe("my-tool");
    expect(result["description"]).toBe("a tool");
  });

  it("redacts nested secret keys", () => {
    const input = {
      tool: {
        auth: {
          token: "Bearer xyz",
          client_secret: "s3cr3t",
          url: "https://example.com",
        },
      },
    };
    const result = scrubSecrets(input) as Record<string, unknown>;
    const auth = (result["tool"] as Record<string, unknown>)["auth"] as Record<
      string,
      unknown
    >;
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
    const input = {
      Authorization: "Bearer abc",
      authorization: "Bearer xyz",
    };
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
      level1: {
        level2: [{ level3: { credentials: "creds", safe: "ok" } }],
      },
    };
    const result = scrubSecrets(input) as Record<string, unknown>;
    const level3 = (
      (
        (result["level1"] as Record<string, unknown>)["level2"] as Record<
          string,
          unknown
        >[]
      )[0]! as Record<string, unknown>
    )["level3"] as Record<string, unknown>;
    expect(level3["credentials"]).toBe("[REDACTED]");
    expect(level3["safe"]).toBe("ok");
  });
});

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
});
