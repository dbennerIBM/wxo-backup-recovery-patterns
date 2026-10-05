/**
 * S3-compatible storage adapter — covers IBM COS, AWS S3, and GCS (via
 * S3 interoperability API).
 *
 * Uses @aws-sdk/client-s3 with a configurable endpoint so the same code
 * drives all three backends.
 *
 * FR-4.2, FR-4.5
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import type { StorageAdapter, StorageItem } from "./adapter.js";
import type { ProxyConfig } from "../config.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function streamToUint8Array(
  stream: NodeJS.ReadableStream,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function toStorageItem(obj: _Object, bucket: string): StorageItem | null {
  const key  = obj.Key;
  const size = obj.Size;
  const lastModified = obj.LastModified;
  if (!key || size === undefined || !lastModified) return null;
  // Bucket prefix is stripped — the logical path is the key itself.
  void bucket; // bucket is part of client config, not the item path
  return {
    id:        key,
    path:      key,
    timestamp: lastModified.toISOString(),
    size,
  };
}

// ─── S3StorageAdapter ─────────────────────────────────────────────────────────

export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ProxyConfig) {
    this.bucket = config.bucket;

    const clientConfig: ConstructorParameters<typeof S3Client>[0] = {
      region: config.region,
      credentials: {
        accessKeyId:     config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    };

    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
      // IBM COS and GCS require path-style addressing; AWS S3 uses virtual-hosted.
      clientConfig.forcePathStyle = config.provider !== "s3";
    }

    // IBM COS with HMAC credentials does NOT need the ibm-service-instance-id
    // header -- that header is only required for IAM bearer-token auth and it
    // breaks the S3 HMAC signature when injected as unsigned middleware.

    this.client = new S3Client(clientConfig);
  }

  async upload(path: string, bytes: Uint8Array): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket:      this.bucket,
        Key:         path,
        Body:        bytes,
        ContentType: "application/zip",
      }),
    );
    return path; // object key is the stable ID for S3-compatible stores
  }

  async download(id: string): Promise<Uint8Array> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: id }),
    );
    if (!res.Body) throw new Error(`Empty response body for key: ${id}`);
    // Body is a readable stream in Node.js
    return streamToUint8Array(
      res.Body as unknown as NodeJS.ReadableStream,
    );
  }

  async list(prefix: string): Promise<StorageItem[]> {
    const items: StorageItem[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket:            this.bucket,
          Prefix:            prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of res.Contents ?? []) {
        const item = toStorageItem(obj, this.bucket);
        if (item) items.push(item);
      }

      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return items;
  }

  async delete(id: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: id }),
    );
  }
}
