/**
 * Configuration — reads environment variables and validates startup prerequisites.
 *
 * Supported storage providers (STORAGE_PROVIDER):
 *   cos    — IBM Cloud Object Storage (S3-compatible)
 *   s3     — AWS S3
 *   gcs    — Google Cloud Storage (via S3-compatible interoperability API)
 *
 * Google Drive (gdrive) and Azure (azure) are reserved for future adapters.
 */

import { execSync } from "node:child_process";

// ─── Types ────────────────────────────────────────────────────────────────────

export type StorageProvider = "cos" | "s3" | "gcs";

export interface ProxyConfig {
  port: number;
  provider: StorageProvider;
  allowedOrigin: string;

  // S3-compatible fields (all providers)
  bucket: string;
  region: string;
  endpoint?: string;       // required for COS and GCS; omitted for plain AWS S3
  accessKeyId: string;
  secretAccessKey: string;

  // IBM COS specific
  instanceCrn?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] ?? undefined;
}

function parseProvider(raw: string | undefined): StorageProvider {
  if (!raw) {
    throw new Error(
      "STORAGE_PROVIDER is not set. Valid values: cos, s3, gcs",
    );
  }
  if (raw === "cos" || raw === "s3" || raw === "gcs") return raw;
  throw new Error(
    `Unsupported STORAGE_PROVIDER "${raw}". Supported values for this release: cos, s3, gcs`,
  );
}

// ─── ADK CLI startup check ────────────────────────────────────────────────────

/**
 * Verify that the ADK CLI is on PATH and that an environment has been activated.
 * Throws with a clear message on failure — fail-fast at startup, not at restore time.
 */
export function validateAdkCli(): void {
  // 1. Check the binary exists.
  try {
    execSync("orchestrate --version", { stdio: "pipe" });
  } catch {
    throw new Error(
      [
        "ADK CLI not found on PATH.",
        "Install it with:  pip install ibm-watsonx-orchestrate",
        "Then activate an environment:  orchestrate env activate <env-name>",
      ].join("\n"),
    );
  }

  // 2. Check that an environment is activated (exit 0 = env is active).
  try {
    execSync("orchestrate env list", { stdio: "pipe" });
  } catch {
    throw new Error(
      [
        "No ADK environment is activated.",
        "Run:  orchestrate env activate <env-name>",
        "Then restart the proxy.",
      ].join("\n"),
    );
  }
}

// ─── readConfig ───────────────────────────────────────────────────────────────

/**
 * Read and validate all proxy configuration from environment variables.
 * Throws immediately with a clear error if any required value is missing.
 */
export function readConfig(): ProxyConfig {
  const provider = parseProvider(optionalEnv("STORAGE_PROVIDER"));
  const port = Number(optionalEnv("PORT") ?? "7878");

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: "${optionalEnv("PORT")}"`);
  }

  const allowedOrigin = optionalEnv("ALLOWED_ORIGIN") ?? "chrome-extension://";

  // Common S3-compatible fields
  const bucket = requireEnv("BUCKET");
  const region = optionalEnv("AWS_REGION") ?? optionalEnv("COS_REGION") ?? "us-south";

  let accessKeyId: string;
  let secretAccessKey: string;
  let endpoint: string | undefined;
  let instanceCrn: string | undefined;

  if (provider === "cos") {
    // IBM COS uses HMAC credentials: COS_ACCESS_KEY_ID / COS_SECRET_ACCESS_KEY
    accessKeyId     = requireEnv("COS_ACCESS_KEY_ID");
    secretAccessKey = requireEnv("COS_SECRET_ACCESS_KEY");
    endpoint        = requireEnv("COS_ENDPOINT");
    instanceCrn     = optionalEnv("COS_INSTANCE_CRN");
  } else if (provider === "s3") {
    // Standard AWS credentials
    accessKeyId     = requireEnv("AWS_ACCESS_KEY_ID");
    secretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY");
    endpoint        = optionalEnv("AWS_ENDPOINT_URL"); // optional custom endpoint
  } else {
    // GCS S3-interoperability: uses GCS HMAC keys
    accessKeyId     = requireEnv("GCS_ACCESS_KEY_ID");
    secretAccessKey = requireEnv("GCS_SECRET_ACCESS_KEY");
    endpoint        = optionalEnv("GCS_ENDPOINT") ?? "https://storage.googleapis.com";
  }

  const config: ProxyConfig = {
    port,
    provider,
    allowedOrigin,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
  };
  if (endpoint !== undefined) config.endpoint = endpoint;
  if (instanceCrn !== undefined) config.instanceCrn = instanceCrn;

  return config;
}
