import { describe, it, expect } from "vitest";
import { parseMultipart } from "../multipart";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

/**
 * Build a minimal multipart/form-data body from an array of parts.
 * Each part is { name, filename?, contentType?, body (string or Uint8Array) }.
 */
function buildMultipart(
  boundary: string,
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    body: string | Uint8Array;
  }>,
): { bytes: Uint8Array; contentType: string } {
  const lines: Uint8Array[] = [];
  const crlf = enc.encode("\r\n");
  const dash = enc.encode("--");
  const boundaryBytes = enc.encode(boundary);

  for (const part of parts) {
    // --boundary\r\n
    lines.push(concat(dash, boundaryBytes, crlf));

    // Content-Disposition header
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      disposition += `; filename="${part.filename}"`;
    }
    lines.push(enc.encode(disposition + "\r\n"));

    // Optional Content-Type header
    if (part.contentType !== undefined) {
      lines.push(enc.encode(`Content-Type: ${part.contentType}\r\n`));
    }

    // Blank line
    lines.push(crlf);

    // Body
    const body =
      typeof part.body === "string" ? enc.encode(part.body) : part.body;
    lines.push(body);

    // CRLF after body
    lines.push(crlf);
  }

  // Closing delimiter
  lines.push(concat(dash, boundaryBytes, enc.encode("--\r\n")));

  const totalLen = lines.reduce((s, l) => s + l.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of lines) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    bytes: result,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const a of arrays) {
    out.set(a, i);
    i += a.length;
  }
  return out;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("parseMultipart", () => {
  it("parses a single text field without filename", () => {
    const { bytes, contentType } = buildMultipart("boundary123", [
      { name: "description", body: "hello world" },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.fieldName).toBe("description");
    expect(parts[0]!.filename).toBe("");
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe("hello world");
  });

  it("parses a single file part", () => {
    const { bytes, contentType } = buildMultipart("----FormBoundary", [
      {
        name: "file",
        filename: "spec.yaml",
        contentType: "application/yaml",
        body: "openapi: 3.0.0",
      },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.filename).toBe("spec.yaml");
    expect(parts[0]!.contentType).toBe("application/yaml");
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe("openapi: 3.0.0");
  });

  it("parses multiple parts including both text and file", () => {
    const { bytes, contentType } = buildMultipart("ABCBOUNDARY", [
      { name: "description", body: "my kb document" },
      {
        name: "file",
        filename: "document.pdf",
        contentType: "application/pdf",
        body: enc.encode("%PDF-1.4 binary content"),
      },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(2);

    const textPart = parts.find((p) => p.fieldName === "description")!;
    expect(textPart).toBeDefined();
    expect(new TextDecoder().decode(textPart.bytes)).toBe("my kb document");

    const filePart = parts.find((p) => p.fieldName === "file")!;
    expect(filePart).toBeDefined();
    expect(filePart.filename).toBe("document.pdf");
    expect(filePart.contentType).toBe("application/pdf");
  });

  it("handles binary content correctly (preserves bytes)", () => {
    const binaryData = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]);
    const { bytes, contentType } = buildMultipart("binboundary", [
      {
        name: "upload",
        filename: "data.bin",
        contentType: "application/octet-stream",
        body: binaryData,
      },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.bytes).toEqual(binaryData);
  });

  it("returns empty array when no boundary is present in contentType", () => {
    const body = enc.encode("--bound\r\nContent-Disposition: form-data; name=\"f\"\r\n\r\nhello\r\n--bound--\r\n");
    const parts = parseMultipart(body, "multipart/form-data");
    expect(parts).toHaveLength(0);
  });

  it("returns empty array for empty body", () => {
    const parts = parseMultipart(new Uint8Array(0), "multipart/form-data; boundary=b");
    expect(parts).toHaveLength(0);
  });

  it("extracts boundary from quoted boundary parameter", () => {
    const { bytes } = buildMultipart("myboundary", [
      { name: "field", body: "value" },
    ]);
    // Quoted boundary
    const parts = parseMultipart(bytes, 'multipart/form-data; boundary="myboundary"');
    expect(parts).toHaveLength(1);
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe("value");
  });

  it("handles Chrome-style WebKit form boundary", () => {
    const boundary = "----WebKitFormBoundaryABCDEF123456";
    const { bytes, contentType } = buildMultipart(boundary, [
      {
        name: "file",
        filename: "openapi.yaml",
        contentType: "text/yaml",
        body: "paths: {}",
      },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.filename).toBe("openapi.yaml");
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe("paths: {}");
  });

  it("handles a body with no content-type on a part (assumes text)", () => {
    const { bytes, contentType } = buildMultipart("simple", [
      { name: "text", body: "plain text with no content-type" },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.contentType).toBe("");
  });
});
