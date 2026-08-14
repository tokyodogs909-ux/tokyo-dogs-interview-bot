export type OpenAIFetcher = { fetch(request: Request): Promise<Response> };

export type OpenAIRequestFailureCode =
  | "OPENAI_REQUEST_TIMEOUT"
  | "OPENAI_REQUEST_TRANSPORT"
  | "OPENAI_RESPONSE_TOO_LARGE";

export class OpenAIRequestFailure extends Error {
  readonly code: OpenAIRequestFailureCode;

  constructor(code: OpenAIRequestFailureCode) {
    super(code);
    this.name = "OpenAIRequestFailure";
    this.code = code;
  }
}

async function readBoundedResponseBody(response: Response, maxResponseBytes: number) {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxResponseBytes) {
    throw new OpenAIRequestFailure("OPENAI_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      try {
        await reader.cancel();
      } catch {
        // Preserve only the fixed safe code.
      }
      throw new OpenAIRequestFailure("OPENAI_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Executes one OpenAI request and keeps the AbortController alive until the
 * response body has been completely consumed. Thrown errors contain only fixed
 * codes: never the request URL, authorization header, body, or upstream text.
 */
export async function fetchOpenAIBytes(
  request: Request,
  options: {
    timeoutMs: number;
    maxResponseBytes: number;
    fetcher?: OpenAIFetcher;
  },
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const boundedRequest = new Request(request, { signal: controller.signal });
    const response = options.fetcher
      ? await options.fetcher.fetch(boundedRequest)
      : await fetch(boundedRequest);
    const bytes = await readBoundedResponseBody(response, options.maxResponseBytes);
    return { response, bytes };
  } catch (error) {
    if (error instanceof OpenAIRequestFailure) throw error;
    throw new OpenAIRequestFailure(
      controller.signal.aborted || (error instanceof Error && error.name === "AbortError")
        ? "OPENAI_REQUEST_TIMEOUT"
        : "OPENAI_REQUEST_TRANSPORT",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function decodeOpenAIJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("OPENAI_RESPONSE_INVALID");
  }
}

export function decodeOpenAIText(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("OPENAI_RESPONSE_INVALID");
  }
}
