import { privacySafeIdentifier, requireOpenAIApiKey } from "@/lib/openai-server";
import type { InterviewSessionRecord } from "@/lib/interview-persistence";

type RecordedTranscriptionBindings = {
  DB?: D1Database;
  RECORDINGS?: R2Bucket;
  OPENAI_API?: Fetcher;
};

type RecordedAnswerRow = {
  session_id: string;
  answer_index: number;
  object_key: string;
  content_type: string;
  byte_size: number;
  audio_sha256: string;
  etag: string | null;
  status: "pending" | "processing" | "completed" | "failed";
  transcript_text: string | null;
  claim_id: string | null;
  claimed_at: string | null;
  attempt_count: number;
  last_error_code: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RecordedAnswerTranscript = {
  answerIndex: number;
  text: string;
};

export type RecordedAnswerTranscriptionResult =
  | { state: "completed"; answerIndex: number; text: string; alreadyCompleted: boolean }
  | { state: "pending"; answerIndex: number; retryAfterSeconds: number; reason: "busy" | "upstream_unavailable" }
  | { state: "missing"; answerIndex: number }
  | { state: "failed"; answerIndex: number; reason: "invalid_audio" };

export const RECORDED_ANSWER_COUNT = 15;
export const MAX_RECORDED_ANSWER_BYTES = 10 * 1024 * 1024;
export const RECORDED_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const TRANSCRIPTION_CLAIM_STALE_MS = 3 * 60 * 1000;
const TRANSCRIPTION_TIMEOUT_MS = 75 * 1000;
const MAX_TRANSCRIPT_CHARS = 50_000;
const RECORDED_TRANSCRIPTION_RETRY_EVENT = "RECORDED_ANSWER_TRANSCRIPTION_RETRYABLE_FAILURE";
const SAFE_CAUGHT_TRANSCRIPTION_CODES = new Map<string, string>([
  ["RECORDED_ANSWER_AUDIO_SIZE_MISMATCH", "recorded_answer_audio_size_mismatch"],
  ["RECORDED_ANSWER_AUDIO_DIGEST_MISMATCH", "recorded_answer_audio_digest_mismatch"],
  ["OPENAI_API_KEY is not configured on the server", "openai_api_key_unconfigured"],
]);

function bindings() {
  return (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: RecordedTranscriptionBindings;
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ ?? {};
}

function resources() {
  const bound = bindings();
  if (!bound.DB || !bound.RECORDINGS) {
    throw new Error("RECORDED_TRANSCRIPTION_STORAGE_UNAVAILABLE");
  }
  return { db: bound.DB, bucket: bound.RECORDINGS, openAI: bound.OPENAI_API };
}

export function validateRecordedAnswerIndex(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= RECORDED_ANSWER_COUNT;
}

export function validateRecordedAnswerContentType(value: string) {
  const contentType = value.split(";")[0].trim().toLowerCase();
  return ["audio/webm", "audio/mp4"].includes(contentType) ? contentType : null;
}

async function ensureSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS recorded_answer_transcriptions (
      session_id TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
      answer_index INTEGER NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      audio_sha256 TEXT NOT NULL,
      etag TEXT,
      status TEXT DEFAULT 'pending' NOT NULL,
      transcript_text TEXT,
      claim_id TEXT,
      claimed_at TEXT,
      attempt_count INTEGER DEFAULT 0 NOT NULL,
      last_error_code TEXT,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, answer_index)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS recorded_answer_transcriptions_status_idx ON recorded_answer_transcriptions (session_id, status, answer_index)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS recorded_interview_completions (
      session_id TEXT PRIMARY KEY NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
      expected_answer_count INTEGER NOT NULL,
      requested_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS recorded_interview_completions_requested_idx ON recorded_interview_completions (requested_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_evaluation_claims (
      session_id TEXT PRIMARY KEY NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
      claim_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_evaluation_claims_started_idx ON interview_evaluation_claims (started_at)"),
  ]);
}

function objectKey(sessionId: string, answerIndex: number, contentType: string) {
  const extension = contentType === "audio/mp4" ? "m4a" : "webm";
  return `interviews/${sessionId}/recorded-answers/answer-${String(answerIndex).padStart(2, "0")}.${extension}`;
}

async function sha256(bytes: Uint8Array) {
  const stableBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stableBytes.buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function answerRow(db: D1Database, sessionId: string, answerIndex: number) {
  return await db.prepare(`SELECT
    session_id, answer_index, object_key, content_type, byte_size, audio_sha256,
    etag, status, transcript_text, claim_id, claimed_at, attempt_count,
    last_error_code, next_retry_at, created_at, updated_at
    FROM recorded_answer_transcriptions
    WHERE session_id = ? AND answer_index = ? LIMIT 1`)
    .bind(sessionId, answerIndex)
    .first<RecordedAnswerRow>();
}

async function registerAudio(input: {
  db: D1Database;
  bucket: R2Bucket;
  session: InterviewSessionRecord;
  answerIndex: number;
  contentType: string;
  bytes: Uint8Array;
}) {
  const digest = await sha256(input.bytes);
  const key = objectKey(input.session.id, input.answerIndex, input.contentType);
  const now = new Date().toISOString();
  await input.db.prepare(`INSERT OR IGNORE INTO recorded_answer_transcriptions (
    session_id, answer_index, object_key, content_type, byte_size, audio_sha256,
    status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(
      input.session.id,
      input.answerIndex,
      key,
      input.contentType,
      input.bytes.byteLength,
      digest,
      now,
      now,
    )
    .run();
  const row = await answerRow(input.db, input.session.id, input.answerIndex);
  if (!row) throw new Error("RECORDED_TRANSCRIPTION_ROW_UNAVAILABLE");
  if (
    row.audio_sha256 !== digest ||
    row.byte_size !== input.bytes.byteLength ||
    row.content_type !== input.contentType ||
    row.object_key !== key
  ) {
    throw new Error("RECORDED_ANSWER_AUDIO_CONFLICT");
  }
  if (row.status === "completed") return row;
  const stored = await input.bucket.head(row.object_key);
  let etag = stored?.etag ?? row.etag;
  if (stored && stored.customMetadata?.sha256 !== digest) {
    // Never overwrite an existing deterministic answer key when its provenance
    // cannot be proven identical. This prevents a concurrent/replayed request
    // from silently mixing two candidate answers.
    throw new Error("RECORDED_ANSWER_AUDIO_CONFLICT");
  }
  if (!stored) {
    const object = await input.bucket.put(row.object_key, input.bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: {
        sessionId: input.session.id,
        answerIndex: String(input.answerIndex),
        byteSize: String(input.bytes.byteLength),
        sha256: digest,
        retentionUntil: input.session.retention_until,
      },
    });
    etag = object.etag ?? null;
  }
  await input.db.prepare(`UPDATE recorded_answer_transcriptions
    SET etag = ?, updated_at = ?
    WHERE session_id = ? AND answer_index = ? AND audio_sha256 = ?`)
    .bind(etag, new Date().toISOString(), input.session.id, input.answerIndex, digest)
    .run();
  return await answerRow(input.db, input.session.id, input.answerIndex) ?? row;
}

function sanitizedOpenAIError(payload: unknown) {
  const error = payload && typeof payload === "object" && "error" in payload
    ? (payload as { error?: unknown }).error
    : null;
  if (!error || typeof error !== "object") return null;
  const value = (error as { code?: unknown; type?: unknown }).code ??
    (error as { code?: unknown; type?: unknown }).type;
  return typeof value === "string" && /^[a-z0-9._-]{1,80}$/i.test(value) ? value : null;
}

function safeDiagnosticCode(value: unknown) {
  return typeof value === "string" && /^[a-z][a-z0-9._-]{0,79}$/i.test(value)
    ? value
    : "unknown_error";
}

function safeOpenAIRequestId(value: unknown) {
  // OpenAI request IDs are opaque machine identifiers. Accept only their short
  // request-token shape so a malformed/reflected header cannot inject a secret,
  // candidate text, control characters, or unbounded data into production logs.
  return typeof value === "string" && /^req[_-][a-z0-9_-]{1,72}$/i.test(value)
    ? value
    : "unavailable";
}

function safeDiagnosticInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function warnRecordedTranscriptionRetry(input: {
  status: number;
  code: string;
  requestId: string | null;
  sessionIdHash: string;
  answerIndex: number;
  retryAfterSeconds: number;
  attempt: number;
}) {
  // This intentionally has no candidate identity, object key, audio bytes,
  // transcript, upstream response body/message, request body, or credential.
  console.warn(RECORDED_TRANSCRIPTION_RETRY_EVENT, {
    status: safeDiagnosticInteger(input.status, 100, 599, 0),
    code: safeDiagnosticCode(input.code),
    requestId: safeOpenAIRequestId(input.requestId),
    sessionIdHash: /^[a-f0-9]{32}$/.test(input.sessionIdHash) ? input.sessionIdHash : "unavailable",
    answerIndex: safeDiagnosticInteger(input.answerIndex, 1, RECORDED_ANSWER_COUNT, 0),
    retryAfterSeconds: safeDiagnosticInteger(input.retryAfterSeconds, 1, 300, 300),
    attempt: safeDiagnosticInteger(input.attempt, 1, 10_000, 10_000),
  });
}

function safeCaughtTranscriptionCode(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "transcription_timeout";
  if (error instanceof Error) {
    const knownCode = SAFE_CAUGHT_TRANSCRIPTION_CODES.get(error.message);
    if (knownCode) return knownCode;
  }
  // Never reflect an unknown Error.message. Transport implementations can put
  // URLs, credentials, request bodies, or other uncontrolled text in it.
  return "transcription_transport_error";
}

function retrySeconds(response: Response | null, attemptCount: number) {
  const retryAfter = Number(response?.headers.get("retry-after") ?? "");
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(300, Math.ceil(retryAfter));
  return Math.min(300, 15 * (2 ** Math.min(4, Math.max(0, attemptCount - 1))));
}

async function markPending(input: {
  db: D1Database;
  row: RecordedAnswerRow;
  claimId: string;
  code: string;
  retryAfterSeconds: number;
}) {
  const now = new Date();
  const retryAt = new Date(now.getTime() + input.retryAfterSeconds * 1000).toISOString();
  await input.db.batch([
    input.db.prepare(`UPDATE recorded_answer_transcriptions
      SET status = 'pending', claim_id = NULL, claimed_at = NULL,
        last_error_code = ?, next_retry_at = ?, updated_at = ?
      WHERE session_id = ? AND answer_index = ? AND status = 'processing' AND claim_id = ?`)
      .bind(
        input.code,
        retryAt,
        now.toISOString(),
        input.row.session_id,
        input.row.answer_index,
        input.claimId,
      ),
    input.db.prepare(`INSERT INTO interview_audit_events (
      id, session_id, event_type, actor_type, detail_json
    ) VALUES (?, ?, 'transcription_failed', 'system', ?)`)
      .bind(crypto.randomUUID(), input.row.session_id, JSON.stringify({
        answerIndex: input.row.answer_index,
        errorCode: input.code,
        retryable: true,
        retryAt,
      })),
  ]);
}

async function markFailed(input: {
  db: D1Database;
  row: RecordedAnswerRow;
  claimId: string;
  code: string;
}) {
  await input.db.batch([
    input.db.prepare(`UPDATE recorded_answer_transcriptions
      SET status = 'failed', claim_id = NULL, claimed_at = NULL,
        last_error_code = ?, next_retry_at = NULL, updated_at = ?
      WHERE session_id = ? AND answer_index = ? AND status = 'processing' AND claim_id = ?`)
      .bind(
        input.code,
        new Date().toISOString(),
        input.row.session_id,
        input.row.answer_index,
        input.claimId,
      ),
    input.db.prepare(`INSERT INTO interview_audit_events (
      id, session_id, event_type, actor_type, detail_json
    ) VALUES (?, ?, 'transcription_failed', 'system', ?)`)
      .bind(crypto.randomUUID(), input.row.session_id, JSON.stringify({
        answerIndex: input.row.answer_index,
        errorCode: input.code,
        retryable: false,
      })),
  ]);
}

async function transcribeRegisteredAnswer(
  db: D1Database,
  bucket: R2Bucket,
  openAI: Fetcher | undefined,
  row: RecordedAnswerRow,
): Promise<RecordedAnswerTranscriptionResult> {
  if (row.status === "completed" && row.transcript_text?.trim()) {
    return { state: "completed", answerIndex: row.answer_index, text: row.transcript_text, alreadyCompleted: true };
  }
  if (row.status === "failed") {
    return { state: "failed", answerIndex: row.answer_index, reason: "invalid_audio" };
  }
  const now = new Date();
  if (row.next_retry_at && row.next_retry_at > now.toISOString()) {
    const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(row.next_retry_at) - now.getTime()) / 1000));
    return { state: "pending", answerIndex: row.answer_index, retryAfterSeconds, reason: "upstream_unavailable" };
  }
  const claimId = crypto.randomUUID();
  const claimedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - TRANSCRIPTION_CLAIM_STALE_MS).toISOString();
  const claim = await db.prepare(`UPDATE recorded_answer_transcriptions
    SET status = 'processing', claim_id = ?, claimed_at = ?,
      attempt_count = attempt_count + 1, last_error_code = NULL,
      next_retry_at = NULL, updated_at = ?
    WHERE session_id = ? AND answer_index = ?
      AND (status = 'pending' OR (status = 'processing' AND claimed_at < ?))`)
    .bind(claimId, claimedAt, claimedAt, row.session_id, row.answer_index, staleBefore)
    .run();
  if (Number(claim.meta?.changes ?? 0) !== 1) {
    return { state: "pending", answerIndex: row.answer_index, retryAfterSeconds: 5, reason: "busy" };
  }
  const claimedRow = await answerRow(db, row.session_id, row.answer_index) ?? {
    ...row,
    status: "processing" as const,
    claim_id: claimId,
    claimed_at: claimedAt,
    attempt_count: row.attempt_count + 1,
  };
  const sessionIdHash = await privacySafeIdentifier(row.session_id);
  const object = await bucket.get(row.object_key);
  if (!object) {
    warnRecordedTranscriptionRetry({
      status: 0,
      code: "audio_object_missing",
      requestId: null,
      sessionIdHash,
      answerIndex: row.answer_index,
      retryAfterSeconds: 30,
      attempt: claimedRow.attempt_count,
    });
    await markPending({ db, row: claimedRow, claimId, code: "audio_object_missing", retryAfterSeconds: 30 });
    return { state: "pending", answerIndex: row.answer_index, retryAfterSeconds: 30, reason: "upstream_unavailable" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
  let upstreamResponse: Response | null = null;
  try {
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== row.byte_size) throw new Error("RECORDED_ANSWER_AUDIO_SIZE_MISMATCH");
    if (await sha256(new Uint8Array(bytes)) !== row.audio_sha256) {
      throw new Error("RECORDED_ANSWER_AUDIO_DIGEST_MISMATCH");
    }
    const form = new FormData();
    form.set("model", RECORDED_TRANSCRIPTION_MODEL);
    form.set("language", "ja");
    form.set("response_format", "json");
    form.set("file", new File(
      [bytes],
      `answer-${String(row.answer_index).padStart(2, "0")}.${row.content_type === "audio/mp4" ? "m4a" : "webm"}`,
      { type: row.content_type },
    ));
    const request = new Request("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireOpenAIApiKey()}`,
        "OpenAI-Safety-Identifier": sessionIdHash,
      },
      body: form,
      signal: controller.signal,
    });
    upstreamResponse = openAI ? await openAI.fetch(request) : await fetch(request);
    const payload = await upstreamResponse.json().catch(() => null) as { text?: unknown } | null;
    if (!upstreamResponse.ok) {
      const errorCode = sanitizedOpenAIError(payload) ?? `http_${upstreamResponse.status}`;
      if ([401, 403, 429].includes(upstreamResponse.status) || upstreamResponse.status >= 500) {
        // Authentication, billing, quota, and transient service failures are not
        // properties of the candidate's recording. Keep the durable audio pending
        // so an operator can fix the service and replay it without re-recording.
        const seconds = [401, 403].includes(upstreamResponse.status)
          ? 300
          : retrySeconds(upstreamResponse, claimedRow.attempt_count);
        warnRecordedTranscriptionRetry({
          status: upstreamResponse.status,
          code: errorCode,
          requestId: upstreamResponse.headers.get("x-request-id"),
          sessionIdHash,
          answerIndex: row.answer_index,
          retryAfterSeconds: seconds,
          attempt: claimedRow.attempt_count,
        });
        await markPending({ db, row: claimedRow, claimId, code: errorCode, retryAfterSeconds: seconds });
        return { state: "pending", answerIndex: row.answer_index, retryAfterSeconds: seconds, reason: "upstream_unavailable" };
      }
      await markFailed({ db, row: claimedRow, claimId, code: errorCode });
      return { state: "failed", answerIndex: row.answer_index, reason: "invalid_audio" };
    }
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (!text || text.length > MAX_TRANSCRIPT_CHARS) {
      await markFailed({ db, row: claimedRow, claimId, code: "invalid_transcript" });
      return { state: "failed", answerIndex: row.answer_index, reason: "invalid_audio" };
    }
    const completedAt = new Date().toISOString();
    const completed = await db.prepare(`UPDATE recorded_answer_transcriptions
      SET status = 'completed', transcript_text = ?, claim_id = NULL,
        claimed_at = NULL, last_error_code = NULL, next_retry_at = NULL, updated_at = ?
      WHERE session_id = ? AND answer_index = ? AND status = 'processing' AND claim_id = ?`)
      .bind(text, completedAt, row.session_id, row.answer_index, claimId)
      .run();
    if (Number(completed.meta?.changes ?? 0) !== 1) {
      return { state: "pending", answerIndex: row.answer_index, retryAfterSeconds: 5, reason: "busy" };
    }
    return { state: "completed", answerIndex: row.answer_index, text, alreadyCompleted: false };
  } catch (error) {
    const code = safeCaughtTranscriptionCode(error);
    const seconds = retrySeconds(upstreamResponse, claimedRow.attempt_count);
    warnRecordedTranscriptionRetry({
      status: upstreamResponse?.status ?? 0,
      code,
      requestId: upstreamResponse?.headers.get("x-request-id") ?? null,
      sessionIdHash,
      answerIndex: row.answer_index,
      retryAfterSeconds: seconds,
      attempt: claimedRow.attempt_count,
    });
    await markPending({ db, row: claimedRow, claimId, code, retryAfterSeconds: seconds });
    return { state: "pending", answerIndex: row.answer_index, retryAfterSeconds: seconds, reason: "upstream_unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function saveAndTranscribeRecordedAnswer(input: {
  session: InterviewSessionRecord;
  answerIndex: number;
  contentType?: string;
  bytes?: Uint8Array;
}) {
  if (!validateRecordedAnswerIndex(input.answerIndex)) throw new Error("RECORDED_ANSWER_INDEX_INVALID");
  const { db, bucket, openAI } = resources();
  await ensureSchema(db);
  let row: RecordedAnswerRow | null;
  if (input.bytes) {
    if (!input.contentType || !validateRecordedAnswerContentType(input.contentType)) {
      throw new Error("RECORDED_ANSWER_CONTENT_TYPE_INVALID");
    }
    if (input.bytes.byteLength <= 0 || input.bytes.byteLength > MAX_RECORDED_ANSWER_BYTES) {
      throw new Error("RECORDED_ANSWER_SIZE_INVALID");
    }
    row = await registerAudio({
      db,
      bucket,
      session: input.session,
      answerIndex: input.answerIndex,
      contentType: validateRecordedAnswerContentType(input.contentType)!,
      bytes: input.bytes,
    });
  } else {
    row = await answerRow(db, input.session.id, input.answerIndex);
  }
  if (!row) return { state: "missing", answerIndex: input.answerIndex } as const;
  return await transcribeRegisteredAnswer(db, bucket, openAI, row);
}

export async function getCompletedRecordedAnswerTranscripts(sessionId: string, answerCount: number) {
  if (!Number.isInteger(answerCount) || answerCount < 1 || answerCount > RECORDED_ANSWER_COUNT) {
    throw new Error("RECORDED_ANSWER_COUNT_INVALID");
  }
  const { db } = resources();
  await ensureSchema(db);
  const rows = await db.prepare(`SELECT answer_index, status, transcript_text
    FROM recorded_answer_transcriptions
    WHERE session_id = ?
    ORDER BY answer_index ASC`)
    .bind(sessionId)
    .all<{ answer_index: number; status: string; transcript_text: string | null }>();
  const registered = (rows.results ?? []).filter((row) => validateRecordedAnswerIndex(row.answer_index));
  if (registered.some((row) => row.answer_index > answerCount)) {
    throw new Error("RECORDED_ANSWER_COUNT_MISMATCH");
  }
  const valid = registered.flatMap((row) => {
    const text = typeof row.transcript_text === "string" ? row.transcript_text.trim() : "";
    return row.status === "completed" && text
      ? [{ answerIndex: row.answer_index, text }]
      : [];
  });
  const byIndex = new Map(valid.map((row) => [row.answerIndex, row]));
  return Array.from({ length: answerCount }, (_, index) => byIndex.get(index + 1) ?? null);
}

export async function sealRecordedInterviewCompletion(sessionId: string, expectedAnswerCount: number) {
  if (!Number.isInteger(expectedAnswerCount) || expectedAnswerCount < 1 || expectedAnswerCount > RECORDED_ANSWER_COUNT) {
    throw new Error("RECORDED_ANSWER_COUNT_INVALID");
  }
  const { db } = resources();
  await ensureSchema(db);
  const now = new Date().toISOString();
  await db.prepare(`INSERT OR IGNORE INTO recorded_interview_completions (
    session_id, expected_answer_count, requested_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?)`)
    .bind(sessionId, expectedAnswerCount, now, now, now)
    .run();
  const seal = await db.prepare(`SELECT session_id, expected_answer_count, requested_at
    FROM recorded_interview_completions WHERE session_id = ? LIMIT 1`)
    .bind(sessionId)
    .first<{ session_id: string; expected_answer_count: number; requested_at: string }>();
  if (!seal) throw new Error("RECORDED_COMPLETION_SEAL_UNAVAILABLE");
  if (Number(seal.expected_answer_count) !== expectedAnswerCount) {
    throw new Error("RECORDED_ANSWER_COUNT_MISMATCH");
  }
  return { expectedAnswerCount, requestedAt: seal.requested_at };
}

export async function getRecordedInterviewCompletionSeal(sessionId: string) {
  const { db } = resources();
  await ensureSchema(db);
  const seal = await db.prepare(`SELECT session_id, expected_answer_count, requested_at
    FROM recorded_interview_completions WHERE session_id = ? LIMIT 1`)
    .bind(sessionId)
    .first<{ session_id: string; expected_answer_count: number; requested_at: string }>();
  return seal
    ? { expectedAnswerCount: Number(seal.expected_answer_count), requestedAt: seal.requested_at }
    : null;
}

export async function recoverNextRecordedAnswerTranscription() {
  const { db, bucket, openAI } = resources();
  await ensureSchema(db);
  const now = new Date();
  const staleBefore = new Date(now.getTime() - TRANSCRIPTION_CLAIM_STALE_MS).toISOString();
  const row = await db.prepare(`SELECT
    r.session_id, r.answer_index, r.object_key, r.content_type, r.byte_size,
    r.audio_sha256, r.etag, r.status, r.transcript_text, r.claim_id,
    r.claimed_at, r.attempt_count, r.last_error_code, r.next_retry_at,
    r.created_at, r.updated_at
    FROM recorded_answer_transcriptions r
    INNER JOIN interview_sessions s ON s.id = r.session_id
    INNER JOIN recorded_interview_completions c ON c.session_id = r.session_id
    WHERE s.status IN ('in_progress', 'evaluation_pending', 'evaluation_processing')
      AND s.recording_status = 'stored'
      AND r.answer_index <= c.expected_answer_count
      AND (
        (r.status = 'pending' AND (r.next_retry_at IS NULL OR r.next_retry_at <= ?))
        OR (r.status = 'processing' AND (r.claimed_at IS NULL OR r.claimed_at < ?))
      )
    ORDER BY r.updated_at ASC, r.session_id ASC, r.answer_index ASC
    LIMIT 1`)
    .bind(now.toISOString(), staleBefore)
    .first<RecordedAnswerRow>();
  if (!row) return { state: "none" } as const;
  const result = await transcribeRegisteredAnswer(db, bucket, openAI, row);
  return {
    state: "processed",
    sessionId: row.session_id,
    answerIndex: row.answer_index,
    result: result.state,
    retryAfterSeconds: result.state === "pending" ? result.retryAfterSeconds : undefined,
  } as const;
}

export async function findRecordedInterviewReadyForCompletion() {
  const { db } = resources();
  await ensureSchema(db);
  const ready = await db.prepare(`SELECT
    c.session_id, c.expected_answer_count
    FROM recorded_interview_completions c
    INNER JOIN interview_sessions s ON s.id = c.session_id
    LEFT JOIN interview_evaluation_claims e ON e.session_id = s.id
    WHERE (s.status IN ('in_progress', 'evaluation_pending') OR
      (s.status = 'evaluation_processing' AND
        ((e.started_at IS NOT NULL AND e.started_at < ?)
          OR (e.session_id IS NULL AND s.updated_at < ?))))
      AND s.recording_status = 'stored'
      AND c.expected_answer_count BETWEEN 1 AND ?
      AND (SELECT COUNT(*) FROM recorded_answer_transcriptions r
        WHERE r.session_id = c.session_id
          AND r.answer_index BETWEEN 1 AND c.expected_answer_count
          AND r.status = 'completed'
          AND LENGTH(TRIM(COALESCE(r.transcript_text, ''))) > 0
      ) = c.expected_answer_count
      AND NOT EXISTS (SELECT 1 FROM recorded_answer_transcriptions extra
        WHERE extra.session_id = c.session_id
          AND extra.answer_index > c.expected_answer_count)
    ORDER BY c.requested_at ASC, c.session_id ASC
    LIMIT 1`)
    .bind(
      new Date(Date.now() - 10 * 60 * 1_000).toISOString(),
      new Date(Date.now() - 10 * 60 * 1_000).toISOString(),
      RECORDED_ANSWER_COUNT,
    )
    .first<{ session_id: string; expected_answer_count: number }>();
  return ready
    ? { sessionId: ready.session_id, questionCount: Number(ready.expected_answer_count) }
    : null;
}
