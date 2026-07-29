import {
  AUTHORIZED_REVIEWERS,
  VIDEO_REVIEW_DIMENSIONS,
  type InterviewEvaluation,
  type TranscriptTurn,
} from "@/lib/interview";

type InterviewBindings = {
  DB?: D1Database;
  RECORDINGS?: R2Bucket;
  INTERVIEW_REVIEW_TOKEN_KASAMA?: string;
  INTERVIEW_REVIEW_TOKEN_YAMAMOTO?: string;
};

export type InterviewSessionRecord = {
  id: string;
  access_token_hash: string;
  candidate_name: string;
  employment: string;
  preferred_location: string;
  status: string;
  expires_at: string;
  retention_until: string;
};

export type AuthorizedReviewer = (typeof AUTHORIZED_REVIEWERS)[number];

export type VideoReviewScore = {
  name: (typeof VIDEO_REVIEW_DIMENSIONS)[number]["name"];
  score: number | null;
  note: string;
};

export const CONSENT_VERSION = "2026-07-29-v2";
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const STORAGE_POLICY = "manual-deletion-only-policy-pending";

export const CANDIDATE_EVENT_TYPES = [
  "audio_playback_blocked",
  "transcription_failed",
  "recording_unavailable",
  "connection_failed",
  "candidate_requested_stop",
] as const;

export type CandidateEventType = (typeof CANDIDATE_EVENT_TYPES)[number];

function bindings() {
  return (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: InterviewBindings;
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ ?? {};
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function publicSessionId() {
  const date = Date.now().toString(36).toUpperCase();
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return `TD-${date}-${toBase64Url(bytes).replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 7)}`;
}

function database() {
  return bindings().DB;
}

export function hasInterviewDatabase() {
  return Boolean(database());
}

export function hasRecordingStorage() {
  return Boolean(bindings().RECORDINGS);
}

async function ensureSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      access_token_hash TEXT NOT NULL,
      candidate_name TEXT DEFAULT '' NOT NULL,
      employment TEXT NOT NULL,
      preferred_location TEXT NOT NULL,
      consent_version TEXT NOT NULL,
      consented_at TEXT NOT NULL,
      status TEXT DEFAULT 'created' NOT NULL,
      recording_status TEXT DEFAULT 'not_started' NOT NULL,
      transcript_json TEXT,
      evaluation_json TEXT,
      summary TEXT,
      expires_at TEXT NOT NULL,
      retention_until TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_sessions_status_idx ON interview_sessions (status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_sessions_retention_idx ON interview_sessions (retention_until)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      etag TEXT,
      retention_until TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_artifacts_session_idx ON interview_artifacts (session_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_artifacts_retention_idx ON interview_artifacts (retention_until)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_audit_events_session_idx ON interview_audit_events (session_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_human_reviews (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
      reviewer_name TEXT NOT NULL,
      video_scores_json TEXT NOT NULL,
      overall_note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      UNIQUE(session_id, reviewer_name)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_human_reviews_session_idx ON interview_human_reviews (session_id)"),
  ]);
  const sessionColumns = await db.prepare("PRAGMA table_info(interview_sessions)")
    .all<{ name: string }>();
  if (!(sessionColumns.results ?? []).some((column) => column.name === "candidate_name")) {
    await db.prepare("ALTER TABLE interview_sessions ADD COLUMN candidate_name TEXT DEFAULT '' NOT NULL").run();
  }
}

async function audit(
  db: D1Database,
  sessionId: string,
  eventType: string,
  detail: Record<string, unknown> = {},
) {
  await db.prepare(
    "INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, ?, 'candidate', ?)",
  ).bind(crypto.randomUUID(), sessionId, eventType, JSON.stringify(detail)).run();
}

export async function createInterviewSession(input: {
  candidateName: string;
  employment: string;
  location: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);

  const now = new Date();
  const sessionId = publicSessionId();
  const accessToken = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await db.prepare(`INSERT INTO interview_sessions (
    id, access_token_hash, candidate_name, employment, preferred_location, consent_version,
    consented_at, status, expires_at, retention_until, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)`)
    .bind(
      sessionId,
      await sha256(accessToken),
      input.candidateName,
      input.employment,
      input.location,
      CONSENT_VERSION,
      now.toISOString(),
      expiresAt,
      STORAGE_POLICY,
      now.toISOString(),
      now.toISOString(),
    ).run();
  await audit(db, sessionId, "consent_recorded", { consentVersion: CONSENT_VERSION });

  return { sessionId, accessToken, expiresAt, storagePolicy: STORAGE_POLICY };
}

export async function authorizeInterviewRequest(request: Request, sessionId: string) {
  const db = database();
  if (!db) return null;

  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return null;
  const session = await db.prepare(
    "SELECT id, access_token_hash, candidate_name, employment, preferred_location, status, expires_at, retention_until FROM interview_sessions WHERE id = ? LIMIT 1",
  ).bind(sessionId).first<InterviewSessionRecord>();
  if (!session || session.access_token_hash !== await sha256(token)) return null;
  if (Date.parse(session.expires_at) <= Date.now()) return null;
  return { session };
}

function reviewerSecret(name: AuthorizedReviewer) {
  const bound = bindings();
  const key = name === "笠間"
    ? bound.INTERVIEW_REVIEW_TOKEN_KASAMA ?? (typeof process === "undefined" ? "" : process.env.INTERVIEW_REVIEW_TOKEN_KASAMA)
    : bound.INTERVIEW_REVIEW_TOKEN_YAMAMOTO ?? (typeof process === "undefined" ? "" : process.env.INTERVIEW_REVIEW_TOKEN_YAMAMOTO);
  return key?.trim() ?? "";
}

async function secureTokenMatch(actual: string, expected: string) {
  if (!actual || !expected) return false;
  return await sha256(actual) === await sha256(expected);
}

export async function authorizeReviewerRequest(request: Request) {
  const reviewerCode = request.headers.get("X-Interview-Reviewer")?.trim().toLowerCase() ?? "";
  const reviewer = reviewerCode === "kasama"
    ? "笠間"
    : reviewerCode === "yamamoto"
      ? "山本"
      : null;
  if (!reviewer) return null;
  const expected = reviewerSecret(reviewer);
  if (!expected) throw new Error("INTERVIEW_REVIEW_AUTH_UNCONFIGURED");
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return await secureTokenMatch(token, expected) ? reviewer : null;
}

export async function markInterviewStarted(sessionId: string) {
  const db = database();
  if (!db) return;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE interview_sessions SET status = 'in_progress', updated_at = ? WHERE id = ? AND status IN ('created', 'in_progress')")
      .bind(now, sessionId),
    db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'interview_started', 'candidate', '{}')")
      .bind(crypto.randomUUID(), sessionId),
  ]);
}

export async function saveInterviewEvaluation(input: {
  sessionId: string;
  transcript: TranscriptTurn[];
  evaluation: InterviewEvaluation;
}) {
  const db = database();
  if (!db) return;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE interview_sessions SET
      status = 'completed', transcript_json = ?, evaluation_json = ?, summary = ?,
      completed_at = ?, updated_at = ? WHERE id = ? AND status <> 'completed'`)
      .bind(
        JSON.stringify(input.transcript),
        JSON.stringify(input.evaluation),
        input.evaluation.summary,
        now,
        now,
        input.sessionId,
      ),
    db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'evaluation_saved', 'system', ?)")
      .bind(crypto.randomUUID(), input.sessionId, JSON.stringify({ humanReviewRequired: true })),
  ]);
}

export async function saveInterviewTranscript(input: {
  sessionId: string;
  transcript: TranscriptTurn[];
}) {
  const db = database();
  if (!db) return;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE interview_sessions SET
      status = 'evaluation_pending', transcript_json = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(input.transcript), now, input.sessionId),
    db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'transcript_saved', 'system', ?)")
      .bind(crypto.randomUUID(), input.sessionId, JSON.stringify({ turnCount: input.transcript.length })),
  ]);
}

export async function recordCandidateEvent(input: {
  sessionId: string;
  eventType: CandidateEventType;
  detail?: Record<string, string | number | boolean>;
}) {
  const db = database();
  if (!db) return;
  await db.prepare(
    "INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, ?, 'candidate', ?)",
  ).bind(
    crypto.randomUUID(),
    input.sessionId,
    input.eventType,
    JSON.stringify(input.detail ?? {}),
  ).run();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function getInterviewReview(sessionId: string, reviewer: AuthorizedReviewer) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const session = await db.prepare(`SELECT
    id, candidate_name, employment, preferred_location, status, recording_status,
    transcript_json, evaluation_json, summary, completed_at, created_at, updated_at
    FROM interview_sessions WHERE id = ? LIMIT 1`)
    .bind(sessionId)
    .first<Record<string, unknown>>();
  if (!session) return null;
  const reviews = await db.prepare(`SELECT reviewer_name, video_scores_json, overall_note, updated_at
    FROM interview_human_reviews WHERE session_id = ? ORDER BY reviewer_name`)
    .bind(sessionId)
    .all<Record<string, unknown>>();
  const technicalEvents = await db.prepare(`SELECT event_type, detail_json, created_at
    FROM interview_audit_events
    WHERE session_id = ? AND event_type IN (
      'audio_playback_blocked', 'transcription_failed', 'recording_unavailable',
      'connection_failed', 'candidate_requested_stop'
    ) ORDER BY created_at`)
    .bind(sessionId)
    .all<Record<string, unknown>>();
  await db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'review_opened', 'recruiter', ?)")
    .bind(crypto.randomUUID(), sessionId, JSON.stringify({ reviewer })).run();
  return {
    sessionId,
    candidateName: session.candidate_name,
    employment: session.employment,
    location: session.preferred_location,
    status: session.status,
    recordingStatus: session.recording_status,
    transcript: parseJson<TranscriptTurn[]>(session.transcript_json, []),
    evaluation: parseJson<InterviewEvaluation | null>(session.evaluation_json, null),
    completedAt: session.completed_at,
    createdAt: session.created_at,
    authorizedReviewers: AUTHORIZED_REVIEWERS,
    videoReviewRubric: VIDEO_REVIEW_DIMENSIONS,
    humanReviews: (reviews.results ?? []).map((review) => ({
      reviewerName: review.reviewer_name,
      videoScores: parseJson<VideoReviewScore[]>(review.video_scores_json, []),
      overallNote: typeof review.overall_note === "string" ? review.overall_note : "",
      updatedAt: review.updated_at,
    })),
    technicalEvents: (technicalEvents.results ?? []).map((event) => ({
      type: event.event_type,
      detail: parseJson<Record<string, unknown>>(event.detail_json, {}),
      createdAt: event.created_at,
    })),
  };
}

export async function saveHumanVideoReview(input: {
  sessionId: string;
  reviewer: AuthorizedReviewer;
  scores: VideoReviewScore[];
  overallNote: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const exists = await db.prepare("SELECT id FROM interview_sessions WHERE id = ? LIMIT 1")
    .bind(input.sessionId)
    .first<{ id: string }>();
  if (!exists) return false;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO interview_human_reviews (
      id, session_id, reviewer_name, video_scores_json, overall_note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, reviewer_name) DO UPDATE SET
      video_scores_json = excluded.video_scores_json,
      overall_note = excluded.overall_note,
      updated_at = excluded.updated_at`)
      .bind(
        crypto.randomUUID(),
        input.sessionId,
        input.reviewer,
        JSON.stringify(input.scores),
        input.overallNote,
        now,
        now,
      ),
    db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'video_review_saved', 'recruiter', ?)")
      .bind(crypto.randomUUID(), input.sessionId, JSON.stringify({ reviewer: input.reviewer })),
  ]);
  return true;
}

export async function saveInterviewRecording(input: {
  session: InterviewSessionRecord;
  body: ReadableStream;
  contentType: string;
  byteSize: number;
}) {
  const bucket = bindings().RECORDINGS;
  const db = database();
  if (!bucket || !db) throw new Error("INTERVIEW_RECORDING_STORAGE_UNAVAILABLE");

  const extension = input.contentType.includes("mp4") ? "mp4" : "webm";
  const objectKey = `interviews/${input.session.id}/recording.${extension}`;
  const object = await bucket.put(objectKey, input.body, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: {
      sessionId: input.session.id,
      storagePolicy: STORAGE_POLICY,
    },
  });
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO interview_artifacts (
      id, session_id, kind, object_key, content_type, byte_size, etag, retention_until
    ) VALUES (?, ?, 'recording', ?, ?, ?, ?, ?)
    ON CONFLICT(object_key) DO UPDATE SET
      content_type = excluded.content_type,
      byte_size = excluded.byte_size,
      etag = excluded.etag,
      retention_until = excluded.retention_until`)
      .bind(
        crypto.randomUUID(),
        input.session.id,
        objectKey,
        input.contentType,
        input.byteSize,
        object.etag,
        input.session.retention_until,
      ),
    db.prepare("UPDATE interview_sessions SET recording_status = 'stored', updated_at = ? WHERE id = ?")
      .bind(now, input.session.id),
    db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'recording_stored', 'system', ?)")
      .bind(crypto.randomUUID(), input.session.id, JSON.stringify({ byteSize: input.byteSize, contentType: input.contentType })),
  ]);

  return { objectKey, etag: object.etag };
}

export async function getInterviewRecording(sessionId: string, reviewer: AuthorizedReviewer) {
  const bucket = bindings().RECORDINGS;
  const db = database();
  if (!bucket || !db) throw new Error("INTERVIEW_RECORDING_STORAGE_UNAVAILABLE");
  await ensureSchema(db);
  const artifact = await db.prepare(`SELECT object_key, content_type, byte_size
    FROM interview_artifacts WHERE session_id = ? AND kind = 'recording'
    ORDER BY created_at DESC LIMIT 1`)
    .bind(sessionId)
    .first<{ object_key: string; content_type: string; byte_size: number }>();
  if (!artifact) return null;
  const object = await bucket.get(artifact.object_key);
  if (!object) return null;
  await db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'recording_opened', 'recruiter', ?)")
    .bind(crypto.randomUUID(), sessionId, JSON.stringify({ reviewer })).run();
  return {
    body: object.body,
    contentType: artifact.content_type,
    byteSize: artifact.byte_size,
    etag: object.etag,
  };
}
