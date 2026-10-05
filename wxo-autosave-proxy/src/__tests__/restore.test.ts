/**
 * Tests for restore.ts helpers.
 */

import { describe, it, expect } from "vitest";
import { extractAdkErrorDetail } from "../restore.js";

describe("extractAdkErrorDetail", () => {
  it("prefers stderr when non-empty", () => {
    expect(extractAdkErrorDetail({ stderr: "boom\n", stdout: "noise", message: "cmd failed" })).toBe("boom");
  });

  it("falls back to stdout when stderr is empty (CLIs that log errors to stdout)", () => {
    expect(extractAdkErrorDetail({ stderr: "", stdout: "[ERROR] no active env\n", message: "exit 1" }))
      .toBe("[ERROR] no active env");
  });

  it("falls back to message on spawn failures where stderr is an empty string", () => {
    expect(extractAdkErrorDetail({ stderr: "", stdout: "", message: "spawn orchestrate ENOENT" }))
      .toBe("spawn orchestrate ENOENT");
  });

  it("never returns an empty string", () => {
    const detail = extractAdkErrorDetail({ stderr: "", stdout: "", message: "" });
    expect(detail.length).toBeGreaterThan(0);
  });

  it("trims long output to the tail where the error line lives", () => {
    const detail = extractAdkErrorDetail({ stderr: `${"x".repeat(2000)}\nfinal error line` });
    expect(detail.length).toBeLessThanOrEqual(601);
    expect(detail.endsWith("final error line")).toBe(true);
    expect(detail.startsWith("…")).toBe(true);
  });
});
