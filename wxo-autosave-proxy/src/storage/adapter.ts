/**
 * StorageAdapter interface — all backend-specific logic is isolated behind this.
 *
 * FR-4.3: The interface MUST define:
 *   upload(path, bytes) → id
 *   download(id) → bytes
 *   list(prefix) → { id, path, timestamp, size }[]
 *   delete(id)
 *
 * All proxy business logic depends only on this interface, never on a concrete adapter.
 */

export interface StorageItem {
  /** Adapter-specific identifier (e.g. S3 object key, Drive file ID). */
  id: string;
  /** Logical path within the store, e.g. "tenant/agent-name/2026-08-15T12:00:00.000Z.zip" */
  path: string;
  /** ISO 8601 timestamp (last modified or creation time). */
  timestamp: string;
  /** Size in bytes. */
  size: number;
}

export interface StorageAdapter {
  /**
   * Upload bytes to the given logical path.
   * Returns the adapter-specific identifier for the stored object.
   */
  upload(path: string, bytes: Uint8Array): Promise<string>;

  /**
   * Download the object identified by `id`.
   * Returns raw bytes.
   */
  download(id: string): Promise<Uint8Array>;

  /**
   * List all objects whose logical path starts with `prefix`.
   */
  list(prefix: string): Promise<StorageItem[]>;

  /**
   * Delete the object identified by `id`.
   */
  delete(id: string): Promise<void>;
}
