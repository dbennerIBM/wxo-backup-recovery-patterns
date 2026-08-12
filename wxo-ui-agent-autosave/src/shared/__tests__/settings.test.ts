/**
 * Unit tests for popup settings helpers.
 *
 * Tests the pure mergeSettings() logic — no chrome.* globals needed.
 */

import { describe, it, expect } from "vitest";
import { mergeSettings, DEFAULT_SETTINGS, type PopupSettings } from "../settings";

describe("mergeSettings — defaults", () => {
  it("returns full defaults for undefined input", () => {
    const result = mergeSettings(undefined);
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it("returns full defaults for null input", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns full defaults for a non-object input", () => {
    expect(mergeSettings("bad")).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns full defaults for an empty object", () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });
});

describe("mergeSettings — valid stored values override defaults", () => {
  it("overrides proxyPort when valid", () => {
    const result = mergeSettings({ proxyPort: 9000 });
    expect(result.proxyPort).toBe(9000);
  });

  it("overrides debounceMs when valid", () => {
    const result = mergeSettings({ debounceMs: 5000 });
    expect(result.debounceMs).toBe(5000);
  });

  it("overrides bucketPrefix when a string", () => {
    const result = mergeSettings({ bucketPrefix: "my-org/prod" });
    expect(result.bucketPrefix).toBe("my-org/prod");
  });

  it("accepts debounceMs of 0 (disable debounce)", () => {
    const result = mergeSettings({ debounceMs: 0 });
    expect(result.debounceMs).toBe(0);
  });

  it("accepts empty string bucketPrefix", () => {
    const result = mergeSettings({ bucketPrefix: "" });
    expect(result.bucketPrefix).toBe("");
  });

  it("merges all three fields simultaneously", () => {
    const stored: PopupSettings = { proxyPort: 8080, debounceMs: 1000, bucketPrefix: "team" };
    expect(mergeSettings(stored)).toEqual(stored);
  });
});

describe("mergeSettings — invalid stored values fall back to defaults", () => {
  it("rejects non-positive proxyPort", () => {
    expect(mergeSettings({ proxyPort: 0 }).proxyPort).toBe(DEFAULT_SETTINGS.proxyPort);
    expect(mergeSettings({ proxyPort: -1 }).proxyPort).toBe(DEFAULT_SETTINGS.proxyPort);
  });

  it("rejects negative debounceMs", () => {
    expect(mergeSettings({ debounceMs: -1 }).debounceMs).toBe(DEFAULT_SETTINGS.debounceMs);
  });

  it("rejects non-number proxyPort", () => {
    expect(mergeSettings({ proxyPort: "9000" }).proxyPort).toBe(DEFAULT_SETTINGS.proxyPort);
  });

  it("rejects non-string bucketPrefix", () => {
    expect(mergeSettings({ bucketPrefix: 123 }).bucketPrefix).toBe(DEFAULT_SETTINGS.bucketPrefix);
  });

  it("keeps valid fields when some are invalid", () => {
    const result = mergeSettings({ proxyPort: -5, debounceMs: 2000, bucketPrefix: "ok" });
    expect(result.proxyPort).toBe(DEFAULT_SETTINGS.proxyPort);
    expect(result.debounceMs).toBe(2000);
    expect(result.bucketPrefix).toBe("ok");
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("proxyPort is 7878", () => expect(DEFAULT_SETTINGS.proxyPort).toBe(7878));
  it("debounceMs is 3000", () => expect(DEFAULT_SETTINGS.debounceMs).toBe(3000));
  it("bucketPrefix is empty string", () => expect(DEFAULT_SETTINGS.bucketPrefix).toBe(""));
});
