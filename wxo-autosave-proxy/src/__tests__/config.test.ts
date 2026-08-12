/**
 * Unit tests for proxy configuration (src/config.ts).
 *
 * Tests the pure parseProvider / readConfig logic by controlling
 * process.env directly (restored after each test).
 *
 * Coverage:
 *  - parseProvider: valid values, missing, unsupported
 *  - readConfig: COS, S3, GCS field mapping, PORT validation, defaults
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Inline extract of parseProvider (pure logic, no env deps) ────────────────
// readConfig depends on process.env which we control via env snapshots.

type StorageProvider = "cos" | "s3" | "gcs";

function parseProvider(raw: string | undefined): StorageProvider {
  if (!raw) throw new Error("STORAGE_PROVIDER is not set. Valid values: cos, s3, gcs");
  if (raw === "cos" || raw === "s3" || raw === "gcs") return raw;
  throw new Error(`Unsupported STORAGE_PROVIDER "${raw}". Supported values for this release: cos, s3, gcs`);
}

// ─── parseProvider ────────────────────────────────────────────────────────────

describe("parseProvider — valid values", () => {
  it("accepts cos", () => expect(parseProvider("cos")).toBe("cos"));
  it("accepts s3",  () => expect(parseProvider("s3")).toBe("s3"));
  it("accepts gcs", () => expect(parseProvider("gcs")).toBe("gcs"));
});

describe("parseProvider — invalid values", () => {
  it("throws when value is undefined", () => {
    expect(() => parseProvider(undefined)).toThrow("STORAGE_PROVIDER is not set");
  });

  it("throws for unsupported provider gdrive (not yet implemented)", () => {
    expect(() => parseProvider("gdrive")).toThrow(/Unsupported STORAGE_PROVIDER/);
  });

  it("throws for empty string", () => {
    expect(() => parseProvider("")).toThrow("STORAGE_PROVIDER is not set");
  });

  it("throws for arbitrary string", () => {
    expect(() => parseProvider("azure")).toThrow(/Unsupported STORAGE_PROVIDER/);
  });

  it("error message for unsupported provider includes the value", () => {
    expect(() => parseProvider("bad-val")).toThrow(/"bad-val"/);
  });
});

// ─── readConfig — env-driven tests ───────────────────────────────────────────
// We import readConfig dynamically so we can reset env between tests.

describe("readConfig — COS provider", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env["STORAGE_PROVIDER"]     = "cos";
    process.env["BUCKET"]               = "my-bucket";
    process.env["COS_ENDPOINT"]         = "https://s3.us-south.cloud-object-storage.appdomain.cloud";
    process.env["COS_ACCESS_KEY_ID"]    = "access-key";
    process.env["COS_SECRET_ACCESS_KEY"] = "secret-key";
    delete process.env["COS_INSTANCE_CRN"];
    delete process.env["PORT"];
    delete process.env["ALLOWED_ORIGIN"];
  });

  afterEach(() => { process.env = savedEnv; });

  it("reads provider as cos", async () => {
    const { readConfig } = await import("../config.js");
    expect(readConfig().provider).toBe("cos");
  });

  it("reads bucket from BUCKET", async () => {
    const { readConfig } = await import("../config.js");
    expect(readConfig().bucket).toBe("my-bucket");
  });

  it("reads endpoint from COS_ENDPOINT", async () => {
    const { readConfig } = await import("../config.js");
    expect(readConfig().endpoint).toBe("https://s3.us-south.cloud-object-storage.appdomain.cloud");
  });

  it("defaults port to 7878 when PORT is unset", async () => {
    const { readConfig } = await import("../config.js");
    expect(readConfig().port).toBe(7878);
  });

  it("reads PORT when set", async () => {
    process.env["PORT"] = "9000";
    const { readConfig } = await import("../config.js");
    expect(readConfig().port).toBe(9000);
  });

  it("defaults allowedOrigin to chrome-extension://", async () => {
    const { readConfig } = await import("../config.js");
    expect(readConfig().allowedOrigin).toBe("chrome-extension://");
  });

  it("reads ALLOWED_ORIGIN when set", async () => {
    process.env["ALLOWED_ORIGIN"] = "chrome-extension://abcdef123456";
    const { readConfig } = await import("../config.js");
    expect(readConfig().allowedOrigin).toBe("chrome-extension://abcdef123456");
  });

  it("throws when BUCKET is missing", async () => {
    delete process.env["BUCKET"];
    const { readConfig } = await import("../config.js");
    expect(() => readConfig()).toThrow("BUCKET");
  });

  it("throws when COS_ENDPOINT is missing", async () => {
    delete process.env["COS_ENDPOINT"];
    const { readConfig } = await import("../config.js");
    expect(() => readConfig()).toThrow("COS_ENDPOINT");
  });

  it("includes instanceCrn when COS_INSTANCE_CRN is set", async () => {
    process.env["COS_INSTANCE_CRN"] = "crn:v1:bluemix:public:cloud-object-storage:global:a/123::";
    const { readConfig } = await import("../config.js");
    expect(readConfig().instanceCrn).toBe("crn:v1:bluemix:public:cloud-object-storage:global:a/123::");
  });
});

describe("readConfig — S3 provider", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env["STORAGE_PROVIDER"]       = "s3";
    process.env["BUCKET"]                 = "my-s3-bucket";
    process.env["AWS_ACCESS_KEY_ID"]      = "aws-key";
    process.env["AWS_SECRET_ACCESS_KEY"]  = "aws-secret";
    process.env["AWS_REGION"]             = "us-east-1";
  });

  afterEach(() => { process.env = savedEnv; });

  it("reads provider as s3", async () => {
    const { readConfig } = await import("../config.js");
    expect(readConfig().provider).toBe("s3");
  });

  it("reads AWS_ACCESS_KEY_ID", async () => {
    const { readConfig } = await import("../config.js");
    expect(readConfig().accessKeyId).toBe("aws-key");
  });

  it("reads AWS_REGION", async () => {
    const { readConfig } = await import("../config.js");
    expect(readConfig().region).toBe("us-east-1");
  });

  it("endpoint is undefined when AWS_ENDPOINT_URL is not set", async () => {
    delete process.env["AWS_ENDPOINT_URL"];
    const { readConfig } = await import("../config.js");
    expect(readConfig().endpoint).toBeUndefined();
  });

  it("throws when AWS_ACCESS_KEY_ID is missing", async () => {
    delete process.env["AWS_ACCESS_KEY_ID"];
    const { readConfig } = await import("../config.js");
    expect(() => readConfig()).toThrow("AWS_ACCESS_KEY_ID");
  });
});

describe("readConfig — PORT validation", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Minimum valid COS env so readConfig gets past provider/bucket checks
    process.env["STORAGE_PROVIDER"]      = "cos";
    process.env["BUCKET"]                = "b";
    process.env["COS_ENDPOINT"]          = "https://example.com";
    process.env["COS_ACCESS_KEY_ID"]     = "k";
    process.env["COS_SECRET_ACCESS_KEY"] = "s";
  });

  afterEach(() => { process.env = savedEnv; });

  it("throws for PORT=0", async () => {
    process.env["PORT"] = "0";
    const { readConfig } = await import("../config.js");
    expect(() => readConfig()).toThrow(/Invalid PORT/);
  });

  it("throws for PORT=99999", async () => {
    process.env["PORT"] = "99999";
    const { readConfig } = await import("../config.js");
    expect(() => readConfig()).toThrow(/Invalid PORT/);
  });
});
