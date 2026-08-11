import { describe, it, expect } from "vitest";
import { parseMultipart } from "../multipart";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

/**
 * Build a minimal multipart/form-data body from an array of parts.
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
    lines.push(concat(dash, boundaryBytes, crlf));
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      disposition += `; filename="${part.filename}"`;
    }
    lines.push(enc.encode(disposition + "\r\n"));
    if (part.contentType !== undefined) {
      lines.push(enc.encode(`Content-Type: ${part.contentType}\r\n`));
    }
    lines.push(crlf);
    const body = typeof part.body === "string" ? enc.encode(part.body) : part.body;
    lines.push(body);
    lines.push(crlf);
  }
  lines.push(concat(dash, boundaryBytes, enc.encode("--\r\n")));

  const totalLen = lines.reduce((s, l) => s + l.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of lines) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: result, contentType: `multipart/form-data; boundary=${boundary}` };
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const a of arrays) { out.set(a, i); i += a.length; }
  return out;
}

// ─── Basic parsing ────────────────────────────────────────────────────────────

describe("parseMultipart — basic parsing", () => {
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
      { name: "file", filename: "spec.yaml", contentType: "application/yaml", body: "openapi: 3.0.0" },
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
      { name: "file", filename: "document.pdf", contentType: "application/pdf", body: enc.encode("%PDF-1.4 binary content") },
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
      { name: "upload", filename: "data.bin", contentType: "application/octet-stream", body: binaryData },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.bytes).toEqual(binaryData);
  });

  it("handles a body with no content-type on a part (assumes empty string)", () => {
    const { bytes, contentType } = buildMultipart("simple", [
      { name: "text", body: "plain text with no content-type" },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.contentType).toBe("");
  });
});

// ─── Boundary parameter parsing ───────────────────────────────────────────────

describe("parseMultipart — boundary extraction", () => {
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
    const parts = parseMultipart(bytes, 'multipart/form-data; boundary="myboundary"');
    expect(parts).toHaveLength(1);
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe("value");
  });

  it("handles Chrome-style WebKit form boundary", () => {
    const boundary = "----WebKitFormBoundaryABCDEF123456";
    const { bytes, contentType } = buildMultipart(boundary, [
      { name: "file", filename: "openapi.yaml", contentType: "text/yaml", body: "paths: {}" },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.filename).toBe("openapi.yaml");
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe("paths: {}");
  });

  it("handles boundary with extra whitespace after semicolon in Content-Type", () => {
    const { bytes } = buildMultipart("spaced", [{ name: "f", body: "v" }]);
    // Extra spaces around boundary value
    const parts = parseMultipart(bytes, "multipart/form-data;  boundary=spaced");
    expect(parts).toHaveLength(1);
  });
});

// ─── Real-world wxO upload shapes ─────────────────────────────────────────────

describe("parseMultipart — wxO upload shapes", () => {
  it("parses a typical KB document upload (metadata field + PDF file)", () => {
    // Mirrors the shape wxO sends when uploading a document to a knowledge base.
    // POST /v2/orchestrate/knowledge-bases/{id}/documents
    const { bytes, contentType } = buildMultipart("----wxOFormBoundary001", [
      { name: "metadata", body: JSON.stringify({ name: "My Document", type: "pdf" }) },
      {
        name: "file",
        filename: "annual-report.pdf",
        contentType: "application/pdf",
        body: enc.encode("%PDF-1.5 fake pdf content for testing"),
      },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(2);

    const meta = parts.find((p) => p.fieldName === "metadata")!;
    expect(meta).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(meta.bytes))).toEqual({ name: "My Document", type: "pdf" });

    const file = parts.find((p) => p.fieldName === "file")!;
    expect(file).toBeDefined();
    expect(file.filename).toBe("annual-report.pdf");
    expect(file.contentType).toBe("application/pdf");
  });

  it("parses a typical OpenAPI tool spec upload (JSON metadata + YAML spec file)", () => {
    // Mirrors the shape wxO sends when creating an OpenAPI tool.
    // POST /v2/orchestrate/tools
    const specContent = [
      "openapi: 3.0.3",
      "info:",
      "  title: My API",
      "  version: 1.0.0",
      "paths:",
      "  /hello:",
      "    get:",
      "      responses:",
      "        '200':",
      "          description: OK",
    ].join("\n");

    const { bytes, contentType } = buildMultipart("----wxOToolBoundary", [
      {
        name: "tool_spec",
        body: JSON.stringify({ name: "my-api-tool", kind: "openapi", app_id: "my-connection" }),
      },
      {
        name: "file",
        filename: "my-api.yaml",
        contentType: "application/yaml",
        body: specContent,
      },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(2);

    const specPart = parts.find((p) => p.filename === "my-api.yaml")!;
    expect(specPart).toBeDefined();
    expect(specPart.contentType).toBe("application/yaml");
    expect(new TextDecoder().decode(specPart.bytes)).toBe(specContent);
  });

  it("parses a Python tool upload (.py source file)", () => {
    const pySource = [
      "from ibm_watsonx_orchestrate.agent_builder.tools import tool",
      "",
      "@tool",
      "def greet(name: str) -> str:",
      '    """Say hello."""',
      '    return f"Hello, {name}!"',
    ].join("\n");

    const { bytes, contentType } = buildMultipart("----WebKitFormBoundaryPyTool", [
      {
        name: "file",
        filename: "greet.py",
        contentType: "text/x-python",
        body: pySource,
      },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.filename).toBe("greet.py");
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe(pySource);
  });

  it("extracts only file parts when filtering by filename (non-empty filename)", () => {
    // The background script filters parts by `file.filename !== ""` — confirm only
    // the file part is selected, not the JSON metadata field.
    const { bytes, contentType } = buildMultipart("mixed", [
      { name: "kind", body: "openapi" },
      { name: "name", body: "my-tool" },
      { name: "file", filename: "spec.json", contentType: "application/json", body: "{}" },
    ]);
    const parts = parseMultipart(bytes, contentType);
    const fileParts = parts.filter((p) => p.filename !== "");
    expect(fileParts).toHaveLength(1);
    expect(fileParts[0]!.filename).toBe("spec.json");
  });
});

// ─── Binary safety ────────────────────────────────────────────────────────────

describe("parseMultipart — binary safety", () => {
  it("preserves a 256-byte sequence of all byte values 0x00–0xFF", () => {
    const allBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) allBytes[i] = i;

    const { bytes, contentType } = buildMultipart("safeboundary", [
      { name: "blob", filename: "all-bytes.bin", contentType: "application/octet-stream", body: allBytes },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.bytes).toEqual(allBytes);
  });

  it("does not corrupt UTF-8 multibyte characters in text files", () => {
    // Japanese, emoji, accented characters — all common in KB documents.
    const utf8Text = "日本語テスト — résumé — 🎉 こんにちは";
    const { bytes, contentType } = buildMultipart("utfbound", [
      { name: "doc", filename: "international.txt", contentType: "text/plain; charset=utf-8", body: utf8Text },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(new TextDecoder("utf-8").decode(parts[0]!.bytes)).toBe(utf8Text);
  });

  it("handles a body whose content contains the boundary string as data", () => {
    // The boundary appears *inside* the file content — parser must not split on it
    // because in a well-formed body the boundary is always preceded by CRLF--.
    const boundary = "testboundary";
    // This file content contains the boundary string without the leading "--".
    const bodyWithBoundaryInContent = `some data here\r\ntestboundary\r\nmore data`;
    const { bytes, contentType } = buildMultipart(boundary, [
      { name: "file", filename: "tricky.txt", body: bodyWithBoundaryInContent },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(1);
    expect(new TextDecoder().decode(parts[0]!.bytes)).toBe(bodyWithBoundaryInContent);
  });

  it("handles multiple large-ish parts without corruption", () => {
    // 64 KB of repeating pattern per part — checks that offset arithmetic stays correct.
    const chunk = new Uint8Array(64 * 1024).fill(0xab);
    const { bytes, contentType } = buildMultipart("largeboundary", [
      { name: "part1", filename: "a.bin", contentType: "application/octet-stream", body: chunk },
      { name: "part2", filename: "b.bin", contentType: "application/octet-stream", body: chunk },
    ]);
    const parts = parseMultipart(bytes, contentType);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.bytes.length).toBe(64 * 1024);
    expect(parts[1]!.bytes.length).toBe(64 * 1024);
    expect(parts[0]!.bytes.every((b) => b === 0xab)).toBe(true);
    expect(parts[1]!.bytes.every((b) => b === 0xab)).toBe(true);
  });
});
