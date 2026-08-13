import { privacySafeIdentifier, requireOpenAIApiKey } from "@/lib/openai-server";

type ManualRepairBindings = {
  INTERVIEW_MANUAL_REPAIR_TOKEN?: string;
  INTERVIEW_MANUAL_REPAIR_SESSION_IDS?: string;
  OPENAI_API?: Fetcher;
};

export type ManualRepairAuthorization = "authorized" | "unauthorized" | "unconfigured";

export type ManualTranscriptSegment = {
  speaker: string;
  start: number;
  end: number;
  text: string;
};

export const MANUAL_TRANSCRIPTION_MODEL = "gpt-4o-transcribe-diarize";
export const MAX_MANUAL_AUDIO_BYTES = 24_000_000;

const MINIMUM_REPAIR_TOKEN_LENGTH = 43;
const MAXIMUM_REPAIR_TOKEN_LENGTH = 512;
const MAX_UPSTREAM_RESPONSE_BYTES = 2_000_000;
const MAX_TRANSCRIPT_SEGMENTS = 10_000;
const MAX_SEGMENT_TEXT_CHARS = 10_000;
const MAX_TRANSCRIPT_TEXT_CHARS = 300_000;
const OPENAI_TIMEOUT_MS = 180_000;
const URLSAFE_TOKEN = /^[A-Za-z0-9_-]+$/;
const SESSION_ID = /^TD-[A-Z0-9]{8}-[A-Z0-9]{7}$/;
const AUDIO_SHA256 = /^[a-f0-9]{64}$/;
const AUDIO_INDEX = /^[1-6]$/;
const SPEAKER = /^[A-Za-z0-9._-]{1,80}$/;

function bindings() {
  return (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: ManualRepairBindings;
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ ?? {};
}

function configuredRepairToken() {
  return (
    bindings().INTERVIEW_MANUAL_REPAIR_TOKEN ??
    (typeof process === "undefined" ? "" : process.env.INTERVIEW_MANUAL_REPAIR_TOKEN) ??
    ""
  ).trim();
}

function configuredRepairSessionIds() {
  const raw = (
    bindings().INTERVIEW_MANUAL_REPAIR_SESSION_IDS ??
    (typeof process === "undefined" ? "" : process.env.INTERVIEW_MANUAL_REPAIR_SESSION_IDS) ??
    ""
  ).trim();
  if (!raw || raw.length > 128) return null;
  const values = raw.split(",").map((value) => value.trim());
  const unique = new Set(values);
  if (
    values.length !== 3 ||
    unique.size !== 3 ||
    values.some((value) => !SESSION_ID.test(value))
  ) return null;
  return unique;
}

async function sha256Bytes(bytes: Uint8Array) {
  const stableBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stableBytes.buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Value(value: string) {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

/** Authenticates only the isolated, three-session manual-repair route. */
export async function authorizeManualRepairRequest(
  request: Request,
): Promise<ManualRepairAuthorization> {
  const expected = configuredRepairToken();
  if (
    !configuredRepairSessionIds() ||
    expected.length < MINIMUM_REPAIR_TOKEN_LENGTH ||
    expected.length > MAXIMUM_REPAIR_TOKEN_LENGTH ||
    !URLSAFE_TOKEN.test(expected)
  ) return "unconfigured";

  const authorization = request.headers.get("Authorization") ?? "";
  if (authorization.length > 600 || !authorization.startsWith("Bearer ")) {
    return "unauthorized";
  }
  const actual = authorization.slice(7).trim();
  if (
    actual.length < MINIMUM_REPAIR_TOKEN_LENGTH ||
    actual.length > MAXIMUM_REPAIR_TOKEN_LENGTH ||
    !URLSAFE_TOKEN.test(actual)
  ) return "unauthorized";

  const [actualHash, expectedHash] = await Promise.all([
    sha256Value(actual),
    sha256Value(expected),
  ]);
  return constantTimeEqual(actualHash, expectedHash) ? "authorized" : "unauthorized";
}

export function validateManualRepairHeaders(request: Request) {
  const allowedSessionIds = configuredRepairSessionIds();
  if (!allowedSessionIds) return { state: "configuration_unavailable" } as const;

  const contentType = (request.headers.get("Content-Type") ?? "").trim().toLowerCase();
  if (contentType !== "audio/mpeg") return { state: "invalid_content_type" } as const;

  const contentLength = request.headers.get("Content-Length") ?? "";
  if (!/^\d{1,9}$/.test(contentLength)) return { state: "length_required" } as const;
  const declaredByteSize = Number(contentLength);
  if (!Number.isSafeInteger(declaredByteSize) || declaredByteSize <= 0) {
    return { state: "invalid_body" } as const;
  }
  if (declaredByteSize > MAX_MANUAL_AUDIO_BYTES) return { state: "too_large" } as const;

  const sessionId = request.headers.get("X-Interview-Session-Id") ?? "";
  if (!allowedSessionIds.has(sessionId)) return { state: "invalid_session" } as const;

  const expectedSha256 = request.headers.get("X-Interview-Audio-Sha256") ?? "";
  if (!AUDIO_SHA256.test(expectedSha256)) return { state: "invalid_digest" } as const;

  const rawAudioIndex = request.headers.get("X-Interview-Audio-Index") ?? "";
  if (!AUDIO_INDEX.test(rawAudioIndex)) return { state: "invalid_index" } as const;

  return {
    state: "valid",
    declaredByteSize,
    sessionId,
    expectedSha256,
    audioIndex: Number(rawAudioIndex),
  } as const;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
) {
  if (!stream) throw new Error("BODY_MISSING");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      byteSize += value.byteLength;
      if (byteSize > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readAndVerifyManualRepairAudio(
  request: Request,
  declaredByteSize: number,
  expectedSha256: string,
) {
  const bytes = await readBoundedStream(request.body, MAX_MANUAL_AUDIO_BYTES);
  if (bytes.byteLength !== declaredByteSize || bytes.byteLength === 0) {
    throw new Error("BODY_SIZE_MISMATCH");
  }
  if (await sha256Bytes(bytes) !== expectedSha256) {
    throw new Error("BODY_DIGEST_MISMATCH");
  }
  return bytes;
}

function normalizeDiarizedSegments(payload: unknown): ManualTranscriptSegment[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("UPSTREAM_RESPONSE_INVALID");
  }
  const segments = (payload as { segments?: unknown }).segments;
  if (
    !Array.isArray(segments) ||
    segments.length === 0 ||
    segments.length > MAX_TRANSCRIPT_SEGMENTS
  ) throw new Error("UPSTREAM_RESPONSE_INVALID");

  let totalChars = 0;
  return segments.map((segment) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      throw new Error("UPSTREAM_RESPONSE_INVALID");
    }
    const candidate = segment as {
      speaker?: unknown;
      start?: unknown;
      end?: unknown;
      text?: unknown;
    };
    const speaker = typeof candidate.speaker === "string" && SPEAKER.test(candidate.speaker)
      ? candidate.speaker
      : "";
    const text = typeof candidate.text === "string"
      ? candidate.text.replaceAll("\0", "").trim()
      : "";
    const start = candidate.start;
    const end = candidate.end;
    totalChars += text.length;
    if (
      !speaker ||
      !text ||
      typeof start !== "number" ||
      !Number.isFinite(start) ||
      start < 0 ||
      typeof end !== "number" ||
      !Number.isFinite(end) ||
      end < start ||
      text.length > MAX_SEGMENT_TEXT_CHARS ||
      totalChars > MAX_TRANSCRIPT_TEXT_CHARS
    ) throw new Error("UPSTREAM_RESPONSE_INVALID");
    return { speaker, start, end, text };
  });
}

async function readUpstreamPayload(response: Response) {
  const declaredLength = response.headers.get("Content-Length") ?? "";
  if (/^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error("UPSTREAM_RESPONSE_TOO_LARGE");
  }
  const bytes = await readBoundedStream(response.body, MAX_UPSTREAM_RESPONSE_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("UPSTREAM_RESPONSE_INVALID");
  }
}

export type ManualTranscriptionResult =
  | { state: "completed"; segments: ManualTranscriptSegment[] }
  | { state: "upstream_rejected"; status: number }
  | { state: "upstream_unavailable" }
  | { state: "invalid_upstream_response" };

/**
 * Performs exactly one paid OpenAI request. The caller decides whether a
 * failed attempt is ever retried, preventing ambiguous duplicate charges.
 */
export async function createManualTranscriptDraft(input: {
  sessionId: string;
  audioIndex: number;
  audio: Uint8Array;
}): Promise<ManualTranscriptionResult> {
  const bound = bindings();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.set("model", MANUAL_TRANSCRIPTION_MODEL);
    form.set("language", "ja");
    form.set("response_format", "diarized_json");
    form.set("chunking_strategy", "auto");
    form.set("file", new File(
      [Uint8Array.from(input.audio).buffer],
      `manual-audio-${String(input.audioIndex).padStart(2, "0")}.mp3`,
      { type: "audio/mpeg" },
    ));

    const openAIRequest = new Request("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireOpenAIApiKey()}`,
        "OpenAI-Safety-Identifier": await privacySafeIdentifier(input.sessionId),
      },
      body: form,
      signal: controller.signal,
    });

    let response: Response;
    try {
      response = bound.OPENAI_API
        ? await bound.OPENAI_API.fetch(openAIRequest)
        : await fetch(openAIRequest);
    } catch {
      return { state: "upstream_unavailable" };
    }

    if (!response.ok) {
      // Do not parse or reflect the provider body: it can contain request
      // metadata. There is deliberately no retry here.
      if (response.status === 429 || response.status >= 500) {
        return { state: "upstream_unavailable" };
      }
      return { state: "upstream_rejected", status: response.status };
    }

    try {
      const payload = await readUpstreamPayload(response);
      return { state: "completed", segments: normalizeDiarizedSegments(payload) };
    } catch {
      return { state: "invalid_upstream_response" };
    }
  } finally {
    clearTimeout(timeout);
  }
}
