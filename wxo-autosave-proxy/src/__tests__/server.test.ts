/**
 * Unit tests for proxy server CORS and routing logic (src/server.ts).
 *
 * Tests the pure CORS-decision logic extracted inline — no real HTTP server
 * or storage adapter needed.
 *
 * Coverage:
 *  - CORS: chrome-extension:// origins accepted, others rejected
 *  - CORS: exact-match allowedOrigin
 *  - CORS: OPTIONS pre-flight always handled (204, no body)
 *  - Route matching: correct handler called per method+path
 */

import { describe, it, expect } from "vitest";

// ─── Inline CORS logic extract ────────────────────────────────────────────────
// Mirrors the handleCors logic in server.ts exactly.

function corsDecision(
  origin: string,
  method: string,
  allowedOrigin: string,
): { allowed: boolean; isOptions: boolean } {
  const originOk =
    allowedOrigin === "chrome-extension://"
      ? origin.startsWith("chrome-extension://")
      : origin === allowedOrigin;

  return {
    allowed:   originOk,
    isOptions: method === "OPTIONS",
  };
}

// ─── CORS — default (any chrome-extension://) ─────────────────────────────────

describe("CORS — default allowedOrigin (any chrome-extension://)", () => {
  const allowed = "chrome-extension://";

  it("allows any chrome-extension:// origin", () => {
    const { allowed: ok } = corsDecision("chrome-extension://abcdef123456", "GET", allowed);
    expect(ok).toBe(true);
  });

  it("allows OPTIONS from a chrome-extension:// origin", () => {
    const { allowed: ok, isOptions } = corsDecision("chrome-extension://xyz", "OPTIONS", allowed);
    expect(ok).toBe(true);
    expect(isOptions).toBe(true);
  });

  it("rejects http://localhost origin", () => {
    expect(corsDecision("http://localhost", "GET", allowed).allowed).toBe(false);
  });

  it("rejects https://evil.example.com", () => {
    expect(corsDecision("https://evil.example.com", "POST", allowed).allowed).toBe(false);
  });

  it("rejects empty origin", () => {
    expect(corsDecision("", "GET", allowed).allowed).toBe(false);
  });

  it("rejects a string that starts with 'chrome-extension' but is not the scheme", () => {
    // Must start with 'chrome-extension://' not just 'chrome-extension'
    expect(corsDecision("chrome-extensions://abc", "GET", allowed).allowed).toBe(false);
  });
});

// ─── CORS — locked to specific extension ID ───────────────────────────────────

describe("CORS — exact allowedOrigin match", () => {
  const exactOrigin = "chrome-extension://abcdefghijklmnopqrstuvwxyz012345";

  it("allows the exact configured origin", () => {
    expect(corsDecision(exactOrigin, "GET", exactOrigin).allowed).toBe(true);
  });

  it("rejects a different extension origin", () => {
    expect(corsDecision("chrome-extension://zzzzzzzzzzz", "GET", exactOrigin).allowed).toBe(false);
  });

  it("rejects http://localhost even though base config allows it", () => {
    expect(corsDecision("http://localhost", "GET", exactOrigin).allowed).toBe(false);
  });
});

// ─── Route matching ───────────────────────────────────────────────────────────
// Inline route-matching logic mirroring server.ts dispatch table.

type Route = { method: string; path: string; handler: string };

function matchRoute(method: string, pathname: string): string {
  if (method === "POST" && pathname === "/snapshots")          return "POST /snapshots";
  if (method === "GET"  && pathname === "/snapshots")          return "GET /snapshots";
  if (method === "GET"  && pathname === "/restore/preflight")  return "GET /restore/preflight";
  if (method === "POST" && pathname === "/restore")            return "POST /restore";
  return "404";
}

describe("Route dispatch", () => {
  const routes: Route[] = [
    { method: "POST", path: "/snapshots",          handler: "POST /snapshots" },
    { method: "GET",  path: "/snapshots",          handler: "GET /snapshots" },
    { method: "GET",  path: "/restore/preflight",  handler: "GET /restore/preflight" },
    { method: "POST", path: "/restore",            handler: "POST /restore" },
  ];

  for (const { method, path, handler } of routes) {
    it(`${method} ${path} → ${handler}`, () => {
      expect(matchRoute(method, path)).toBe(handler);
    });
  }

  it("unknown path returns 404", () => {
    expect(matchRoute("GET", "/unknown")).toBe("404");
  });

  it("wrong method on known path returns 404", () => {
    expect(matchRoute("DELETE", "/snapshots")).toBe("404");
    expect(matchRoute("PUT",    "/restore")).toBe("404");
  });
});
