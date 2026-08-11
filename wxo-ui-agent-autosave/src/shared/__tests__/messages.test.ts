/**
 * Unit tests for the isExtensionMessage type guard and the ExtensionMessage
 * discriminated union defined in src/shared/messages.ts.
 */
import { describe, it, expect } from "vitest";
import { isExtensionMessage } from "../messages";
import type { ExtensionMessage } from "../messages";

// ─── isExtensionMessage type guard ────────────────────────────────────────────

describe("isExtensionMessage — valid messages", () => {
  const validMessages: ExtensionMessage[] = [
    {
      type: "AGENT_CAPTURED",
      payload: { data: { name: "my-agent" }, sourceUrl: "https://example.com/agents/1" },
    },
    {
      type: "TOOL_CAPTURED",
      payload: { data: { name: "my-tool", kind: "python" }, sourceUrl: "https://example.com/tools/1" },
    },
    {
      type: "CONNECTION_CAPTURED",
      payload: { app_id: "my-conn", kind: "API_KEY_AUTH" },
    },
    {
      type: "CONNECTION_CAPTURED",
      payload: { app_id: "my-conn", kind: "BEARER_TOKEN", server_url: "https://sf.example.com" },
    },
    {
      type: "KB_META_CAPTURED",
      payload: { data: { name: "my-kb" }, sourceUrl: "https://example.com/kbs/1" },
    },
    {
      type: "KB_FILE_CAPTURED",
      payload: { kbId: "kb-1", filename: "doc.pdf", contentType: "application/pdf", bytes: [37, 80, 68, 70] },
    },
    {
      type: "TOOL_FILE_CAPTURED",
      payload: { filename: "tool.py", contentType: "text/x-python", bytes: [35, 116, 111, 111, 108] },
    },
    {
      type: "BEARER_TOKEN_OBSERVED",
      payload: { token: "eyJhbGciOiJSUzI1NiJ9.abc.def" },
    },
  ];

  for (const msg of validMessages) {
    it(`returns true for a valid ${msg.type} message`, () => {
      expect(isExtensionMessage(msg)).toBe(true);
    });
  }
});

describe("isExtensionMessage — invalid inputs", () => {
  it("returns false for null", () => {
    expect(isExtensionMessage(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isExtensionMessage(undefined)).toBe(false);
  });

  it("returns false for a primitive string", () => {
    expect(isExtensionMessage("AGENT_CAPTURED")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isExtensionMessage(42)).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isExtensionMessage({})).toBe(false);
  });

  it("returns false when type is missing", () => {
    expect(isExtensionMessage({ payload: { data: {} } })).toBe(false);
  });

  it("returns false when type is not a string", () => {
    expect(isExtensionMessage({ type: 123, payload: {} })).toBe(false);
  });

  it("returns false for an unknown type string", () => {
    expect(isExtensionMessage({ type: "UNKNOWN_EVENT", payload: {} })).toBe(false);
    expect(isExtensionMessage({ type: "agent_captured", payload: {} })).toBe(false); // lowercase
    expect(isExtensionMessage({ type: "SNAPSHOT_READY", payload: {} })).toBe(false); // not in union
  });

  it("returns false for an array", () => {
    expect(isExtensionMessage([])).toBe(false);
    expect(isExtensionMessage([{ type: "AGENT_CAPTURED", payload: {} }])).toBe(false);
  });

  it("returns true for a valid type even when payload is missing or malformed", () => {
    // The guard only checks the type discriminant, not the payload shape.
    // This is intentional — payload validation is the assembler's job.
    expect(isExtensionMessage({ type: "AGENT_CAPTURED" })).toBe(true);
    expect(isExtensionMessage({ type: "TOOL_CAPTURED", payload: null })).toBe(true);
  });
});

// ─── Exhaustive type coverage ─────────────────────────────────────────────────

describe("isExtensionMessage — covers all 7 defined message types", () => {
  const allTypes = [
    "AGENT_CAPTURED",
    "TOOL_CAPTURED",
    "CONNECTION_CAPTURED",
    "KB_META_CAPTURED",
    "KB_FILE_CAPTURED",
    "TOOL_FILE_CAPTURED",
    "BEARER_TOKEN_OBSERVED",
  ] as const;

  for (const type of allTypes) {
    it(`accepts type "${type}"`, () => {
      expect(isExtensionMessage({ type, payload: {} })).toBe(true);
    });
  }

  it("rejects any type not in the 7-item list", () => {
    const nonTypes = [
      "SNAPSHOT_READY",  // exists in shared/index.ts but not in the messages union
      "AGENT_UPDATED",
      "KB_DELETED",
      "",
    ];
    for (const t of nonTypes) {
      expect(isExtensionMessage({ type: t, payload: {} }), `"${t}" should be rejected`).toBe(false);
    }
  });
});
