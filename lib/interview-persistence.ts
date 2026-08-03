import {
  VIDEO_REVIEW_DIMENSIONS,
  type InterviewEvaluation,
  type TranscriptTurn,
} from "@/lib/interview";
import {
  assertSignedInviteConfigured,
  createInterviewInviteToken,
  inspectInterviewInviteToken,
  sha256Hex,
  signedInvitesRequired,
} from "@/lib/interview-invite";

type InterviewBindings = {
  DB?: D1Database;
  RECORDINGS?: R2Bucket;
  INTERVIEW_STAFF_TOKEN?: string;
  INTERVIEW_ADMIN_TOKEN?: string;
  INTERVIEW_INVITE_SIGNING_SECRET?: string;
  INTERVIEW_REQUIRE_SIGNED_INVITE?: string;
};

export type InterviewSessionRecord = {
  id: string;
  access_token_hash: string;
  candidate_name: string;
  employment: string;
  preferred_location: string;
  status: string;
  recording_status: string;
  expires_at: string;
  retention_until: string;
};

export type AuthorizedReviewer = string;

export type VideoReviewScore = {
  name: (typeof VIDEO_REVIEW_DIMENSIONS)[number]["name"];
  score: number | null;
  note: string;
};

export const CONSENT_VERSION = "2026-07-29-v2";
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const INTERVIEW_RETENTION_DAYS = 365;
export const RECORDING_UPLOAD_PART_BYTES = 4 * 1024 * 1024;
const MAX_RECORDING_BYTES = 95 * 1024 * 1024;
const MAX_RECORDING_PARTS = 32;

function retentionUntil(from: Date) {
  return new Date(from.getTime() + INTERVIEW_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
}

export const CANDIDATE_EVENT_TYPES = [
  "audio_playback_blocked",
  "transcription_failed",
  "recording_unavailable",
  "connection_failed",
  "candidate_requested_stop",
  "time_limit_reached",
  "reasonable_accommodation_text_selected",
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

function constantTimeEqualText(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
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
      evaluation_claim_id TEXT,
      evaluation_started_at TEXT,
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
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_staff_audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      reviewer_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_staff_audit_events_created_idx ON interview_staff_audit_events (created_at)"),
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
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_invites (
      nonce_hash TEXT PRIMARY KEY NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      session_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_invites_expiry_idx ON interview_invites (expires_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_public_entries (
      id TEXT PRIMARY KEY NOT NULL,
      source_hash TEXT NOT NULL,
      candidate_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_public_entries_source_idx ON interview_public_entries (source_hash, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_public_entries_candidate_idx ON interview_public_entries (candidate_hash, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_external_syncs (
      session_id TEXT NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      status TEXT DEFAULT 'pending' NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      folder_id TEXT,
      folder_url TEXT,
      manifest_json TEXT,
      error_code TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      UNIQUE(session_id, provider)
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_external_syncs_status_idx ON interview_external_syncs (status)"),
  ]);
  const sessionColumns = await db.prepare("PRAGMA table_info(interview_sessions)")
    .all<{ name: string }>();
  const existingColumns = new Set((sessionColumns.results ?? []).map((column) => column.name));
  const addColumnIfMissing = async (name: string, sql: string) => {
    if (existingColumns.has(name)) return;
    try {
      await db.prepare(sql).run();
      existingColumns.add(name);
    } catch (error) {
      // Another request may have applied the same migration between PRAGMA and
      // ALTER. Re-read instead of failing a candidate request on that harmless race.
      const refreshed = await db.prepare("PRAGMA table_info(interview_sessions)")
        .all<{ name: string }>();
      if (!(refreshed.results ?? []).some((column) => column.name === name)) throw error;
      existingColumns.add(name);
    }
  };
  await addColumnIfMissing(
    "candidate_name",
    "ALTER TABLE interview_sessions ADD COLUMN candidate_name TEXT DEFAULT '' NOT NULL",
  );
  await addColumnIfMissing(
    "evaluation_claim_id",
    "ALTER TABLE interview_sessions ADD COLUMN evaluation_claim_id TEXT",
  );
  await addColumnIfMissing(
    "evaluation_started_at",
    "ALTER TABLE interview_sessions ADD COLUMN evaluation_started_at TEXT",
  );
}

const PUBLIC_ENTRY_WINDOW_MS = 6 * 60 * 60 * 1_000;
const PUBLIC_ENTRY_SOURCE_LIMIT = 8;
const PUBLIC_ENTRY_CANDIDATE_LIMIT = 3;
const PUBLIC_ENTRY_GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1_000;
// Expected volume is about 30 interviews/month. This hard ceiling keeps the
// same-link workflow while stopping forged-source floods before paid calls.
const PUBLIC_ENTRY_GLOBAL_LIMIT = 60;

/**
 * Reserves capacity for an invite-free candidate before creating a paid interview
 * session. A single SQL INSERT performs both count checks atomically, so concurrent
 * requests cannot all pass the same stale count. Only HMAC identifiers are stored.
 */
export async function reservePublicInterviewEntry(input: {
  sourceHash: string;
  candidateHash: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - PUBLIC_ENTRY_WINDOW_MS).toISOString();
  const globalCutoffIso = new Date(now.getTime() - PUBLIC_ENTRY_GLOBAL_WINDOW_MS).toISOString();
  const staleBeforeIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
  const results = await db.batch([
    db.prepare("DELETE FROM interview_public_entries WHERE created_at <= ?").bind(staleBeforeIso),
    db.prepare(`INSERT INTO interview_public_entries (id, source_hash, candidate_hash, created_at)
      SELECT ?, ?, ?, ?
      WHERE (
        SELECT COUNT(*) FROM interview_public_entries
        WHERE source_hash = ? AND created_at > ?
      ) < ?
      AND (
        SELECT COUNT(*) FROM interview_public_entries
        WHERE candidate_hash = ? AND created_at > ?
      ) < ?
      AND (
        SELECT COUNT(*) FROM interview_public_entries
        WHERE created_at > ?
      ) < ?`).bind(
        crypto.randomUUID(),
        input.sourceHash,
        input.candidateHash,
        nowIso,
        input.sourceHash,
        cutoffIso,
        PUBLIC_ENTRY_SOURCE_LIMIT,
        input.candidateHash,
        cutoffIso,
        PUBLIC_ENTRY_CANDIDATE_LIMIT,
        globalCutoffIso,
        PUBLIC_ENTRY_GLOBAL_LIMIT,
      ),
  ]);
  const reserved = Number((results[1] as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
  if (!reserved) throw new Error("INTERVIEW_PUBLIC_ENTRY_RATE_LIMITED");
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
  interviewMode: "camera" | "text";
  inviteNonceHash?: string | null;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);

  const now = new Date();
  const sessionId = publicSessionId();
  const accessToken = randomToken();
  const accessTokenHash = await sha256(accessToken);
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const retentionDate = retentionUntil(now);
  if (input.inviteNonceHash) {
    const results = await db.batch([
      db.prepare(`INSERT INTO interview_sessions (
        id, access_token_hash, candidate_name, employment, preferred_location, consent_version,
        consented_at, status, expires_at, retention_until, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM interview_invites
          WHERE nonce_hash = ? AND used_at IS NULL AND expires_at > ?
        )`).bind(
        sessionId,
        accessTokenHash,
        input.candidateName,
        input.employment,
        input.location,
        CONSENT_VERSION,
        nowIso,
        expiresAt,
        retentionDate,
        nowIso,
        nowIso,
        input.inviteNonceHash,
        nowIso,
      ),
      db.prepare(`UPDATE interview_invites SET used_at = ?, session_id = ?
        WHERE nonce_hash = ? AND used_at IS NULL AND expires_at > ?`)
        .bind(nowIso, sessionId, input.inviteNonceHash, nowIso),
      db.prepare(`INSERT INTO interview_audit_events (
        id, session_id, event_type, actor_type, detail_json
      ) SELECT ?, ?, 'consent_recorded', 'candidate', ?
        WHERE EXISTS (SELECT 1 FROM interview_sessions WHERE id = ?)`)
        .bind(
          crypto.randomUUID(),
          sessionId,
          JSON.stringify({ consentVersion: CONSENT_VERSION, interviewMode: input.interviewMode }),
          sessionId,
        ),
    ]);
    const sessionCreated = Number((results[0] as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
    const inviteConsumed = Number((results[1] as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
    if (!sessionCreated || !inviteConsumed) throw new Error("INTERVIEW_INVITE_INVALID");
  } else {
    await db.prepare(`INSERT INTO interview_sessions (
      id, access_token_hash, candidate_name, employment, preferred_location, consent_version,
      consented_at, status, expires_at, retention_until, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)`)
      .bind(
        sessionId,
        accessTokenHash,
        input.candidateName,
        input.employment,
        input.location,
        CONSENT_VERSION,
        nowIso,
        expiresAt,
        retentionDate,
        nowIso,
        nowIso,
      ).run();
    await audit(db, sessionId, "consent_recorded", {
      consentVersion: CONSENT_VERSION,
      interviewMode: input.interviewMode,
    });
  }

  return {
    sessionId,
    accessToken,
    expiresAt,
    retentionUntil: retentionDate,
    retentionDays: INTERVIEW_RETENTION_DAYS,
  };
}

export async function issueInterviewInvite(expiresInHours: number) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const boundedHours = Math.max(1, Math.min(168, Math.floor(expiresInHours)));
  const nonce = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + boundedHours * 60 * 60 * 1000);
  await db.prepare("INSERT INTO interview_invites (nonce_hash, expires_at) VALUES (?, ?)")
    .bind(await sha256Hex(nonce), expiresAt.toISOString()).run();
  return {
    token: await createInterviewInviteToken(nonce, expiresAt),
    expiresAt: expiresAt.toISOString(),
  };
}

export type InterviewInviteStatus =
  | "not-required"
  | "ok"
  | "missing"
  | "invalid"
  | "expired"
  | "used";

/**
 * Reports why a signed invite link cannot be used, so both the pre-flight check and
 * the session route can tell the candidate whether the link is missing, expired, or
 * already used. Throws INTERVIEW_INVITE_SIGNING_UNCONFIGURED / INTERVIEW_DATABASE_UNAVAILABLE
 * for operator-side gaps; callers translate those into candidate-facing wording.
 *
 * This never grants access on its own — createInterviewSession still consumes the
 * invite atomically, which is what actually enforces single use.
 */
export async function describeInterviewInvite(
  token: string | undefined,
): Promise<{ status: InterviewInviteStatus; nonceHash: string | null }> {
  // Common-entry mode accepts the plain URL, while an explicitly supplied legacy
  // or optional individual invite still keeps its expiry and single-use semantics.
  if (!signedInvitesRequired() && !token) return { status: "not-required", nonceHash: null };
  assertSignedInviteConfigured();
  if (!token) return { status: "missing", nonceHash: null };
  const inspected = await inspectInterviewInviteToken(token);
  if (inspected.status === "expired") return { status: "expired", nonceHash: null };
  if (inspected.status !== "valid") return { status: "invalid", nonceHash: null };

  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const invite = await db.prepare(
    "SELECT used_at, expires_at FROM interview_invites WHERE nonce_hash = ? LIMIT 1",
  ).bind(inspected.nonceHash).first<{ used_at: string | null; expires_at: string }>();
  if (!invite) return { status: "invalid", nonceHash: null };
  if (invite.used_at) return { status: "used", nonceHash: null };
  if (Date.parse(invite.expires_at) <= Date.now()) return { status: "expired", nonceHash: null };
  return { status: "ok", nonceHash: inspected.nonceHash };
}

export async function authorizeInterviewRequest(request: Request, sessionId: string) {
  const db = database();
  if (!db) return null;

  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return null;
  const session = await db.prepare(
    "SELECT id, access_token_hash, candidate_name, employment, preferred_location, status, recording_status, expires_at, retention_until FROM interview_sessions WHERE id = ? LIMIT 1",
  ).bind(sessionId).first<InterviewSessionRecord>();
  if (!session || !constantTimeEqualText(session.access_token_hash, await sha256(token))) return null;
  if (Date.parse(session.expires_at) <= Date.now()) return null;
  return { session };
}

export async function claimInterviewRecordingUpload(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const result = await db.prepare(`UPDATE interview_sessions SET
    recording_status = 'uploading', updated_at = ?
    WHERE id = ? AND (
      recording_status IN ('not_started', 'failed') OR
      (recording_status = 'uploading' AND updated_at < ?)
    )`)
    .bind(now.toISOString(), sessionId, staleBefore)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function failInterviewRecordingUpload(sessionId: string) {
  const db = database();
  if (!db) return;
  await db.prepare(`UPDATE interview_sessions SET
    recording_status = 'failed', updated_at = ?
    WHERE id = ? AND recording_status = 'uploading'`)
    .bind(new Date().toISOString(), sessionId)
    .run();
}

function reviewerSecret() {
  const bound = bindings();
  const candidates = [
    bound.INTERVIEW_STAFF_TOKEN,
    typeof process === "undefined" ? "" : process.env.INTERVIEW_STAFF_TOKEN,
  ];
  return candidates.find((candidate) => candidate?.trim())?.trim() ?? "";
}

export function normalizeReviewerName(value: string) {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 40 || /[\u0000-\u001F\u007F]/u.test(normalized)) return null;
  return normalized;
}

/**
 * Returns configuration state only. Secret values are intentionally never
 * exposed, even to the authenticated readiness endpoint.
 */
export function reviewerAuthenticationReadiness() {
  const dedicated = Boolean(
    bindings().INTERVIEW_STAFF_TOKEN
      ?? (typeof process === "undefined" ? "" : process.env.INTERVIEW_STAFF_TOKEN),
  );
  return {
    configured: Boolean(reviewerSecret()),
    dedicated,
  };
}

async function secureTokenMatch(actual: string, expected: string) {
  if (!actual || !expected) return false;
  const [actualHash, expectedHash] = await Promise.all([sha256(actual), sha256(expected)]);
  return constantTimeEqualText(actualHash, expectedHash);
}

export async function authorizeReviewerRequest(request: Request) {
  const reviewerHeader = request.headers.get("X-Interview-Reviewer") ?? "";
  if (reviewerHeader.length > 240) return null;
  let decodedReviewer = "";
  try {
    decodedReviewer = decodeURIComponent(reviewerHeader);
  } catch {
    return null;
  }
  const reviewer = normalizeReviewerName(decodedReviewer);
  if (!reviewer) return null;
  const expected = reviewerSecret();
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

export async function markTextInterviewStarted(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const now = new Date().toISOString();
  const result = await db.batch([
    db.prepare(`UPDATE interview_sessions SET
      status = 'in_progress', recording_status = 'not_applicable', updated_at = ?
      WHERE id = ? AND status IN ('created', 'in_progress')`)
      .bind(now, sessionId),
    db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'reasonable_accommodation_text_selected', 'candidate', ?)")
      .bind(crypto.randomUUID(), sessionId, JSON.stringify({ selectionImpact: "none" })),
  ]);
  return Number((result[0] as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

const REALTIME_CONNECTION_LIMIT_PER_SESSION = 12;

/**
 * An access token is intentionally reusable for reconnects during its two-hour
 * interview window. Without a separate budget, however, one leaked token can mint
 * an unbounded number of paid realtime calls. The INSERT ... SELECT is a single D1
 * statement so concurrent reconnects cannot all pass a read-then-write race.
 */
export async function reserveInterviewRealtimeConnection(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const result = await db.prepare(`INSERT INTO interview_audit_events (
    id, session_id, event_type, actor_type, detail_json
  ) SELECT ?, ?, 'realtime_connection_reserved', 'candidate', ?
    WHERE (SELECT COUNT(*) FROM interview_audit_events
      WHERE session_id = ? AND event_type = 'realtime_connection_reserved') < ?`)
    .bind(
      crypto.randomUUID(),
      sessionId,
      JSON.stringify({ limit: REALTIME_CONNECTION_LIMIT_PER_SESSION }),
      sessionId,
      REALTIME_CONNECTION_LIMIT_PER_SESSION,
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

const EVALUATION_CLAIM_STALE_AFTER_MS = 10 * 60 * 1_000;

/**
 * Claims the one paid evaluation call for a session before contacting the model.
 * A Worker that died after claiming can be recovered after ten minutes, while a
 * concurrent or replayed request is rejected before incurring another model call.
 */
export async function claimInterviewEvaluation(input: {
  sessionId: string;
  transcript: TranscriptTurn[];
}) {
  const db = database();
  if (!db) return null;
  const now = new Date().toISOString();
  const claimId = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - EVALUATION_CLAIM_STALE_AFTER_MS).toISOString();
  const result = await db.prepare(`UPDATE interview_sessions SET
    status = 'evaluation_processing', transcript_json = ?, evaluation_claim_id = ?,
    evaluation_started_at = ?, updated_at = ?
    WHERE id = ? AND (
      status IN ('in_progress', 'evaluation_pending') OR
      (status = 'evaluation_processing' AND
        (evaluation_started_at IS NULL OR evaluation_started_at < ?))
    )`)
    .bind(JSON.stringify(input.transcript), claimId, now, now, input.sessionId, staleBefore)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) return null;
  await db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'evaluation_started', 'system', ?)")
    .bind(crypto.randomUUID(), input.sessionId, JSON.stringify({ turnCount: input.transcript.length }))
    .run();
  return claimId;
}

export async function failInterviewEvaluation(sessionId: string, claimId: string) {
  const db = database();
  if (!db) return;
  await db.prepare(`UPDATE interview_sessions SET
    status = 'evaluation_pending', evaluation_claim_id = NULL,
    evaluation_started_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'evaluation_processing' AND evaluation_claim_id = ?`)
    .bind(new Date().toISOString(), sessionId, claimId)
    .run();
}

export async function saveInterviewEvaluation(input: {
  sessionId: string;
  transcript: TranscriptTurn[];
  evaluation: InterviewEvaluation;
  claimId: string;
}) {
  const db = database();
  if (!db) return false;
  const now = new Date().toISOString();
  // Only the request holding the evaluation_processing claim may complete the
  // session. A duplicate submission is rejected before the model call, and this
  // final fence protects against a stale Worker whose claim was reclaimed.
  // The UPDATE silently no-ops if this Worker no longer holds the claim, so the
  // audit insert must be conditioned on that same guard. Otherwise a rejected
  // duplicate would still write an 'evaluation_saved' audit row, misrepresenting it as
  // having been persisted when the original evaluation was left untouched.
  const results = await db.batch([
    db.prepare(`UPDATE interview_sessions SET
      status = 'completed', transcript_json = ?, evaluation_json = ?, summary = ?,
      evaluation_claim_id = NULL, evaluation_started_at = NULL,
      completed_at = ?, updated_at = ? WHERE id = ?
      AND status = 'evaluation_processing' AND evaluation_claim_id = ?`)
      .bind(
        JSON.stringify(input.transcript),
        JSON.stringify(input.evaluation),
        input.evaluation.summary,
        now,
        now,
        input.sessionId,
        input.claimId,
      ),
    db.prepare(`INSERT INTO interview_audit_events (
      id, session_id, event_type, actor_type, detail_json
    ) SELECT ?, ?, 'evaluation_saved', 'system', ?
      WHERE EXISTS (SELECT 1 FROM interview_sessions WHERE id = ? AND completed_at = ?)`)
      .bind(
        crypto.randomUUID(),
        input.sessionId,
        JSON.stringify({ humanReviewRequired: true }),
        input.sessionId,
        now,
      ),
  ]);
  return Number((results[0] as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
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

export type ExternalSyncStatus = {
  provider: "google_drive";
  status: "pending" | "running" | "completed" | "failed";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  folderId: string | null;
  folderUrl: string | null;
  manifest: Record<string, unknown> | null;
  errorCode: string | null;
  updatedAt: string;
};

const EXTERNAL_SYNC_STALE_AFTER_MS = 15 * 60 * 1_000;

type ExternalSyncRow = {
  provider: string;
  status: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  folder_id: string | null;
  folder_url: string | null;
  manifest_json: string | null;
  error_code: string | null;
  updated_at: string;
};

function safeExternalSyncStatus(row: ExternalSyncRow | null): ExternalSyncStatus | null {
  if (!row || row.provider !== "google_drive") return null;
  const status = ["pending", "running", "completed", "failed"].includes(row.status)
    ? row.status as ExternalSyncStatus["status"]
    : "failed";
  return {
    provider: "google_drive",
    status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    folderId: row.folder_id,
    folderUrl: row.folder_url,
    manifest: parseJson<Record<string, unknown> | null>(row.manifest_json, null),
    errorCode: row.error_code,
    updatedAt: row.updated_at,
  };
}

export async function getExternalSyncStatus(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const row = await db.prepare(`SELECT provider, status, requested_at, started_at, completed_at,
    folder_id, folder_url, manifest_json, error_code, updated_at
    FROM interview_external_syncs WHERE session_id = ? AND provider = 'google_drive' LIMIT 1`)
    .bind(sessionId).first<ExternalSyncRow>();
  return safeExternalSyncStatus(row);
}

export async function requestExternalSync(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const now = new Date().toISOString();
  // While a sync is running, updated_at belongs to that worker: it is the
  // progress heartbeat the staleness check below reads. Overwriting it here
  // would hide a genuinely stuck sync forever, so only a non-running row gets
  // its updated_at refreshed.
  await db.prepare(`INSERT INTO interview_external_syncs (
    session_id, provider, status, requested_at, updated_at
  ) VALUES (?, 'google_drive', 'pending', ?, ?)
  ON CONFLICT(session_id, provider) DO UPDATE SET
    requested_at = excluded.requested_at,
    status = CASE WHEN interview_external_syncs.status = 'running' THEN 'running' ELSE 'pending' END,
    updated_at = CASE WHEN interview_external_syncs.status = 'running'
      THEN interview_external_syncs.updated_at ELSE excluded.updated_at END`)
    .bind(sessionId, now, now).run();
  const staleBefore = new Date(Date.now() - EXTERNAL_SYNC_STALE_AFTER_MS).toISOString();
  // Reclaiming a running sync starts a second worker against the same Drive
  // folder, and two concurrent workers create duplicate files that the archive
  // read-back then rejects. The claim is therefore only reclaimed when the
  // owner has not reported progress (heartbeatExternalSync) for the whole stale
  // window, i.e. when it really is dead rather than merely slow.
  const recovered = await db.prepare(`UPDATE interview_external_syncs SET
    status = 'pending', started_at = NULL, completed_at = NULL,
    error_code = NULL, updated_at = ?
    WHERE session_id = ? AND provider = 'google_drive' AND status = 'running'
      AND started_at IS NOT NULL AND updated_at <= ?`)
    .bind(now, sessionId, staleBefore).run();
  if (Number(recovered.meta?.changes ?? 0) === 1) {
    await db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'google_drive_sync_stale_recovered', 'system', ?)")
      .bind(crypto.randomUUID(), sessionId, JSON.stringify({ staleBefore })).run();
  }
  return now;
}

/**
 * Reports that the worker holding `startedAt` is still making progress, and
 * reports back whether it still owns the claim. A worker whose claim was
 * reclaimed must stop touching Google Drive immediately, because another worker
 * is now writing into the same candidate folder.
 */
export async function heartbeatExternalSync(sessionId: string, startedAt: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const result = await db.prepare(`UPDATE interview_external_syncs SET updated_at = ?
    WHERE session_id = ? AND provider = 'google_drive' AND status = 'running' AND started_at = ?`)
    .bind(new Date().toISOString(), sessionId, startedAt).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function claimExternalSync(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const startedAt = new Date().toISOString();
  const result = await db.prepare(`UPDATE interview_external_syncs SET
    status = 'running', started_at = ?, completed_at = NULL, error_code = NULL, updated_at = ?
    WHERE session_id = ? AND provider = 'google_drive' AND status = 'pending'`)
    .bind(startedAt, startedAt, sessionId).run();
  return Number(result.meta?.changes ?? 0) === 1 ? startedAt : null;
}

export async function completeExternalSync(input: {
  sessionId: string;
  startedAt: string;
  folderId: string;
  folderUrl: string;
  manifest: Record<string, unknown>;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE interview_external_syncs SET
      status = CASE WHEN requested_at > ? THEN 'pending' ELSE 'completed' END,
      completed_at = CASE WHEN requested_at > ? THEN NULL ELSE ? END,
      folder_id = ?, folder_url = ?, manifest_json = ?, error_code = NULL, updated_at = ?
      WHERE session_id = ? AND provider = 'google_drive' AND started_at = ?`)
      .bind(
        input.startedAt,
        input.startedAt,
        now,
        input.folderId,
        input.folderUrl,
        JSON.stringify(input.manifest),
        now,
        input.sessionId,
        input.startedAt,
      ),
    db.prepare(`INSERT INTO interview_audit_events (
      id, session_id, event_type, actor_type, detail_json
    ) SELECT ?, ?, 'google_drive_sync_completed', 'system', ?
      WHERE EXISTS (
        SELECT 1 FROM interview_external_syncs
        WHERE session_id = ? AND provider = 'google_drive' AND started_at = ?
      )`)
      .bind(
        crypto.randomUUID(),
        input.sessionId,
        JSON.stringify({ folderId: input.folderId }),
        input.sessionId,
        input.startedAt,
      ),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error("GOOGLE_DRIVE_SYNC_CLAIM_LOST");
  }
  return (await getExternalSyncStatus(input.sessionId))?.status === "pending";
}

export async function failExternalSync(input: {
  sessionId: string;
  startedAt: string;
  errorCode: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  // The UPDATE is fenced on started_at, so a worker whose claim was already
  // reclaimed changes nothing. Its audit row must be suppressed the same way, or
  // the log would report a failure against a sync another worker now owns.
  await db.batch([
    db.prepare(`UPDATE interview_external_syncs SET
      status = 'failed', error_code = ?, updated_at = ?
      WHERE session_id = ? AND provider = 'google_drive' AND started_at = ?`)
      .bind(input.errorCode.slice(0, 120), now, input.sessionId, input.startedAt),
    db.prepare(`INSERT INTO interview_audit_events (
      id, session_id, event_type, actor_type, detail_json
    ) SELECT ?, ?, 'google_drive_sync_failed', 'system', ?
      WHERE EXISTS (
        SELECT 1 FROM interview_external_syncs
        WHERE session_id = ? AND provider = 'google_drive' AND started_at = ?
      )`)
      .bind(
        crypto.randomUUID(),
        input.sessionId,
        JSON.stringify({ errorCode: input.errorCode.slice(0, 120) }),
        input.sessionId,
        input.startedAt,
      ),
  ]);
}

export async function getInterviewArchiveSource(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const session = await db.prepare(`SELECT
    id, candidate_name, employment, preferred_location, consent_version, consented_at,
    status, recording_status, transcript_json, evaluation_json, summary,
    retention_until, completed_at, created_at, updated_at
    FROM interview_sessions WHERE id = ? LIMIT 1`)
    .bind(sessionId).first<Record<string, unknown>>();
  if (!session) return null;
  const reviews = await db.prepare(`SELECT reviewer_name, video_scores_json, overall_note, updated_at
    FROM interview_human_reviews WHERE session_id = ? ORDER BY reviewer_name`)
    .bind(sessionId).all<Record<string, unknown>>();
  const events = await db.prepare(`SELECT event_type, detail_json, created_at
    FROM interview_audit_events WHERE session_id = ? ORDER BY created_at`)
    .bind(sessionId).all<Record<string, unknown>>();
  const artifact = await db.prepare(`SELECT object_key, content_type, byte_size
    FROM interview_artifacts WHERE session_id = ? AND kind = 'recording'
    ORDER BY created_at DESC LIMIT 1`)
    .bind(sessionId).first<{ object_key: string; content_type: string; byte_size: number }>();
  const recordingBucket = bindings().RECORDINGS;
  const storedRecording = artifact && recordingBucket
    ? await loadRecordingObject(recordingBucket, artifact.object_key)
    : null;
  return {
    sessionId,
    candidateName: String(session.candidate_name ?? ""),
    employment: String(session.employment ?? ""),
    preferredLocation: String(session.preferred_location ?? ""),
    consentVersion: String(session.consent_version ?? ""),
    consentedAt: String(session.consented_at ?? ""),
    status: String(session.status ?? ""),
    recordingStatus: String(session.recording_status ?? ""),
    transcript: parseJson<TranscriptTurn[]>(session.transcript_json, []),
    evaluation: parseJson<InterviewEvaluation | null>(session.evaluation_json, null),
    summary: String(session.summary ?? ""),
    retentionPolicy: String(session.retention_until ?? ""),
    completedAt: typeof session.completed_at === "string" ? session.completed_at : null,
    createdAt: String(session.created_at ?? ""),
    updatedAt: String(session.updated_at ?? ""),
    humanReviews: (reviews.results ?? []).map((review) => ({
      reviewerName: String(review.reviewer_name ?? ""),
      videoScores: parseJson<VideoReviewScore[]>(review.video_scores_json, []),
      overallNote: String(review.overall_note ?? ""),
      updatedAt: String(review.updated_at ?? ""),
    })),
    auditEvents: (events.results ?? []).map((event) => ({
      type: String(event.event_type ?? ""),
      detail: parseJson<Record<string, unknown>>(event.detail_json, {}),
      createdAt: String(event.created_at ?? ""),
    })),
    recording: artifact && storedRecording ? {
      objectKey: artifact.object_key,
      contentType: artifact.content_type,
      byteSize: artifact.byte_size,
      body: storedRecording.body,
      etag: storedRecording.etag,
    } : null,
  };
}

export async function getInterviewReview(sessionId: string, reviewer: AuthorizedReviewer) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const session = await db.prepare(`SELECT
    id, candidate_name, employment, preferred_location, status, recording_status,
    transcript_json, evaluation_json, summary, retention_until, completed_at, created_at, updated_at
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
      'connection_failed', 'candidate_requested_stop', 'time_limit_reached',
      'reasonable_accommodation_text_selected'
    ) ORDER BY created_at`)
    .bind(sessionId)
    .all<Record<string, unknown>>();
  const driveSync = await getExternalSyncStatus(sessionId);
  const manifestFiles = driveSync?.manifest?.files;
  const archivedArtifactCount = manifestFiles && typeof manifestFiles === "object" && !Array.isArray(manifestFiles)
    ? Object.keys(manifestFiles).length
    : 0;
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
    retentionUntil: session.retention_until,
    createdAt: session.created_at,
    reviewPolicy: "authorized_staff",
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
    driveSync: driveSync ? {
      ...driveSync,
      recordingIncluded: driveSync.manifest?.recordingIncluded === true,
      archivedArtifactCount,
    } : null,
  };
}

export type InterviewListItem = {
  sessionId: string;
  candidateName: string;
  employment: string;
  location: string;
  status: string;
  recordingStatus: string;
  createdAt: string;
  completedAt: string | null;
  retentionUntil: string;
  driveStatus: string | null;
  driveFolderUrl: string | null;
  driveUpdatedAt: string | null;
};

export async function listInterviewSummaries(
  reviewer: AuthorizedReviewer,
  limit = 50,
  options: { audit?: boolean } = {},
) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = await db.prepare(`SELECT
    s.id, s.candidate_name, s.employment, s.preferred_location,
    s.status, s.recording_status, s.created_at, s.completed_at, s.retention_until,
    d.status AS drive_status, d.folder_url AS drive_folder_url, d.updated_at AS drive_updated_at
    FROM interview_sessions AS s
    LEFT JOIN interview_external_syncs AS d
      ON d.session_id = s.id AND d.provider = 'google_drive'
    ORDER BY s.created_at DESC
    LIMIT ?`)
    .bind(safeLimit)
    .all<Record<string, unknown>>();
  const items: InterviewListItem[] = (rows.results ?? []).map((row) => ({
    sessionId: String(row.id ?? ""),
    candidateName: String(row.candidate_name ?? ""),
    employment: String(row.employment ?? ""),
    location: String(row.preferred_location ?? ""),
    status: String(row.status ?? ""),
    recordingStatus: String(row.recording_status ?? ""),
    createdAt: String(row.created_at ?? ""),
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    retentionUntil: String(row.retention_until ?? ""),
    driveStatus: typeof row.drive_status === "string" ? row.drive_status : null,
    driveFolderUrl: typeof row.drive_folder_url === "string" ? row.drive_folder_url : null,
    driveUpdatedAt: typeof row.drive_updated_at === "string" ? row.drive_updated_at : null,
  }));
  if (options.audit !== false) {
    await db.prepare(`INSERT INTO interview_staff_audit_events (
      id, reviewer_name, event_type, detail_json
    ) VALUES (?, ?, 'interview_list_opened', ?)`)
      .bind(crypto.randomUUID(), reviewer, JSON.stringify({ resultCount: items.length, limit: safeLimit }))
      .run();
  }
  return items;
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
  audioCoverage: "both" | "candidate-only" | "unverified";
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
      retentionUntil: input.session.retention_until,
      audioCoverage: input.audioCoverage,
    },
  });
  await recordRecordingArtifact({
    db,
    session: input.session,
    objectKey,
    contentType: input.contentType,
    byteSize: input.byteSize,
    etag: object.etag,
    audioCoverage: input.audioCoverage,
    uploadMode: "single",
  });
  return { objectKey, etag: object.etag };
}

async function recordRecordingArtifact(input: {
  db: D1Database;
  session: InterviewSessionRecord;
  objectKey: string;
  contentType: string;
  byteSize: number;
  etag: string | undefined;
  audioCoverage: "both" | "candidate-only" | "unverified";
  uploadMode: "single" | "resumable-parts";
}) {
  const now = new Date().toISOString();
  const recordArtifact = () => input.db.batch([
    input.db.prepare(`INSERT INTO interview_artifacts (
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
        input.objectKey,
        input.contentType,
        input.byteSize,
        input.etag ?? null,
        input.session.retention_until,
      ),
    input.db.prepare("UPDATE interview_sessions SET recording_status = 'stored', updated_at = ? WHERE id = ?")
      .bind(now, input.session.id),
    input.db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'recording_stored', 'system', ?)")
      .bind(crypto.randomUUID(), input.session.id, JSON.stringify({
        byteSize: input.byteSize,
        contentType: input.contentType,
        audioCoverage: input.audioCoverage,
        uploadMode: input.uploadMode,
      })),
  ]);
  // The recording is already durably stored in R2 at this point (objectKey is
  // deterministic and future re-uploads overwrite it). A transient D1 failure here
  // would otherwise leave that object with no interview_artifacts row, making it
  // undiscoverable to staff even though nothing was actually lost. Retry briefly
  // before surfacing the failure to the candidate.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await recordArtifact();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

type RecordingUploadState = {
  version: 1;
  sessionId: string;
  contentType: string;
  byteSize: number;
  partSize: number;
  totalParts: number;
  audioCoverage: "both" | "candidate-only" | "unverified";
  retentionUntil: string;
  createdAt: string;
};

type RecordingPartManifest = {
  version: 1;
  contentType: string;
  byteSize: number;
  audioCoverage: "both" | "candidate-only" | "unverified";
  parts: Array<{ key: string; byteSize: number }>;
};

function recordingUploadStateKey(sessionId: string) {
  return `interviews/${sessionId}/recording-parts/upload.json`;
}

function recordingPartKey(sessionId: string, index: number) {
  return `interviews/${sessionId}/recording-parts/part-${String(index).padStart(3, "0")}`;
}

async function r2ObjectText(object: R2ObjectBody) {
  return await new Response(object.body).text();
}

function parseRecordingUploadState(value: string): RecordingUploadState {
  const parsed = JSON.parse(value) as Partial<RecordingUploadState>;
  if (
    parsed.version !== 1 ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.contentType !== "string" ||
    typeof parsed.byteSize !== "number" ||
    typeof parsed.partSize !== "number" ||
    typeof parsed.totalParts !== "number" ||
    !["both", "candidate-only", "unverified"].includes(parsed.audioCoverage ?? "") ||
    typeof parsed.retentionUntil !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("INTERVIEW_RECORDING_UPLOAD_STATE_INVALID");
  }
  return parsed as RecordingUploadState;
}

export function validateRecordingUploadShape(input: {
  contentType: string;
  byteSize: number;
  partSize: number;
  totalParts: number;
  audioCoverage: string;
}) {
  const contentType = input.contentType.split(";")[0].toLowerCase();
  if (!["video/webm", "audio/webm", "video/mp4", "audio/mp4"].includes(contentType)) return null;
  if (!Number.isInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > MAX_RECORDING_BYTES) return null;
  if (!Number.isInteger(input.partSize) || input.partSize < 256 * 1024 || input.partSize > 8 * 1024 * 1024) return null;
  if (!Number.isInteger(input.totalParts) || input.totalParts <= 0 || input.totalParts > MAX_RECORDING_PARTS) return null;
  if (Math.ceil(input.byteSize / input.partSize) !== input.totalParts) return null;
  if (!["both", "candidate-only", "unverified"].includes(input.audioCoverage)) return null;
  return {
    contentType,
    byteSize: input.byteSize,
    partSize: input.partSize,
    totalParts: input.totalParts,
    audioCoverage: input.audioCoverage as RecordingUploadState["audioCoverage"],
  };
}

export async function beginResumableInterviewRecording(input: {
  session: InterviewSessionRecord;
  contentType: string;
  byteSize: number;
  partSize: number;
  totalParts: number;
  audioCoverage: RecordingUploadState["audioCoverage"];
}) {
  const bucket = bindings().RECORDINGS;
  if (!bucket) throw new Error("INTERVIEW_RECORDING_STORAGE_UNAVAILABLE");
  const stateKey = recordingUploadStateKey(input.session.id);
  const existingObject = await bucket.get(stateKey);
  let state: RecordingUploadState;
  if (existingObject) {
    state = parseRecordingUploadState(await r2ObjectText(existingObject));
    if (
      state.sessionId !== input.session.id ||
      state.contentType !== input.contentType ||
      state.byteSize !== input.byteSize ||
      state.partSize !== input.partSize ||
      state.totalParts !== input.totalParts ||
      state.audioCoverage !== input.audioCoverage
    ) {
      throw new Error("INTERVIEW_RECORDING_UPLOAD_CONFLICT");
    }
  } else {
    const claimed = await claimInterviewRecordingUpload(input.session.id);
    if (!claimed) {
      if (input.session.recording_status === "stored") return { stored: true, uploadedParts: [] as number[] };
      // A previous start request may have claimed the D1 row and then lost its
      // response (or failed before the R2 state write). The same candidate token
      // is allowed to recreate the deterministic state immediately; concurrent
      // attempts write identical metadata and parts are independently idempotent.
      if (input.session.recording_status !== "uploading") {
        throw new Error("INTERVIEW_RECORDING_UPLOAD_BUSY");
      }
    }
    state = {
      version: 1,
      sessionId: input.session.id,
      contentType: input.contentType,
      byteSize: input.byteSize,
      partSize: input.partSize,
      totalParts: input.totalParts,
      audioCoverage: input.audioCoverage,
      retentionUntil: input.session.retention_until,
      createdAt: new Date().toISOString(),
    };
    await bucket.put(stateKey, JSON.stringify(state), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sessionId: input.session.id, retentionUntil: input.session.retention_until },
    });
  }
  const uploadedParts: number[] = [];
  for (let index = 0; index < state.totalParts; index += 1) {
    const part = await bucket.get(recordingPartKey(state.sessionId, index));
    if (part?.customMetadata?.byteSize) uploadedParts.push(index);
  }
  return { stored: false, uploadedParts };
}

export async function saveResumableInterviewRecordingPart(input: {
  sessionId: string;
  index: number;
  byteSize: number;
  body: ReadableStream;
}) {
  const bucket = bindings().RECORDINGS;
  if (!bucket) throw new Error("INTERVIEW_RECORDING_STORAGE_UNAVAILABLE");
  const stateObject = await bucket.get(recordingUploadStateKey(input.sessionId));
  if (!stateObject) throw new Error("INTERVIEW_RECORDING_UPLOAD_NOT_STARTED");
  const state = parseRecordingUploadState(await r2ObjectText(stateObject));
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= state.totalParts) {
    throw new Error("INTERVIEW_RECORDING_PART_INVALID");
  }
  const expectedSize = input.index === state.totalParts - 1
    ? state.byteSize - state.partSize * (state.totalParts - 1)
    : state.partSize;
  if (input.byteSize !== expectedSize) throw new Error("INTERVIEW_RECORDING_PART_SIZE_INVALID");
  const key = recordingPartKey(input.sessionId, input.index);
  const existing = await bucket.get(key);
  if (Number(existing?.customMetadata?.byteSize ?? 0) === input.byteSize) return { stored: true, duplicate: true };
  await bucket.put(key, input.body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: {
      sessionId: input.sessionId,
      byteSize: String(input.byteSize),
      retentionUntil: state.retentionUntil,
    },
  });
  return { stored: true, duplicate: false };
}

export async function completeResumableInterviewRecording(session: InterviewSessionRecord) {
  const bucket = bindings().RECORDINGS;
  const db = database();
  if (!bucket || !db) throw new Error("INTERVIEW_RECORDING_STORAGE_UNAVAILABLE");
  const stateObject = await bucket.get(recordingUploadStateKey(session.id));
  if (!stateObject) throw new Error("INTERVIEW_RECORDING_UPLOAD_NOT_STARTED");
  const state = parseRecordingUploadState(await r2ObjectText(stateObject));
  const parts: RecordingPartManifest["parts"] = [];
  for (let index = 0; index < state.totalParts; index += 1) {
    const key = recordingPartKey(session.id, index);
    const part = await bucket.get(key);
    const byteSize = Number(part?.customMetadata?.byteSize ?? 0);
    const expectedSize = index === state.totalParts - 1
      ? state.byteSize - state.partSize * (state.totalParts - 1)
      : state.partSize;
    if (!part || byteSize !== expectedSize) throw new Error("INTERVIEW_RECORDING_PART_MISSING");
    parts.push({ key, byteSize });
  }
  if (parts.reduce((total, part) => total + part.byteSize, 0) !== state.byteSize) {
    throw new Error("INTERVIEW_RECORDING_SIZE_MISMATCH");
  }
  const manifest: RecordingPartManifest = {
    version: 1,
    contentType: state.contentType,
    byteSize: state.byteSize,
    audioCoverage: state.audioCoverage,
    parts,
  };
  const objectKey = `interviews/${session.id}/recording.manifest.json`;
  const object = await bucket.put(objectKey, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      sessionId: session.id,
      retentionUntil: session.retention_until,
      audioCoverage: state.audioCoverage,
      recordingContentType: state.contentType,
    },
  });
  await recordRecordingArtifact({
    db,
    session,
    objectKey,
    contentType: state.contentType,
    byteSize: state.byteSize,
    etag: object.etag,
    audioCoverage: state.audioCoverage,
    uploadMode: "resumable-parts",
  });
  return { stored: true, byteSize: state.byteSize, totalParts: state.totalParts };
}

async function loadRecordingObject(bucket: R2Bucket, objectKey: string) {
  const object = await bucket.get(objectKey);
  if (!object) return null;
  if (!objectKey.endsWith(".manifest.json")) {
    return { body: object.body, etag: object.etag, customMetadata: object.customMetadata ?? {} };
  }
  const manifest = JSON.parse(await r2ObjectText(object)) as RecordingPartManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.parts) || manifest.parts.length === 0) return null;
  let partIndex = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (partIndex < manifest.parts.length) {
        if (!reader) {
          const part = await bucket.get(manifest.parts[partIndex].key);
          if (!part) {
            controller.error(new Error("INTERVIEW_RECORDING_PART_MISSING"));
            return;
          }
          reader = part.body.getReader();
        }
        const next = await reader.read();
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        reader.releaseLock();
        reader = null;
        partIndex += 1;
      }
      controller.close();
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
  return { body, etag: object.etag, customMetadata: object.customMetadata ?? {} };
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
  const object = await loadRecordingObject(bucket, artifact.object_key);
  if (!object) return null;
  await db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'recording_opened', 'recruiter', ?)")
    .bind(crypto.randomUUID(), sessionId, JSON.stringify({ reviewer })).run();
  return {
    body: object.body,
    contentType: artifact.content_type,
    byteSize: artifact.byte_size,
    etag: object.etag,
    audioCoverage: object.customMetadata?.audioCoverage ?? "unverified",
  };
}
