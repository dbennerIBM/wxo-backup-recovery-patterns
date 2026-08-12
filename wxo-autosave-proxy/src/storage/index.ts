/**
 * Storage adapter factory.
 *
 * Returns the concrete StorageAdapter for the configured provider.
 * Currently ships: cos, s3, gcs (all via S3StorageAdapter with different endpoints).
 * gdrive and azure are reserved for future adapters.
 */

import type { StorageAdapter } from "./adapter.js";
import { S3StorageAdapter } from "./cos.js";
import type { ProxyConfig } from "../config.js";

export type { StorageAdapter } from "./adapter.js";
export type { StorageItem } from "./adapter.js";

export function createStorageAdapter(config: ProxyConfig): StorageAdapter {
  switch (config.provider) {
    case "cos":
    case "s3":
    case "gcs":
      return new S3StorageAdapter(config);
    default: {
      // TypeScript exhaustiveness guard
      const _exhaustive: never = config.provider;
      throw new Error(`Unsupported storage provider: ${String(_exhaustive)}`);
    }
  }
}
