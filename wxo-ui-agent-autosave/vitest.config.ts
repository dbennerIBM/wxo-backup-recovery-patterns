/**
 * Separate Vitest config that intentionally excludes the @samrum/vite-plugin-web-extension
 * plugin, which requires a real browser build context and crashes when Vitest tries to spin
 * up its dev server.
 *
 * Tests target only the pure-function modules in src/shared/ — no Chrome APIs, no DOM,
 * no browser extension scaffolding needed.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/shared/**/*.ts"],
      exclude: ["src/shared/**/__tests__/**"],
    },
  },
});
