/**
 * Preflight report builder — pure logic, no I/O.
 *
 * Given a parsed zip, produces the structured pre-restore report that the
 * popup displays to the builder before they confirm a restore (FR-5.1, FR-5.2).
 */

import {
  listConnectionNames,
  listToolNames,
  readConnectionMeta,
  readToolMeta,
  type ZipConnectionMeta,
} from "./zip.js";
import type { ParsedZip } from "./zip.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreflightReport {
  /** Connections the builder will need to re-credential after restore. */
  connections_to_recredential: ZipConnectionMeta[];
  /** Tool names whose source files are unavailable (will be skipped). */
  tools_source_unavailable: string[];
  /** Planned restore order (informational). */
  restore_order: readonly string[];
}

const RESTORE_ORDER = ["connections", "tools", "knowledge_bases", "agent"] as const;

// ─── buildPreflightReport ─────────────────────────────────────────────────────

/**
 * Build the preflight report from an unpacked zip.
 * Pure function — no network, no disk, no ADK calls.
 */
export function buildPreflightReport(zip: ParsedZip): PreflightReport {
  const { entries } = zip;

  // Collect every connection (all will need re-credentialing after restore).
  const connections_to_recredential: ZipConnectionMeta[] = [];
  for (const name of listConnectionNames(entries)) {
    const meta = readConnectionMeta(entries, name);
    if (meta) connections_to_recredential.push(meta);
  }

  // Collect tools flagged sourceUnavailable.
  const tools_source_unavailable: string[] = [];
  for (const toolName of listToolNames(entries)) {
    const meta = readToolMeta(entries, toolName);
    if (meta?.sourceUnavailable === true) {
      tools_source_unavailable.push(meta.name ?? toolName);
    }
  }

  return {
    connections_to_recredential,
    tools_source_unavailable,
    restore_order: RESTORE_ORDER,
  };
}
