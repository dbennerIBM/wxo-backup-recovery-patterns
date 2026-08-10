/**
 * Multipart/form-data decoder — pure function, no browser dependencies.
 *
 * Parses raw multipart bodies captured via chrome.webRequest.onBeforeRequest
 * or content script fetch interception. Handles both text and binary parts.
 */

export interface MultipartFile {
  /** Original filename from the Content-Disposition header (empty string if absent). */
  filename: string;
  /** MIME type from the part's Content-Type header (empty string if absent). */
  contentType: string;
  /** Raw bytes of the part body. */
  bytes: Uint8Array;
  /** Field name from the Content-Disposition header. */
  fieldName: string;
}

/**
 * Parse a multipart/form-data body.
 *
 * @param body        Raw request body bytes.
 * @param contentType The value of the Content-Type header, which must contain
 *                    the boundary parameter, e.g.:
 *                    "multipart/form-data; boundary=----WebKitFormBoundaryXXX"
 * @returns           An array of parsed parts. Non-file text fields are included
 *                    with an empty filename.
 */
export function parseMultipart(
  body: Uint8Array,
  contentType: string,
): MultipartFile[] {
  const boundary = extractBoundary(contentType);
  if (boundary === null) {
    return [];
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8", { fatal: false });

  // Build boundary delimiter bytes: "--{boundary}"
  const delimiterBytes = enc.encode("--" + boundary);
  const closingBytes = enc.encode("--" + boundary + "--");
  const CRLF = enc.encode("\r\n");

  const parts: MultipartFile[] = [];

  // Split the body on the delimiter.
  // Each part starts after the delimiter + CRLF and ends before the next delimiter.
  let searchOffset = 0;

  while (searchOffset < body.length) {
    // Find the next delimiter.
    const delimPos = indexOf(body, delimiterBytes, searchOffset);
    if (delimPos === -1) break;

    const afterDelim = delimPos + delimiterBytes.length;

    // Check for closing delimiter ("--{boundary}--")
    if (startsWith(body, closingBytes, delimPos)) {
      break;
    }

    // Skip the CRLF after the delimiter.
    let partStart = afterDelim;
    if (startsWith(body, CRLF, partStart)) {
      partStart += CRLF.length;
    }

    // Find the end of this part (next delimiter).
    const nextDelimPos = indexOf(body, delimiterBytes, partStart);
    if (nextDelimPos === -1) break;

    // The part body ends just before the CRLF that precedes the next delimiter.
    let partEnd = nextDelimPos;
    if (partEnd >= CRLF.length && endsWithCRLF(body, partEnd)) {
      partEnd -= CRLF.length;
    }

    // Split headers from body: blank line ("\r\n\r\n") separates them.
    const headerSep = enc.encode("\r\n\r\n");
    const headerEndPos = indexOf(body, headerSep, partStart);
    if (headerEndPos === -1 || headerEndPos >= partEnd) {
      searchOffset = nextDelimPos;
      continue;
    }

    const headerBytes = body.slice(partStart, headerEndPos);
    const headerText = dec.decode(headerBytes);
    const partBodyBytes = body.slice(headerEndPos + headerSep.length, partEnd);

    const { fieldName, filename, contentType: partContentType } =
      parsePartHeaders(headerText);

    parts.push({
      filename,
      contentType: partContentType,
      bytes: partBodyBytes,
      fieldName,
    });

    searchOffset = nextDelimPos;
  }

  return parts;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Extract the boundary value from a Content-Type header string. */
function extractBoundary(contentType: string): string | null {
  const match = /boundary=("?)([^";\s]+)\1/i.exec(contentType);
  return match ? match[2] ?? null : null;
}

/** Parse the headers section of a single multipart part. */
function parsePartHeaders(headerText: string): {
  fieldName: string;
  filename: string;
  contentType: string;
} {
  let fieldName = "";
  let filename = "";
  let contentType = "";

  for (const line of headerText.split("\r\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (name === "content-disposition") {
      fieldName = extractDispositionParam(value, "name") ?? "";
      filename = extractDispositionParam(value, "filename") ?? "";
    } else if (name === "content-type") {
      contentType = value;
    }
  }

  return { fieldName, filename, contentType };
}

/** Extract a named parameter from a Content-Disposition value. */
function extractDispositionParam(
  disposition: string,
  param: string,
): string | null {
  const re = new RegExp(`(?:^|;)\\s*${param}=("?)([^";\r\n]*?)\\1(?=;|$)`, "i");
  const match = re.exec(disposition);
  return match ? (match[2] ?? null) : null;
}

/**
 * Return the index of `needle` in `haystack` starting at `fromIndex`,
 * or -1 if not found.
 */
function indexOf(
  haystack: Uint8Array,
  needle: Uint8Array,
  fromIndex = 0,
): number {
  outer: for (let i = fromIndex; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Return true if `haystack` starts with `prefix` at `offset`. */
function startsWith(
  haystack: Uint8Array,
  prefix: Uint8Array,
  offset: number,
): boolean {
  if (offset + prefix.length > haystack.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (haystack[offset + i] !== prefix[i]) return false;
  }
  return true;
}

/** Return true if the byte sequence ending at `end` (exclusive) is CRLF. */
function endsWithCRLF(bytes: Uint8Array, end: number): boolean {
  return end >= 2 && bytes[end - 2] === 0x0d && bytes[end - 1] === 0x0a;
}
