/**
 * Entry point — validate prerequisites, load config, start server.
 */

import { readConfig, validateAdkCli } from "./config.js";
import { createStorageAdapter } from "./storage/index.js";
import { createProxyServer } from "./server.js";

// ─── Startup ──────────────────────────────────────────────────────────────────

function main(): void {
  // 1. Validate ADK CLI is present and an environment is activated.
  //    Fail fast with a clear error rather than discovering the problem at
  //    restore time (FR-7.9).
  try {
    validateAdkCli();
  } catch (err) {
    console.error("\n[wxo-proxy] ✗ ADK CLI check failed:\n");
    console.error(String(err));
    console.error("\nFix the issue above and restart the proxy.\n");
    process.exit(1);
  }

  // 2. Read and validate configuration from environment variables.
  let config;
  try {
    config = readConfig();
  } catch (err) {
    console.error("\n[wxo-proxy] ✗ Configuration error:\n");
    console.error(String(err));
    console.error("\nSee README.md for the full environment variable reference.\n");
    process.exit(1);
  }

  // 3. Create the storage adapter.
  let adapter;
  try {
    adapter = createStorageAdapter(config);
  } catch (err) {
    console.error("\n[wxo-proxy] ✗ Storage adapter error:\n");
    console.error(String(err));
    process.exit(1);
  }

  // 4. Start the HTTP server.
  const server = createProxyServer(config, adapter);

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`\n[wxo-proxy] ✓ Listening on http://127.0.0.1:${config.port}`);
    console.log(`[wxo-proxy]   Storage provider : ${config.provider}`);
    console.log(`[wxo-proxy]   Bucket           : ${config.bucket}`);
    console.log(`[wxo-proxy]   Allowed origin   : ${config.allowedOrigin}`);
    console.log();
  });

  server.on("error", (err) => {
    console.error("[wxo-proxy] Server error:", err);
    process.exit(1);
  });
}

main();
