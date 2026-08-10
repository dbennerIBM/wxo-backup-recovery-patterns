/**
 * proxy-server — placeholder directory.
 *
 * The local proxy server will be implemented in Sub-Task 6.
 * It runs as a separate Node (or Python/Go) process alongside the browser.
 *
 * Endpoints planned:
 *   POST /snapshots         — receive zip, upload to IBM COS
 *   GET  /snapshots         — list stored snapshots for an agent
 *   GET  /restore/preflight — pre-restore report (credentials to re-enter, etc.)
 *   POST /restore           — execute restore via ADK CLI
 */

export {};
