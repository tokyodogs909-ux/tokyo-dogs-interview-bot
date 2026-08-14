export type BoundedJsonBodyResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413 | 415; reason: "malformed" | "too_large" | "unsupported_media_type" };

export type BoundedTextBodyResult =
  | { ok: true; value: string }
  | { ok: false; status: 400 | 413; reason: "malformed" | "too_large" };

function isJsonMediaType(value: string) {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" ||
    (mediaType.startsWith("application/") && mediaType.endsWith("+json"));
}

async function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    await reader.cancel();
  } catch {
    // The caller receives the fixed body classification below. Stream details
    // may contain framework or transport data and must not escape the server.
  }
}

export async function readBoundedTextBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedTextBodyResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("TEXT_BODY_LIMIT_INVALID");
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) return { ok: false, status: 400, reason: "malformed" };
    if (!Number.isSafeInteger(Number(declaredLength)) || Number(declaredLength) > maxBytes) {
      return { ok: false, status: 413, reason: "too_large" };
    }
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await cancelQuietly(reader);
          return { ok: false, status: 413, reason: "too_large" };
        }
        chunks.push(value);
      }
    } catch {
      await cancelQuietly(reader);
      return { ok: false, status: 400, reason: "malformed" };
    }
  }
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, status: 400, reason: "malformed" };
  }
}

export async function readBoundedJsonBody<T = unknown>(
  request: Request,
  options: { maxBytes: number; allowEmpty?: boolean },
): Promise<BoundedJsonBodyResult<T>> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error("JSON_BODY_LIMIT_INVALID");
  }
  if (!isJsonMediaType(request.headers.get("Content-Type") ?? "")) {
    return { ok: false, status: 415, reason: "unsupported_media_type" };
  }

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      return { ok: false, status: 400, reason: "malformed" };
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      return { ok: false, status: 413, reason: "too_large" };
    }
    if (parsedLength > options.maxBytes) {
      return { ok: false, status: 413, reason: "too_large" };
    }
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        totalBytes += value.byteLength;
        if (totalBytes > options.maxBytes) {
          await cancelQuietly(reader);
          return { ok: false, status: 413, reason: "too_large" };
        }
        chunks.push(value);
      }
    } catch {
      await cancelQuietly(reader);
      return { ok: false, status: 400, reason: "malformed" };
    }
  }

  if (totalBytes === 0 && options.allowEmpty) return { ok: true, value: {} as T };
  try {
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: 400, reason: "malformed" };
  }
}
