import {
  VIDEO_REVIEW_DIMENSIONS,
  type InterviewEvaluation,
  type TranscriptTurn,
} from "@/lib/interview";
import { hasVerifiedCandidateTranscript } from "@/lib/interview-transcript-verification";
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
// Automatic recovery must never give up while the candidate can still resume
// with their original token. After expiry, repeated missing-part observations
// may terminalize the automatic loop; a sparse scheduler still has a finite
// six-hour absolute deadline from the durable completion/transcript seal.
const RECORDING_RECOVERY_EXPIRY_GRACE_MS = 30 * 60 * 1_000;
const RECORDING_RECOVERY_ABSOLUTE_DEADLINE_MS = 6 * 60 * 60 * 1_000;
const RECORDING_RECOVERY_MISSING_ATTEMPT_LIMIT = 12;
const RECORDING_RECOVERY_MISSING_EVENT = "recording_recovery_part_missing";
const RECORDING_RECOVERY_MANUAL_ATTENTION_EVENT = "recording_recovery_manual_attention";

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

export async function getInterviewSessionState(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  return await db.prepare(`SELECT id, status, recording_status, transcript_json
    FROM interview_sessions WHERE id = ? LIMIT 1`)
    .bind(sessionId)
    .first<{ id: string; status: string; recording_status: string; transcript_json: string | null }>();
}

export type InterviewRecoveryTechnicalStatus = {
  session: {
    status: string;
    recordingStatus: string;
  };
  sourceTranscriptVerified: boolean;
  recording: {
    byteSize: number | null;
  };
  driveSync: {
    status: string | null;
    manifest: {
      present: boolean;
      recordingIncluded: boolean | null;
      transcriptAvailable: boolean | null;
      transcriptKind: "actual_transcript" | "unknown" | null;
    };
  };
  driveStep: {
    phase: "uploading" | "finalizing" | null;
    committedOffset: number | null;
    totalBytes: number | null;
    lastError: string | null;
  };
};

type InterviewRecoveryTechnicalRow = {
  session_status: string;
  recording_status: string;
  transcript_json: string | null;
  candidate_transcription_failed: number;
  recording_byte_size: number | null;
  drive_status: string | null;
  drive_manifest_json: string | null;
  drive_error_code: string | null;
  drive_step_phase: string | null;
  drive_committed_offset: number | null;
  drive_total_bytes: number | null;
};

function recoveryTranscriptForVerification(value: unknown): TranscriptTurn[] {
  const decoded = parseJson<unknown>(value, null);
  if (!Array.isArray(decoded)) return [];
  return decoded.slice(0, 300).flatMap((item): TranscriptTurn[] => {
    if (!item || typeof item !== "object") return [];
    const turn = item as Partial<TranscriptTurn>;
    if (
      typeof turn.id !== "string" ||
      (turn.speaker !== "candidate" && turn.speaker !== "interviewer") ||
      typeof turn.text !== "string"
    ) return [];
    return [{
      id: turn.id.slice(0, 120),
      speaker: turn.speaker,
      text: turn.text.replace(/\0/g, "").trim().slice(0, 5_000),
      createdAt: typeof turn.createdAt === "string" ? turn.createdAt.slice(0, 40) : "",
    }];
  });
}

function recoveryTechnicalLastError(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("GOOGLE_DRIVE_CONFIGURATION_MISSING")) {
    return "GOOGLE_DRIVE_CONFIGURATION_MISSING";
  }
  if (/^GOOGLE_DRIVE_(?:API|EXPORT|RESUMABLE_INIT|RESUMABLE_UPLOAD)_[1-5]\d{2}$/.test(value)) {
    return value;
  }
  const knownCodes = new Set([
    "GOOGLE_DRIVE_ACCOUNT_LOOKUP_FAILED",
    "GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH",
    "GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH",
    "GOOGLE_DRIVE_ENCRYPTION_SECRET_MISSING",
    "GOOGLE_DRIVE_MANAGED_ROOT_CREATE_FAILED",
    "GOOGLE_DRIVE_MANAGED_ROOT_LOOKUP_FAILED",
    "GOOGLE_DRIVE_OAUTH_CLIENT_MISSING",
    "GOOGLE_DRIVE_OAUTH_NOT_CONNECTED",
    "GOOGLE_DRIVE_RECORDING_SIZE_MISMATCH",
    "GOOGLE_DRIVE_RECORDING_SOURCE_SIZE_MISMATCH",
    "GOOGLE_DRIVE_REFRESH_TOKEN_DECRYPT_FAILED",
    "GOOGLE_DRIVE_REFRESH_TOKEN_INVALID",
    "GOOGLE_DRIVE_REFRESH_TOKEN_READBACK_MISMATCH",
    "GOOGLE_DRIVE_RESUMABLE_RANGE_MISMATCH",
    "GOOGLE_DRIVE_RESUMABLE_UPLOAD_INCOMPLETE",
    "GOOGLE_DRIVE_ROOT_ID_INVALID",
    "GOOGLE_DRIVE_ROOT_LOOKUP_FAILED",
    "GOOGLE_DRIVE_ROOT_MISMATCH",
    "GOOGLE_DRIVE_ROOT_NOT_WRITABLE",
    "GOOGLE_DRIVE_ROOT_READBACK_MISMATCH",
    "GOOGLE_DRIVE_SYNC_ALREADY_RUNNING",
    "GOOGLE_DRIVE_SYNC_CLAIM_LOST",
    "GOOGLE_DRIVE_SYNC_DEFERRED",
    "GOOGLE_DRIVE_SYNC_FAILED",
    "GOOGLE_DRIVE_TOKEN_REFRESH_RECONNECT_REQUIRED",
    "GOOGLE_DRIVE_TOKEN_REFRESH_TRANSIENT",
    "GOOGLE_DRIVE_UPLOAD_CAPABILITY_INVALID",
    "GOOGLE_DRIVE_UPLOAD_STEP_CONTEXT_INVALID",
    "GOOGLE_DRIVE_UPLOAD_STEP_LEASE_LOST",
    "GOOGLE_DRIVE_UPLOAD_STEP_READBACK_MISMATCH",
    "INTERVIEW_DATE_INVALID",
    "INTERVIEW_NOT_FOUND",
    "INTERVIEW_NOT_READY_FOR_DRIVE_SYNC",
    "INTERVIEW_RECORDING_ARTIFACT_MISSING",
    "INTERVIEW_RECORDING_MANIFEST_INVALID",
    "INTERVIEW_RECORDING_NOT_READY_FOR_DRIVE_SYNC",
    "INTERVIEW_RECORDING_PART_MISSING",
    "INTERVIEW_RECORDING_RANGE_INVALID",
    "INTERVIEW_RECORDING_RANGE_MISMATCH",
    "INTERVIEW_RECORDING_SIZE_MISMATCH",
    "INTERVIEW_RECORDING_STORAGE_UNAVAILABLE",
    "INTERVIEW_TRANSCRIPT_NOT_READY_FOR_DRIVE_SYNC",
  ]);
  if (knownCodes.has(value)) return value;
  return "GOOGLE_DRIVE_SYNC_FAILED";
}

function safeNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Returns a fixed, read-only technical projection for machine diagnostics.
 * The query deliberately does not select candidate identity, transcript text in
 * the response, Drive folder/file identifiers, URLs, upload capabilities, or
 * secrets. Persisted free-form errors are reduced to known technical codes.
 */
export async function getInterviewRecoveryTechnicalStatus(
  sessionId: string,
): Promise<InterviewRecoveryTechnicalStatus | null> {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const row = await db.prepare(`SELECT
      s.status AS session_status,
      s.recording_status,
      s.transcript_json,
      EXISTS (
        SELECT 1 FROM interview_audit_events AS ta
        WHERE ta.session_id = s.id
          AND ta.event_type = 'transcription_failed'
          AND CASE WHEN json_valid(ta.detail_json)
            THEN json_extract(ta.detail_json, '$.code') ELSE NULL END = 'TRANSCRIPTION_FAILED'
      ) AS candidate_transcription_failed,
      (SELECT a.byte_size FROM interview_artifacts AS a
        WHERE a.session_id = s.id AND a.kind = 'recording'
        ORDER BY a.created_at DESC LIMIT 1) AS recording_byte_size,
      d.status AS drive_status,
      d.manifest_json AS drive_manifest_json,
      d.error_code AS drive_error_code,
      u.phase AS drive_step_phase,
      u.committed_offset AS drive_committed_offset,
      u.total_bytes AS drive_total_bytes
    FROM interview_sessions AS s
    LEFT JOIN interview_external_syncs AS d
      ON d.session_id = s.id AND d.provider = 'google_drive'
    LEFT JOIN interview_drive_upload_steps AS u ON u.session_id = s.id
    WHERE s.id = ? LIMIT 1`)
    .bind(sessionId)
    .first<InterviewRecoveryTechnicalRow>();
  if (!row) return null;

  const transcript = recoveryTranscriptForVerification(row.transcript_json);
  const sourceTranscriptVerified = hasVerifiedCandidateTranscript(
    transcript,
    Number(row.candidate_transcription_failed) === 1
      ? [{ type: "transcription_failed", detail: { code: "TRANSCRIPTION_FAILED" } }]
      : [],
  );
  const parsedManifest = parseJson<unknown>(row.drive_manifest_json, null);
  const manifest = parsedManifest && typeof parsedManifest === "object" && !Array.isArray(parsedManifest)
    ? parsedManifest as Record<string, unknown>
    : null;
  const phase = row.drive_step_phase === "uploading" || row.drive_step_phase === "finalizing"
    ? row.drive_step_phase
    : null;
  const committedOffset = phase ? safeNonNegativeInteger(row.drive_committed_offset) : null;
  const totalBytes = phase ? safeNonNegativeInteger(row.drive_total_bytes) : null;
  const sessionStatuses = new Set([
    "created", "in_progress", "evaluation_pending", "evaluation_processing", "completed",
  ]);
  const recordingStatuses = new Set([
    "not_started", "uploading", "stored", "failed", "not_applicable",
  ]);
  const driveStatuses = new Set(["pending", "running", "completed", "failed"]);

  return {
    session: {
      status: sessionStatuses.has(row.session_status) ? row.session_status : "unknown",
      recordingStatus: recordingStatuses.has(row.recording_status) ? row.recording_status : "unknown",
    },
    sourceTranscriptVerified,
    recording: {
      byteSize: safeNonNegativeInteger(row.recording_byte_size),
    },
    driveSync: {
      status: row.drive_status && driveStatuses.has(row.drive_status) ? row.drive_status : null,
      manifest: {
        present: manifest !== null,
        recordingIncluded: typeof manifest?.recordingIncluded === "boolean"
          ? manifest.recordingIncluded
          : null,
        transcriptAvailable: typeof manifest?.transcriptAvailable === "boolean"
          ? manifest.transcriptAvailable
          : null,
        transcriptKind: manifest?.transcriptKind === "actual_transcript"
          ? "actual_transcript"
          : typeof manifest?.transcriptKind === "string" ? "unknown" : null,
      },
    },
    driveStep: {
      phase,
      committedOffset,
      totalBytes,
      lastError: recoveryTechnicalLastError(row.drive_error_code),
    },
  };
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
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_evaluation_claims (
      session_id TEXT PRIMARY KEY NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
      claim_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_evaluation_claims_started_idx ON interview_evaluation_claims (started_at)"),
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
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_drive_upload_steps (
      session_id TEXT PRIMARY KEY NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      phase TEXT DEFAULT 'uploading' NOT NULL,
      upload_url_ciphertext TEXT NOT NULL,
      upload_url_iv TEXT NOT NULL,
      committed_offset INTEGER DEFAULT 0 NOT NULL,
      total_bytes INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      recording_name TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      folder_url TEXT NOT NULL,
      context_json TEXT NOT NULL,
      recording_file_json TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_drive_upload_steps_lease_idx ON interview_drive_upload_steps (lease_expires_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS interview_drive_hierarchy_nodes (
      node_key TEXT PRIMARY KEY NOT NULL,
      canonical_folder_id TEXT,
      creation_attempted_at TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS interview_drive_hierarchy_nodes_lease_idx ON interview_drive_hierarchy_nodes (lease_expires_at)"),
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

/**
 * Durably fences a cleanly completed realtime voice transcript before the
 * browser begins the much larger recording upload. The audit event is the
 * explicit seal; transcript_json remains the single transcript source used by
 * evaluation and Drive export.
 */
export async function sealVoiceInterviewTranscript(input: {
  sessionId: string;
  transcript: TranscriptTurn[];
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  if (
    input.transcript.length < 1 ||
    input.transcript.length > 300 ||
    !input.transcript.some((turn) =>
      turn.speaker === "candidate" && typeof turn.text === "string" && turn.text.trim().length > 0
    )
  ) {
    throw new Error("VOICE_TRANSCRIPT_SEAL_NOT_READY");
  }
  await ensureSchema(db);
  const transcriptJson = JSON.stringify(input.transcript);
  const transcriptSha256 = await sha256(transcriptJson);
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE interview_sessions SET transcript_json = ?, updated_at = ?
      WHERE id = ?
        AND status IN ('in_progress', 'evaluation_pending', 'evaluation_processing')
        AND (transcript_json IS NULL OR transcript_json = ?)
        AND NOT EXISTS (
          SELECT 1 FROM interview_audit_events
          WHERE session_id = ? AND event_type = 'recorded_fallback_started'
        )
        AND NOT EXISTS (
          SELECT 1 FROM interview_audit_events
          WHERE session_id = ? AND event_type = 'voice_transcript_sealed'
        )`)
      .bind(transcriptJson, now, input.sessionId, transcriptJson, input.sessionId, input.sessionId),
    db.prepare(`INSERT INTO interview_audit_events (
        id, session_id, event_type, actor_type, detail_json
      )
      SELECT ?, s.id, 'voice_transcript_sealed', 'candidate', ?
      FROM interview_sessions s
      WHERE s.id = ?
        AND s.status IN ('in_progress', 'evaluation_pending', 'evaluation_processing')
        AND s.transcript_json = ?
        AND NOT EXISTS (
          SELECT 1 FROM interview_audit_events
          WHERE session_id = s.id AND event_type = 'recorded_fallback_started'
        )
        AND NOT EXISTS (
          SELECT 1 FROM interview_audit_events
          WHERE session_id = s.id AND event_type = 'voice_transcript_sealed'
        )`)
      .bind(
        crypto.randomUUID(),
        JSON.stringify({
          transcriptSha256,
          turnCount: input.transcript.length,
          candidateTurnCount: input.transcript.filter((turn) => turn.speaker === "candidate").length,
        }),
        input.sessionId,
        transcriptJson,
      ),
  ]);
  const state = await db.prepare(`SELECT s.status, s.transcript_json,
      EXISTS (
        SELECT 1 FROM interview_audit_events
        WHERE session_id = s.id AND event_type = 'voice_transcript_sealed'
      ) AS voice_transcript_sealed
    FROM interview_sessions s WHERE s.id = ? LIMIT 1`)
    .bind(input.sessionId)
    .first<{ status: string; transcript_json: string | null; voice_transcript_sealed: number }>();
  if (Number(state?.voice_transcript_sealed ?? 0) === 1) {
    if (state?.transcript_json !== transcriptJson) throw new Error("VOICE_TRANSCRIPT_SEAL_CONFLICT");
    return {
      alreadySealed: Number(results[1]?.meta?.changes ?? 0) !== 1,
      turnCount: input.transcript.length,
    };
  }
  if (state?.transcript_json && state.transcript_json !== transcriptJson) {
    throw new Error("VOICE_TRANSCRIPT_SEAL_CONFLICT");
  }
  throw new Error("VOICE_TRANSCRIPT_SEAL_NOT_READY");
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
    WHERE id = ? AND recording_status IN ('uploading', 'failed')`)
    .bind(new Date().toISOString(), sessionId)
    .run();
}

async function heartbeatInterviewRecordingUpload(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await db.prepare(`UPDATE interview_sessions SET updated_at = ?
    WHERE id = ? AND recording_status IN ('uploading', 'failed')`)
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

export async function markRecordedFallbackStarted(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE interview_sessions SET status = 'in_progress', updated_at = ? WHERE id = ? AND status IN ('created', 'in_progress')")
      .bind(now, sessionId),
    db.prepare(`INSERT INTO interview_audit_events (
        id, session_id, event_type, actor_type, detail_json
      )
      SELECT ?, ?, 'interview_started', 'candidate', '{}'
      WHERE EXISTS (SELECT 1 FROM interview_sessions WHERE id = ?)`)
      .bind(crypto.randomUUID(), sessionId, sessionId),
    db.prepare(`INSERT INTO interview_audit_events (
        id, session_id, event_type, actor_type, detail_json
      )
      SELECT ?, ?, 'recorded_fallback_started', 'candidate', '{}'
      WHERE EXISTS (SELECT 1 FROM interview_sessions WHERE id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM interview_audit_events
          WHERE session_id = ? AND event_type = 'recorded_fallback_started'
        )`)
      .bind(crypto.randomUUID(), sessionId, sessionId, sessionId),
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
 * Returns one durable, stale or released evaluation for the staff recovery loop.
 *
 * The JSON predicate is deliberately part of the query: an empty, malformed,
 * or interviewer-only transcript must never be converted into a completed
 * interview merely because its Worker claim became stale. A released
 * evaluation_pending row is also recoverable after the same delay when the
 * candidate left after a persistence exception. The caller still validates the
 * decoded value and the technical audit trail before the atomic claim below.
 */
export async function findNextStaleInterviewEvaluation() {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const staleBefore = new Date(Date.now() - EVALUATION_CLAIM_STALE_AFTER_MS).toISOString();
  const target = await db.prepare(`SELECT s.id, s.transcript_json
    FROM interview_sessions s
    LEFT JOIN interview_evaluation_claims c ON c.session_id = s.id
    WHERE (
        (s.status = 'evaluation_processing' AND (
          (c.started_at IS NOT NULL AND c.started_at <= ?)
          OR (c.session_id IS NULL AND s.updated_at <= ?)
        ))
        OR (s.status = 'evaluation_pending' AND c.session_id IS NULL AND s.updated_at <= ?)
        OR (
          s.status = 'in_progress'
          AND s.recording_status = 'stored'
          AND c.session_id IS NULL
          AND EXISTS (SELECT 1 FROM interview_audit_events seal
            WHERE seal.session_id = s.id AND seal.event_type = 'voice_transcript_sealed')
        )
      )
      AND s.transcript_json IS NOT NULL
      AND json_valid(s.transcript_json)
      AND json_type(s.transcript_json) = 'array'
      AND EXISTS (
        SELECT 1 FROM json_each(s.transcript_json) AS turn
        WHERE CAST(turn.key AS INTEGER) < 300
          AND CASE WHEN turn.type = 'object'
            THEN json_extract(turn.value, '$.speaker') ELSE NULL END = 'candidate'
          AND CASE WHEN turn.type = 'object'
            THEN json_type(turn.value, '$.id') ELSE NULL END = 'text'
          AND CASE WHEN turn.type = 'object'
            THEN json_type(turn.value, '$.text') ELSE NULL END = 'text'
          AND length(trim(COALESCE(CASE WHEN turn.type = 'object'
            THEN json_extract(turn.value, '$.text') ELSE NULL END, ''))) > 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(s.transcript_json) AS turn
        WHERE CAST(turn.key AS INTEGER) < 300
          AND CASE WHEN turn.type = 'object'
            THEN json_extract(turn.value, '$.speaker') ELSE NULL END = 'candidate'
          AND COALESCE(CASE WHEN turn.type = 'object'
            THEN json_extract(turn.value, '$.id') ELSE NULL END, '') LIKE 'recorded-fallback-answer-%'
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM interview_audit_events AS failure
          WHERE failure.session_id = s.id
            AND failure.event_type = 'transcription_failed'
            AND CASE WHEN json_valid(failure.detail_json)
              THEN json_extract(failure.detail_json, '$.code') ELSE NULL END = 'TRANSCRIPTION_FAILED'
        )
        OR NOT EXISTS (
          SELECT 1 FROM json_each(s.transcript_json) AS turn
          WHERE CAST(turn.key AS INTEGER) < 300
            AND CASE WHEN turn.type = 'object'
              THEN json_extract(turn.value, '$.speaker') ELSE NULL END = 'candidate'
            AND COALESCE(CASE WHEN turn.type = 'object'
              THEN json_extract(turn.value, '$.id') ELSE NULL END, '') NOT LIKE 'recorded-transcribed-answer-%'
        )
      )
    ORDER BY coalesce(c.started_at, s.updated_at), s.id
    LIMIT 1`)
    .bind(staleBefore, staleBefore, staleBefore)
    .first<{ id: string; transcript_json: string }>();
  if (!target) return null;

  const transcript = parseJson<unknown>(target.transcript_json, null);
  if (!Array.isArray(transcript)) return null;
  const validTurns = transcript.slice(0, 300).flatMap((value): TranscriptTurn[] => {
    if (!value || typeof value !== "object") return [];
    const turn = value as Partial<TranscriptTurn>;
    if (
      typeof turn.id !== "string" ||
      (turn.speaker !== "candidate" && turn.speaker !== "interviewer") ||
      typeof turn.text !== "string"
    ) return [];
    const text = turn.text.replace(/\0/g, "").trim().slice(0, 5_000);
    if (!text) return [];
    return [{
      id: turn.id.slice(0, 120),
      speaker: turn.speaker,
      text,
      createdAt: typeof turn.createdAt === "string" ? turn.createdAt.slice(0, 40) : "",
    }];
  });
  const failures = await db.prepare(`SELECT event_type, detail_json
    FROM interview_audit_events
    WHERE session_id = ? AND event_type = 'transcription_failed'`)
    .bind(target.id)
    .all<{ event_type: string; detail_json: string | null }>();
  const auditEvents = (failures.results ?? []).map((event) => ({
    type: event.event_type,
    detail: parseJson<Record<string, unknown>>(event.detail_json, {}),
  }));
  if (!hasVerifiedCandidateTranscript(validTurns, auditEvents)) return null;
  return { sessionId: target.id, transcript: validTurns };
}

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
  const claim = await db.prepare(`INSERT INTO interview_evaluation_claims (
    session_id, claim_id, started_at, created_at, updated_at
  ) SELECT s.id, ?, ?, ?, ?
    FROM interview_sessions s
    LEFT JOIN interview_evaluation_claims current ON current.session_id = s.id
    WHERE s.id = ? AND (
      s.status IN ('in_progress', 'evaluation_pending') OR
      (s.status = 'evaluation_processing' AND (
        (current.started_at IS NOT NULL AND current.started_at <= ?)
        OR (current.session_id IS NULL AND s.updated_at <= ?)
      ))
    )
    ON CONFLICT(session_id) DO UPDATE SET
      claim_id = excluded.claim_id,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at
    WHERE interview_evaluation_claims.started_at <= ?`)
    .bind(claimId, now, now, now, input.sessionId, staleBefore, staleBefore, staleBefore)
    .run();
  if (Number(claim.meta?.changes ?? 0) !== 1) return null;
  const session = await db.prepare(`UPDATE interview_sessions SET
    status = 'evaluation_processing', transcript_json = ?, updated_at = ?
    WHERE id = ?
      AND status IN ('in_progress', 'evaluation_pending', 'evaluation_processing')
      AND EXISTS (SELECT 1 FROM interview_evaluation_claims
        WHERE session_id = ? AND claim_id = ?)
      AND (
        NOT EXISTS (SELECT 1 FROM interview_audit_events
          WHERE session_id = ? AND event_type = 'voice_transcript_sealed')
        OR transcript_json = ?
      )`)
    .bind(
      JSON.stringify(input.transcript),
      now,
      input.sessionId,
      input.sessionId,
      claimId,
      input.sessionId,
      JSON.stringify(input.transcript),
    )
    .run();
  if (Number(session.meta?.changes ?? 0) !== 1) {
    await db.prepare("DELETE FROM interview_evaluation_claims WHERE session_id = ? AND claim_id = ?")
      .bind(input.sessionId, claimId)
      .run();
    return null;
  }
  await db.prepare("INSERT INTO interview_audit_events (id, session_id, event_type, actor_type, detail_json) VALUES (?, ?, 'evaluation_started', 'system', ?)")
    .bind(crypto.randomUUID(), input.sessionId, JSON.stringify({ turnCount: input.transcript.length }))
    .run();
  return claimId;
}

export async function failInterviewEvaluation(sessionId: string, claimId: string) {
  const db = database();
  if (!db) return;
  const released = await db.prepare(
    "DELETE FROM interview_evaluation_claims WHERE session_id = ? AND claim_id = ?",
  )
    .bind(sessionId, claimId)
    .run();
  if (Number(released.meta?.changes ?? 0) !== 1) return;
  await db.prepare(`UPDATE interview_sessions SET
    status = 'evaluation_pending', updated_at = ?
    WHERE id = ? AND status = 'evaluation_processing'
      AND NOT EXISTS (SELECT 1 FROM interview_evaluation_claims WHERE session_id = ?)`)
    .bind(new Date().toISOString(), sessionId, sessionId)
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
      completed_at = ?, updated_at = ? WHERE id = ?
      AND status = 'evaluation_processing'
      AND EXISTS (SELECT 1 FROM interview_evaluation_claims
        WHERE session_id = ? AND claim_id = ?)
      AND (
        NOT EXISTS (SELECT 1 FROM interview_audit_events
          WHERE session_id = ? AND event_type = 'voice_transcript_sealed')
        OR transcript_json = ?
      )`)
      .bind(
        JSON.stringify(input.transcript),
        JSON.stringify(input.evaluation),
        input.evaluation.summary,
        now,
        now,
        input.sessionId,
        input.sessionId,
        input.claimId,
        input.sessionId,
        JSON.stringify(input.transcript),
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
    db.prepare(`DELETE FROM interview_evaluation_claims
      WHERE session_id = ? AND claim_id = ?
        AND EXISTS (SELECT 1 FROM interview_sessions
          WHERE id = ? AND completed_at = ?)`)
      .bind(input.sessionId, input.claimId, input.sessionId, now),
  ]);
  return Number((results[0] as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

export async function recordCandidateEvent(input: {
  sessionId: string;
  eventType: CandidateEventType;
  detail?: Record<string, string | number | boolean>;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  // Seven independently capped candidate event types can consume at most 112
  // rows. Keep a defensive session ceiling above that natural maximum so one
  // event type can never starve another type's reserved capacity.
  const totalLimit = 128;
  const typeLimit = 16;
  const result = await db.prepare(`INSERT INTO interview_audit_events (
      id, session_id, event_type, actor_type, detail_json
    )
    SELECT ?, ?, ?, 'candidate', ?
    WHERE EXISTS (
      SELECT 1 FROM interview_sessions session
      WHERE session.id = ?
        AND session.status IN ('created', 'in_progress', 'evaluation_pending', 'evaluation_processing', 'completed')
        AND (
          ? <> 'transcription_failed'
          OR (
            session.status IN ('created', 'in_progress')
            AND NOT EXISTS (
              SELECT 1 FROM interview_audit_events sealed
              WHERE sealed.session_id = session.id AND sealed.event_type = 'voice_transcript_sealed'
            )
          )
        )
    )
      AND (SELECT COUNT(*) FROM interview_audit_events
        WHERE session_id = ? AND actor_type = 'candidate'
          AND event_type IN (
            'audio_playback_blocked', 'transcription_failed', 'recording_unavailable', 'connection_failed',
            'candidate_requested_stop', 'time_limit_reached',
            'reasonable_accommodation_text_selected'
          )) < ?
      AND (SELECT COUNT(*) FROM interview_audit_events
        WHERE session_id = ? AND actor_type = 'candidate' AND event_type = ?) < ?`)
    .bind(
    crypto.randomUUID(),
    input.sessionId,
    input.eventType,
    JSON.stringify(input.detail ?? {}),
    input.sessionId,
    input.eventType,
    input.sessionId,
    totalLimit,
    input.sessionId,
    input.eventType,
    typeLimit,
  ).run();
  if (Number(result.meta?.changes ?? 0) === 1) return "stored" as const;

  const state = await db.prepare(`SELECT status,
      (SELECT COUNT(*) FROM interview_audit_events
        WHERE session_id = ? AND actor_type = 'candidate'
          AND event_type IN (
            'audio_playback_blocked', 'transcription_failed', 'recording_unavailable', 'connection_failed',
            'candidate_requested_stop', 'time_limit_reached',
            'reasonable_accommodation_text_selected'
          )) AS candidate_event_count,
      (SELECT COUNT(*) FROM interview_audit_events
        WHERE session_id = ? AND actor_type = 'candidate' AND event_type = ?) AS candidate_event_type_count
      ,(SELECT COUNT(*) FROM interview_audit_events
        WHERE session_id = ? AND event_type = 'voice_transcript_sealed') AS voice_transcript_sealed
    FROM interview_sessions WHERE id = ? LIMIT 1`)
    .bind(input.sessionId, input.sessionId, input.eventType, input.sessionId, input.sessionId)
    .first<{
      status: string;
      candidate_event_count: number;
      candidate_event_type_count: number;
      voice_transcript_sealed: number;
    }>();
  const openStatuses = ["created", "in_progress", "evaluation_pending", "evaluation_processing", "completed"];
  const harmfulEventClosed = input.eventType === "transcription_failed" && (
    !state || !["created", "in_progress"].includes(state.status) || Number(state.voice_transcript_sealed) > 0
  );
  if (!state || !openStatuses.includes(state.status) || harmfulEventClosed) return "closed" as const;
  return "capped" as const;
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

const BACKGROUND_DRIVE_FAILED_RETRY_MS = 10 * 60 * 1_000;
const BACKGROUND_DRIVE_PENDING_RETRY_MS = 5 * 60 * 1_000;

/**
 * Finds one archive that can be advanced by a server-side scheduled event.
 *
 * The query is deliberately global rather than derived from the staff inbox,
 * so records older than one UI page cannot become invisible to recovery. It
 * returns only an opaque session ID; candidate identity and transcript text are
 * never logged by the caller. `stepInterviewToGoogleDrive` supplies the actual
 * external-sync claim and upload-step lease CAS fences.
 */
export async function findNextInterviewDriveRecoverySession() {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const now = Date.now();
  const failedBefore = new Date(now - BACKGROUND_DRIVE_FAILED_RETRY_MS).toISOString();
  const pendingBefore = new Date(now - BACKGROUND_DRIVE_PENDING_RETRY_MS).toISOString();
  const candidates = await db.prepare(`SELECT
      s.id, s.transcript_json,
      EXISTS (
        SELECT 1 FROM interview_audit_events AS ta
        WHERE ta.session_id = s.id
          AND ta.event_type = 'transcription_failed'
          AND CASE WHEN json_valid(ta.detail_json)
            THEN json_extract(ta.detail_json, '$.code') ELSE NULL END = 'TRANSCRIPTION_FAILED'
      ) AS candidate_transcription_failed
    FROM interview_sessions AS s
    LEFT JOIN interview_external_syncs AS d
      ON d.session_id = s.id AND d.provider = 'google_drive'
    WHERE s.status = 'completed'
      AND s.recording_status IN ('stored', 'not_applicable')
      AND s.transcript_json IS NOT NULL
      AND json_valid(s.transcript_json)
      AND json_type(s.transcript_json) = 'array'
      AND EXISTS (
        SELECT 1 FROM json_each(s.transcript_json) AS turn
        WHERE CAST(turn.key AS INTEGER) < 300
          AND CASE WHEN turn.type = 'object'
            THEN json_extract(turn.value, '$.speaker') ELSE NULL END = 'candidate'
          AND CASE WHEN turn.type = 'object'
            THEN json_type(turn.value, '$.id') ELSE NULL END = 'text'
          AND CASE WHEN turn.type = 'object'
            THEN json_type(turn.value, '$.text') ELSE NULL END = 'text'
          AND length(trim(COALESCE(CASE WHEN turn.type = 'object'
            THEN json_extract(turn.value, '$.text') ELSE NULL END, ''))) > 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(s.transcript_json) AS turn
        WHERE CAST(turn.key AS INTEGER) < 300
          AND CASE WHEN turn.type = 'object'
            THEN json_extract(turn.value, '$.speaker') ELSE NULL END = 'candidate'
          AND CASE WHEN turn.type = 'object'
            THEN json_type(turn.value, '$.id') ELSE NULL END = 'text'
          AND CASE WHEN turn.type = 'object'
            THEN json_type(turn.value, '$.text') ELSE NULL END = 'text'
          AND COALESCE(CASE WHEN turn.type = 'object'
            THEN json_extract(turn.value, '$.id') ELSE NULL END, '') LIKE 'recorded-fallback-answer-%'
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM interview_audit_events AS failure
          WHERE failure.session_id = s.id
            AND failure.event_type = 'transcription_failed'
            AND CASE WHEN json_valid(failure.detail_json)
              THEN json_extract(failure.detail_json, '$.code') ELSE NULL END = 'TRANSCRIPTION_FAILED'
        )
        OR NOT EXISTS (
          SELECT 1 FROM json_each(s.transcript_json) AS turn
          WHERE CAST(turn.key AS INTEGER) < 300
            AND CASE WHEN turn.type = 'object'
              THEN json_extract(turn.value, '$.speaker') ELSE NULL END = 'candidate'
            AND CASE WHEN turn.type = 'object'
              THEN json_type(turn.value, '$.id') ELSE NULL END = 'text'
            AND CASE WHEN turn.type = 'object'
              THEN json_type(turn.value, '$.text') ELSE NULL END = 'text'
            AND COALESCE(CASE WHEN turn.type = 'object'
              THEN json_extract(turn.value, '$.id') ELSE NULL END, '') NOT LIKE 'recorded-transcribed-answer-%'
        )
      )
      AND (
        d.session_id IS NULL
        OR d.status = 'running'
        OR (d.status = 'failed' AND d.updated_at <= ?)
        OR (d.status = 'pending' AND d.updated_at <= ?)
        OR (d.status = 'completed' AND (
          COALESCE(json_extract(d.manifest_json, '$.transcriptAvailable'), 0) != 1
          OR COALESCE(json_extract(d.manifest_json, '$.transcriptKind'), '') != 'actual_transcript'
          OR (s.recording_status = 'stored'
            AND COALESCE(json_extract(d.manifest_json, '$.recordingIncluded'), 0) != 1)
        ))
      )
    ORDER BY CASE WHEN d.status = 'running' THEN 0 ELSE 1 END,
      COALESCE(d.updated_at, s.completed_at, s.created_at) ASC,
      s.id ASC
    LIMIT 25`)
    .bind(failedBefore, pendingBefore)
    .all<{ id: string; transcript_json: string; candidate_transcription_failed: number }>();

  for (const candidate of candidates.results ?? []) {
    const decoded = parseJson<unknown>(candidate.transcript_json, null);
    if (!Array.isArray(decoded)) continue;
    const transcript = decoded.slice(0, 300).flatMap((value): TranscriptTurn[] => {
      if (!value || typeof value !== "object") return [];
      const turn = value as Partial<TranscriptTurn>;
      if (
        typeof turn.id !== "string" ||
        (turn.speaker !== "candidate" && turn.speaker !== "interviewer") ||
        typeof turn.text !== "string"
      ) return [];
      return [{
        id: turn.id.slice(0, 120),
        speaker: turn.speaker,
        text: turn.text.replace(/\0/g, "").trim().slice(0, 5_000),
        createdAt: typeof turn.createdAt === "string" ? turn.createdAt.slice(0, 40) : "",
      }];
    });
    const failures = Number(candidate.candidate_transcription_failed ?? 0) === 1
      ? [{ type: "transcription_failed", detail: { code: "TRANSCRIPTION_FAILED" } }]
      : [];
    if (hasVerifiedCandidateTranscript(transcript, failures)) return candidate.id;
  }
  return null;
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
  driveUploadStepLeaseToken?: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  const driveStepLeaseFence = input.driveUploadStepLeaseToken
    ? ` AND EXISTS (
        SELECT 1 FROM interview_drive_upload_steps step
        WHERE step.session_id = ? AND step.started_at = ?
          AND step.lease_token = ? AND step.lease_expires_at > ?
      )`
    : "";
  const driveStepLeaseBindings = input.driveUploadStepLeaseToken
    ? [input.sessionId, input.startedAt, input.driveUploadStepLeaseToken, now]
    : [];
  const results = await db.batch([
    db.prepare(`UPDATE interview_external_syncs SET
      status = CASE WHEN requested_at > ? THEN 'pending' ELSE 'completed' END,
      completed_at = CASE WHEN requested_at > ? THEN NULL ELSE ? END,
      folder_id = ?, folder_url = ?, manifest_json = ?, error_code = NULL, updated_at = ?
      WHERE session_id = ? AND provider = 'google_drive' AND started_at = ?${driveStepLeaseFence}`)
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
        ...driveStepLeaseBindings,
      ),
    db.prepare(`INSERT INTO interview_audit_events (
      id, session_id, event_type, actor_type, detail_json
    ) SELECT ?, ?, 'google_drive_sync_completed', 'system', ?
      WHERE EXISTS (
        SELECT 1 FROM interview_external_syncs
        WHERE session_id = ? AND provider = 'google_drive' AND started_at = ?
      )${driveStepLeaseFence}`)
      .bind(
        crypto.randomUUID(),
        input.sessionId,
        JSON.stringify({ folderId: input.folderId }),
        input.sessionId,
        input.startedAt,
        ...driveStepLeaseBindings,
      ),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error(input.driveUploadStepLeaseToken
      ? "GOOGLE_DRIVE_UPLOAD_STEP_LEASE_LOST"
      : "GOOGLE_DRIVE_SYNC_CLAIM_LOST");
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

export async function deferExternalSync(input: {
  sessionId: string;
  startedAt: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  // Shared year/month hierarchy creation is serialized independently from a
  // candidate archive. Contention is a normal wait state, not a failed sync.
  // Fence the release on the exact running claim so a stale worker cannot put
  // a newer owner's sync back into pending.
  const result = await db.prepare(`UPDATE interview_external_syncs SET
    status = 'pending', started_at = NULL, completed_at = NULL,
    error_code = NULL, updated_at = ?
    WHERE session_id = ? AND provider = 'google_drive' AND status = 'running'
      AND started_at = ?`)
    .bind(now, input.sessionId, input.startedAt).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("GOOGLE_DRIVE_SYNC_CLAIM_LOST");
  }
}

export type DriveUploadStepState = {
  sessionId: string;
  startedAt: string;
  phase: "uploading" | "finalizing";
  uploadUrlCiphertext: string;
  uploadUrlIv: string;
  committedOffset: number;
  totalBytes: number;
  contentType: string;
  recordingName: string;
  folderId: string;
  folderUrl: string;
  context: Record<string, unknown>;
  recordingFile: Record<string, unknown> | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
};

type DriveUploadStepRow = {
  session_id: string;
  started_at: string;
  phase: string;
  upload_url_ciphertext: string;
  upload_url_iv: string;
  committed_offset: number;
  total_bytes: number;
  content_type: string;
  recording_name: string;
  folder_id: string;
  folder_url: string;
  context_json: string;
  recording_file_json: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
};

function safeDriveUploadStep(row: DriveUploadStepRow | null): DriveUploadStepState | null {
  if (!row || (row.phase !== "uploading" && row.phase !== "finalizing")) return null;
  return {
    sessionId: row.session_id,
    startedAt: row.started_at,
    phase: row.phase,
    uploadUrlCiphertext: row.upload_url_ciphertext,
    uploadUrlIv: row.upload_url_iv,
    committedOffset: Number(row.committed_offset),
    totalBytes: Number(row.total_bytes),
    contentType: row.content_type,
    recordingName: row.recording_name,
    folderId: row.folder_id,
    folderUrl: row.folder_url,
    context: parseJson<Record<string, unknown>>(row.context_json, {}),
    recordingFile: parseJson<Record<string, unknown> | null>(row.recording_file_json, null),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export async function getDriveUploadStep(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const row = await db.prepare(`SELECT session_id, started_at, phase,
    upload_url_ciphertext, upload_url_iv, committed_offset, total_bytes,
    content_type, recording_name, folder_id, folder_url, context_json,
    recording_file_json, lease_token, lease_expires_at
    FROM interview_drive_upload_steps WHERE session_id = ? LIMIT 1`)
    .bind(sessionId).first<DriveUploadStepRow>();
  return safeDriveUploadStep(row);
}

/**
 * Re-fences an already completed resumable upload to the new external-sync
 * claim without changing its durable recording receipt. This is the only safe
 * recovery path after finalization failed: starting a new upload could POST a
 * third recording, while overwriting the existing recording could destroy the
 * evidence needed to prove an exact duplicate.
 */
export async function adoptFinalizingDriveUploadStep(input: {
  sessionId: string;
  previousStartedAt: string;
  nextStartedAt: string;
  expectedTotalBytes: number;
  expectedContentType: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE interview_drive_upload_steps SET
    started_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE session_id = ? AND started_at = ? AND phase = 'finalizing'
      AND committed_offset = total_bytes AND total_bytes = ? AND content_type = ?
      AND recording_file_json IS NOT NULL
      AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      AND EXISTS (
        SELECT 1 FROM interview_external_syncs
        WHERE session_id = ? AND provider = 'google_drive'
          AND status = 'running' AND started_at = ?
      )`)
    .bind(
      input.nextStartedAt,
      now,
      input.sessionId,
      input.previousStartedAt,
      input.expectedTotalBytes,
      input.expectedContentType,
      now,
      input.sessionId,
      input.nextStartedAt,
    ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) return null;
  const stored = await getDriveUploadStep(input.sessionId);
  if (
    !stored || stored.startedAt !== input.nextStartedAt || stored.phase !== "finalizing" ||
    stored.committedOffset !== stored.totalBytes || stored.totalBytes !== input.expectedTotalBytes ||
    stored.contentType !== input.expectedContentType ||
    !stored.recordingFile || typeof stored.recordingFile.id !== "string"
  ) {
    throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_READBACK_MISMATCH");
  }
  return stored;
}

export async function initializeDriveUploadStep(input: {
  sessionId: string;
  startedAt: string;
  uploadUrlCiphertext: string;
  uploadUrlIv: string;
  totalBytes: number;
  contentType: string;
  recordingName: string;
  folderId: string;
  folderUrl: string;
  context: Record<string, unknown>;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO interview_drive_upload_steps (
    session_id, started_at, phase, upload_url_ciphertext, upload_url_iv,
    committed_offset, total_bytes, content_type, recording_name, folder_id,
    folder_url, context_json, recording_file_json, lease_token,
    lease_expires_at, created_at, updated_at
  ) VALUES (?, ?, 'uploading', ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    started_at = excluded.started_at,
    phase = 'uploading',
    upload_url_ciphertext = excluded.upload_url_ciphertext,
    upload_url_iv = excluded.upload_url_iv,
    committed_offset = 0,
    total_bytes = excluded.total_bytes,
    content_type = excluded.content_type,
    recording_name = excluded.recording_name,
    folder_id = excluded.folder_id,
    folder_url = excluded.folder_url,
    context_json = excluded.context_json,
    recording_file_json = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = excluded.updated_at`)
    .bind(
      input.sessionId,
      input.startedAt,
      input.uploadUrlCiphertext,
      input.uploadUrlIv,
      input.totalBytes,
      input.contentType,
      input.recordingName,
      input.folderId,
      input.folderUrl,
      JSON.stringify(input.context),
      now,
      now,
    ).run();
  const stored = await getDriveUploadStep(input.sessionId);
  if (!stored || stored.startedAt !== input.startedAt || stored.totalBytes !== input.totalBytes) {
    throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_READBACK_MISMATCH");
  }
  return stored;
}

const DRIVE_UPLOAD_STEP_LEASE_MS = 90_000;

const DRIVE_HIERARCHY_NODE_LEASE_MS = 90_000;

export async function acquireDriveHierarchyNodeLease(nodeKey: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + DRIVE_HIERARCHY_NODE_LEASE_MS).toISOString();
  const result = await db.prepare(`INSERT INTO interview_drive_hierarchy_nodes (
      node_key, canonical_folder_id, creation_attempted_at, lease_token, lease_expires_at, created_at, updated_at
    ) VALUES (?, NULL, NULL, ?, ?, ?, ?)
    ON CONFLICT(node_key) DO UPDATE SET
      lease_token = excluded.lease_token,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = excluded.updated_at
    WHERE interview_drive_hierarchy_nodes.lease_token IS NULL
      OR interview_drive_hierarchy_nodes.lease_expires_at IS NULL
      OR interview_drive_hierarchy_nodes.lease_expires_at <= ?`)
    .bind(nodeKey, leaseToken, leaseExpiresAt, nowIso, nowIso, nowIso).run();
  if (Number(result.meta?.changes ?? 0) !== 1) return null;
  const stored = await db.prepare(`SELECT canonical_folder_id, creation_attempted_at
    FROM interview_drive_hierarchy_nodes
    WHERE node_key = ? AND lease_token = ? AND lease_expires_at > ? LIMIT 1`)
    .bind(nodeKey, leaseToken, nowIso)
    .first<{ canonical_folder_id: string | null; creation_attempted_at: string | null }>();
  if (!stored) throw new Error("GOOGLE_DRIVE_HIERARCHY_LEASE_LOST");
  return {
    leaseToken,
    canonicalFolderId: stored.canonical_folder_id,
    creationAttemptedAt: stored.creation_attempted_at,
  };
}

export async function renewDriveHierarchyNodeLease(input: { nodeKey: string; leaseToken: string }) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + DRIVE_HIERARCHY_NODE_LEASE_MS).toISOString();
  const result = await db.prepare(`UPDATE interview_drive_hierarchy_nodes SET
      lease_expires_at = ?, updated_at = ?
    WHERE node_key = ? AND lease_token = ? AND lease_expires_at > ?`)
    .bind(leaseExpiresAt, nowIso, input.nodeKey, input.leaseToken, nowIso).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function setDriveHierarchyNodeCanonicalFolder(input: {
  nodeKey: string;
  leaseToken: string;
  folderId: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE interview_drive_hierarchy_nodes SET
      canonical_folder_id = ?, updated_at = ?
    WHERE node_key = ? AND lease_token = ? AND lease_expires_at > ?
      AND (canonical_folder_id IS NULL OR canonical_folder_id = ?)`)
    .bind(input.folderId, now, input.nodeKey, input.leaseToken, now, input.folderId).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("GOOGLE_DRIVE_HIERARCHY_CANONICAL_CONFLICT");
  }
}

export async function markDriveHierarchyNodeCreationAttempt(input: {
  nodeKey: string;
  leaseToken: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE interview_drive_hierarchy_nodes SET
      creation_attempted_at = ?, updated_at = ?
    WHERE node_key = ? AND lease_token = ? AND lease_expires_at > ?
      AND canonical_folder_id IS NULL AND creation_attempted_at IS NULL`)
    .bind(now, now, input.nodeKey, input.leaseToken, now).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("GOOGLE_DRIVE_HIERARCHY_CREATION_UNCERTAIN");
  }
}

export async function releaseDriveHierarchyNodeLease(input: { nodeKey: string; leaseToken: string }) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE interview_drive_hierarchy_nodes SET
      lease_token = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE node_key = ? AND lease_token = ? AND lease_expires_at > ?`)
    .bind(now, input.nodeKey, input.leaseToken, now).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("GOOGLE_DRIVE_HIERARCHY_LEASE_LOST");
  }
}

export async function acquireDriveUploadStepLease(sessionId: string, startedAt: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + DRIVE_UPLOAD_STEP_LEASE_MS).toISOString();
  const result = await db.prepare(`UPDATE interview_drive_upload_steps SET
    lease_token = ?, lease_expires_at = ?, updated_at = ?
    WHERE session_id = ? AND started_at = ?
      AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`)
    .bind(leaseToken, leaseExpiresAt, nowIso, sessionId, startedAt, nowIso).run();
  return Number(result.meta?.changes ?? 0) === 1 ? leaseToken : null;
}

/**
 * Extends a live upload-step lease only for its current owner. An already
 * expired owner may never resurrect itself: it must stop before the next Drive
 * mutation and let a fresh request acquire a new token.
 */
export async function renewDriveUploadStepLease(input: {
  sessionId: string;
  startedAt: string;
  leaseToken: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + DRIVE_UPLOAD_STEP_LEASE_MS).toISOString();
  const result = await db.prepare(`UPDATE interview_drive_upload_steps SET
    lease_expires_at = ?, updated_at = ?
    WHERE session_id = ? AND started_at = ? AND lease_token = ?
      AND lease_expires_at > ?`)
    .bind(
      leaseExpiresAt,
      nowIso,
      input.sessionId,
      input.startedAt,
      input.leaseToken,
      nowIso,
    ).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function updateDriveUploadStep(input: {
  sessionId: string;
  startedAt: string;
  leaseToken: string;
  committedOffset: number;
  phase?: "uploading" | "finalizing";
  recordingFile?: Record<string, unknown> | null;
  uploadUrlCiphertext?: string;
  uploadUrlIv?: string;
  releaseLease?: boolean;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE interview_drive_upload_steps SET
    committed_offset = ?,
    phase = COALESCE(?, phase),
    recording_file_json = CASE WHEN ? IS NULL THEN recording_file_json ELSE ? END,
    upload_url_ciphertext = COALESCE(?, upload_url_ciphertext),
    upload_url_iv = COALESCE(?, upload_url_iv),
    lease_token = CASE WHEN ? = 1 THEN NULL ELSE lease_token END,
    lease_expires_at = CASE WHEN ? = 1 THEN NULL ELSE lease_expires_at END,
    updated_at = ?
    WHERE session_id = ? AND started_at = ? AND lease_token = ?
      AND lease_expires_at > ?`)
    .bind(
      input.committedOffset,
      input.phase ?? null,
      input.recordingFile === undefined ? null : "replace",
      input.recordingFile === undefined ? null : JSON.stringify(input.recordingFile),
      input.uploadUrlCiphertext ?? null,
      input.uploadUrlIv ?? null,
      input.releaseLease === true ? 1 : 0,
      input.releaseLease === true ? 1 : 0,
      now,
      input.sessionId,
      input.startedAt,
      input.leaseToken,
      now,
    ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_LEASE_LOST");
}

export async function updateDriveUploadStepContext(input: {
  sessionId: string;
  startedAt: string;
  leaseToken: string;
  context: Record<string, unknown>;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  const contextJson = JSON.stringify(input.context);
  const result = await db.prepare(`UPDATE interview_drive_upload_steps SET
    context_json = ?, updated_at = ?
    WHERE session_id = ? AND started_at = ? AND lease_token = ?
      AND lease_expires_at > ?`)
    .bind(contextJson, now, input.sessionId, input.startedAt, input.leaseToken, now).run();
  if (Number(result.meta?.changes ?? 0) !== 1) throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_LEASE_LOST");
  const stored = await getDriveUploadStep(input.sessionId);
  if (
    !stored || stored.startedAt !== input.startedAt ||
    JSON.stringify(stored.context) !== contextJson
  ) {
    throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_READBACK_MISMATCH");
  }
}

export async function releaseDriveUploadStepLease(input: {
  sessionId: string;
  startedAt: string;
  leaseToken: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  await db.prepare(`UPDATE interview_drive_upload_steps SET
    lease_token = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE session_id = ? AND started_at = ? AND lease_token = ?
      AND lease_expires_at > ?`)
    .bind(now, input.sessionId, input.startedAt, input.leaseToken, now).run();
}

export async function deleteDriveUploadStep(input: {
  sessionId: string;
  startedAt: string;
  leaseToken: string;
}) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  const now = new Date().toISOString();
  const result = await db.prepare(`DELETE FROM interview_drive_upload_steps
    WHERE session_id = ? AND started_at = ? AND lease_token = ?
      AND lease_expires_at > ?`)
    .bind(input.sessionId, input.startedAt, input.leaseToken, now).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_LEASE_LOST");
  }
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

export async function getInterviewRecordingChunk(input: {
  sessionId: string;
  offset: number;
  length: number;
}) {
  const db = database();
  const bucket = bindings().RECORDINGS;
  if (!db || !bucket) throw new Error("INTERVIEW_RECORDING_STORAGE_UNAVAILABLE");
  await ensureSchema(db);
  const artifact = await db.prepare(`SELECT object_key, content_type, byte_size
    FROM interview_artifacts WHERE session_id = ? AND kind = 'recording'
    ORDER BY created_at DESC LIMIT 1`)
    .bind(input.sessionId)
    .first<{ object_key: string; content_type: string; byte_size: number }>();
  if (!artifact) return null;
  if (
    !Number.isInteger(input.offset) ||
    !Number.isInteger(input.length) ||
    input.offset < 0 ||
    input.length < 1 ||
    input.offset + input.length > artifact.byte_size
  ) {
    throw new Error("INTERVIEW_RECORDING_RANGE_INVALID");
  }

  if (!artifact.object_key.endsWith(".manifest.json")) {
    const object = await bucket.get(artifact.object_key, {
      range: { offset: input.offset, length: input.length },
    });
    if (!object || !("body" in object)) throw new Error("INTERVIEW_RECORDING_ARTIFACT_MISSING");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== input.length) throw new Error("INTERVIEW_RECORDING_RANGE_MISMATCH");
    return { bytes, contentType: artifact.content_type, byteSize: artifact.byte_size };
  }

  const manifestObject = await bucket.get(artifact.object_key);
  if (!manifestObject || !("body" in manifestObject)) throw new Error("INTERVIEW_RECORDING_ARTIFACT_MISSING");
  const manifest = JSON.parse(await r2ObjectText(manifestObject)) as RecordingPartManifest;
  if (
    ![1, 2].includes(manifest.version) ||
    !Array.isArray(manifest.parts) ||
    manifest.parts.length === 0 ||
    (manifest.version === 2 && manifest.parts.some((part) => !/^[a-f0-9]{64}$/.test(part.sha256 ?? "")))
  ) {
    throw new Error("INTERVIEW_RECORDING_MANIFEST_INVALID");
  }
  const result = new Uint8Array(input.length);
  let outputOffset = 0;
  let objectOffset = 0;
  for (const part of manifest.parts) {
    const partStart = objectOffset;
    const partEnd = partStart + part.byteSize;
    objectOffset = partEnd;
    const overlapStart = Math.max(input.offset, partStart);
    const overlapEnd = Math.min(input.offset + input.length, partEnd);
    if (overlapStart >= overlapEnd) continue;
    const length = overlapEnd - overlapStart;
    const object = await bucket.get(part.key, {
      range: { offset: overlapStart - partStart, length },
    });
    if (!object || !("body" in object)) throw new Error("INTERVIEW_RECORDING_PART_MISSING");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== length) throw new Error("INTERVIEW_RECORDING_RANGE_MISMATCH");
    result.set(bytes, outputOffset);
    outputOffset += bytes.byteLength;
  }
  if (outputOffset !== input.length) throw new Error("INTERVIEW_RECORDING_RANGE_MISMATCH");
  return { bytes: result, contentType: artifact.content_type, byteSize: artifact.byte_size };
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
  const parsedTranscript = parseJson<TranscriptTurn[]>(session.transcript_json, []);
  const parsedTechnicalEvents = (technicalEvents.results ?? []).map((event) => ({
    type: String(event.event_type ?? ""),
    detail: parseJson<Record<string, unknown>>(event.detail_json, {}),
    createdAt: String(event.created_at ?? ""),
  }));
  const sourceTranscriptVerified = hasVerifiedCandidateTranscript(
    parsedTranscript,
    parsedTechnicalEvents,
  );
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
    transcript: parsedTranscript,
    sourceTranscriptVerified,
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
    technicalEvents: parsedTechnicalEvents,
    driveSync: driveSync ? {
      ...driveSync,
      recordingIncluded: driveSync.manifest?.recordingIncluded === true,
      transcriptAvailable: driveSync.manifest?.transcriptAvailable === true,
      transcriptKind: typeof driveSync.manifest?.transcriptKind === "string"
        ? driveSync.manifest.transcriptKind
        : "unknown",
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
  driveRecordingIncluded: boolean | null;
  driveTranscriptAvailable: boolean | null;
  driveTranscriptKind: string | null;
  sourceTranscriptVerified: boolean;
};

export type InterviewListPage = {
  items: InterviewListItem[];
  nextCursor: string | null;
};

type InterviewListCursor = {
  createdAt: string;
  sessionId: string;
};

const INTERVIEW_LIST_CURSOR_SEPARATOR = "|";

export function parseInterviewListCursor(value: string | null): InterviewListCursor | null {
  if (!value || value.length > 100) return null;
  const separator = value.indexOf(INTERVIEW_LIST_CURSOR_SEPARATOR);
  if (separator < 1 || separator !== value.lastIndexOf(INTERVIEW_LIST_CURSOR_SEPARATOR)) return null;
  const createdAt = value.slice(0, separator);
  const sessionId = value.slice(separator + 1);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)
  ) return null;
  return { createdAt, sessionId };
}

function interviewListCursor(item: InterviewListItem) {
  return `${item.createdAt}${INTERVIEW_LIST_CURSOR_SEPARATOR}${item.sessionId}`;
}

export async function listInterviewSummaryPage(
  reviewer: AuthorizedReviewer,
  limit = 50,
  options: { audit?: boolean; cursor?: InterviewListCursor | null } = {},
): Promise<InterviewListPage> {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const select = `SELECT
    s.id, s.candidate_name, s.employment, s.preferred_location,
    s.status, s.recording_status, s.transcript_json, s.created_at, s.completed_at, s.retention_until,
    EXISTS (
      SELECT 1 FROM interview_audit_events AS ta
      WHERE ta.session_id = s.id
        AND ta.event_type = 'transcription_failed'
        AND CASE WHEN json_valid(ta.detail_json)
          THEN json_extract(ta.detail_json, '$.code') ELSE NULL END = 'TRANSCRIPTION_FAILED'
    ) AS candidate_transcription_failed,
    d.status AS drive_status, d.folder_url AS drive_folder_url, d.updated_at AS drive_updated_at,
    d.manifest_json AS drive_manifest_json
    FROM interview_sessions AS s
    LEFT JOIN interview_external_syncs AS d
      ON d.session_id = s.id AND d.provider = 'google_drive'`;
  const rows = options.cursor
    ? await db.prepare(`${select}
        WHERE s.created_at < ? OR (s.created_at = ? AND s.id < ?)
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ?`)
        .bind(options.cursor.createdAt, options.cursor.createdAt, options.cursor.sessionId, safeLimit + 1)
        .all<Record<string, unknown>>()
    : await db.prepare(`${select}
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ?`)
        .bind(safeLimit + 1)
        .all<Record<string, unknown>>();
  const pageRows = (rows.results ?? []).slice(0, safeLimit);
  const items: InterviewListItem[] = pageRows.map((row) => {
    const driveManifest = parseJson<Record<string, unknown> | null>(row.drive_manifest_json, null);
    const sourceTranscript = parseJson<TranscriptTurn[]>(row.transcript_json, []);
    const sourceTranscriptVerified = hasVerifiedCandidateTranscript(
      sourceTranscript,
      Number(row.candidate_transcription_failed ?? 0) === 1
        ? [{ type: "transcription_failed", detail: { code: "TRANSCRIPTION_FAILED" } }]
        : [],
    );
    return {
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
      driveRecordingIncluded: driveManifest ? driveManifest.recordingIncluded === true : null,
      driveTranscriptAvailable: driveManifest ? driveManifest.transcriptAvailable === true : null,
      driveTranscriptKind: driveManifest && typeof driveManifest.transcriptKind === "string"
        ? driveManifest.transcriptKind
        : null,
      sourceTranscriptVerified,
    };
  });
  if (options.audit !== false) {
    await db.prepare(`INSERT INTO interview_staff_audit_events (
      id, reviewer_name, event_type, detail_json
    ) VALUES (?, ?, 'interview_list_opened', ?)`)
      .bind(crypto.randomUUID(), reviewer, JSON.stringify({ resultCount: items.length, limit: safeLimit }))
      .run();
  }
  return {
    items,
    nextCursor: (rows.results ?? []).length > safeLimit && items.length > 0
      ? interviewListCursor(items[items.length - 1])
      : null,
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
  // Version 2 requires a SHA-256 receipt for every new part. Version 1 remains
  // readable so already-uploaded production interviews can still be recovered.
  version: 1 | 2;
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
  version: 1 | 2;
  contentType: string;
  byteSize: number;
  audioCoverage: "both" | "candidate-only" | "unverified";
  parts: Array<{ key: string; byteSize: number; sha256?: string }>;
};

function recordingUploadStateKey(sessionId: string) {
  return `interviews/${sessionId}/recording-parts/upload.json`;
}

function recordingPartKey(sessionId: string, index: number) {
  return `interviews/${sessionId}/recording-parts/part-${String(index).padStart(3, "0")}`;
}

function bufferHex(value: ArrayBuffer | ArrayBufferView | undefined) {
  if (!value) return "";
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function verifiedRecordingPartSha256(part: R2Object, expected: string) {
  return part.customMetadata?.sha256 === expected && bufferHex(part.checksums?.sha256) === expected;
}

function verifiedRecordingPartForCompletion(state: RecordingUploadState, part: R2Object) {
  const sha256 = part.customMetadata?.sha256 ?? "";
  // Only an object that genuinely predates the checksum rollout may omit its
  // digest. Every part accepted by the current server, including a Version 1
  // old-tab upload, is hashed server-side and must pass the same R2 readback.
  if (!sha256) return state.version === 1;
  return /^[a-f0-9]{64}$/.test(sha256) && verifiedRecordingPartSha256(part, sha256);
}

async function legacyRecordingPartBodyMatches(input: {
  bucket: R2Bucket;
  key: string;
  byteSize: number;
  sha256: string;
}) {
  const object = await input.bucket.get(input.key);
  if (
    !object ||
    object.size !== input.byteSize ||
    Number(object.customMetadata?.byteSize ?? 0) !== input.byteSize
  ) return false;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== input.byteSize) return false;
  const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return bufferHex(await crypto.subtle.digest("SHA-256", exact)) === input.sha256;
}

async function r2ObjectText(object: R2ObjectBody) {
  return await new Response(object.body).text();
}

function parseRecordingUploadState(value: string): RecordingUploadState {
  const parsed = JSON.parse(value) as Partial<RecordingUploadState>;
  if (
    ![1, 2].includes(parsed.version ?? 0) ||
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
  uploadVersion: 1 | 2;
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
      state.version !== input.uploadVersion ||
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
    const proposedState: RecordingUploadState = {
      version: input.uploadVersion,
      sessionId: input.session.id,
      contentType: input.contentType,
      byteSize: input.byteSize,
      partSize: input.partSize,
      totalParts: input.totalParts,
      audioCoverage: input.audioCoverage,
      retentionUntil: input.session.retention_until,
      createdAt: new Date().toISOString(),
    };
    const created = await bucket.put(stateKey, JSON.stringify(proposedState), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sessionId: input.session.id, retentionUntil: input.session.retention_until },
    });
    if (created) {
      state = proposedState;
    } else {
      // Another authenticated start won the create-only race after our first
      // read. Re-read its immutable protocol/shape and join only if every field
      // matches; never let an old and new tab clobber each other's state.
      const concurrentObject = await bucket.get(stateKey);
      if (!concurrentObject) throw new Error("INTERVIEW_RECORDING_UPLOAD_BUSY");
      const concurrent = parseRecordingUploadState(await r2ObjectText(concurrentObject));
      if (
        concurrent.version !== proposedState.version ||
        concurrent.sessionId !== proposedState.sessionId ||
        concurrent.contentType !== proposedState.contentType ||
        concurrent.byteSize !== proposedState.byteSize ||
        concurrent.partSize !== proposedState.partSize ||
        concurrent.totalParts !== proposedState.totalParts ||
        concurrent.audioCoverage !== proposedState.audioCoverage
      ) {
        throw new Error("INTERVIEW_RECORDING_UPLOAD_CONFLICT");
      }
      state = concurrent;
    }
  }
  const uploadedParts: number[] = [];
  const uploadedPartReceipts: Array<{ index: number; sha256: string }> = [];
  for (let index = 0; index < state.totalParts; index += 1) {
    // Resume needs metadata only. Opening every stored part body here recreates
    // the same Worker connection exhaustion that previously broke finalization.
    const part = await bucket.head(recordingPartKey(state.sessionId, index));
    const expectedSize = index === state.totalParts - 1
      ? state.byteSize - state.partSize * (state.totalParts - 1)
      : state.partSize;
    if (
      part?.size === expectedSize &&
      Number(part.customMetadata?.byteSize ?? 0) === expectedSize &&
      // A pre-rollout Version 1 object may have no checksum. Do not tell a
      // candidate client to skip it: force an exact replay so the PUT path can
      // hash the stored body and prove that the browser still has the same
      // bytes. Staff completion retains the size-only legacy recovery below.
      /^[a-f0-9]{64}$/.test(part.customMetadata?.sha256 ?? "") &&
      verifiedRecordingPartSha256(part, part.customMetadata?.sha256 ?? "")
    ) {
      uploadedParts.push(index);
      if (state.version === 2) {
        uploadedPartReceipts.push({ index, sha256: part.customMetadata?.sha256 ?? "" });
      }
    }
  }
  // The authorization snapshot was read before the R2 metadata walk. Staff
  // recovery may finalize the same upload during that walk, so refresh the D1
  // status at the end instead of returning a stale `stored: false` receipt.
  const latestSession = input.session.recording_status === "stored"
    ? input.session
    : await getInterviewSessionState(input.session.id);
  return {
    stored: latestSession?.recording_status === "stored",
    uploadVersion: state.version,
    uploadedParts,
    uploadedPartReceipts,
    contentType: state.contentType,
    byteSize: state.byteSize,
    partSize: state.partSize,
    totalParts: state.totalParts,
    audioCoverage: state.audioCoverage,
  };
}

export async function saveResumableInterviewRecordingPart(input: {
  sessionId: string;
  index: number;
  byteSize: number;
  sha256?: string;
  digestDeclared?: boolean;
  body: ReadableStream | Uint8Array;
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
  if (state.version === 2 && !/^[a-f0-9]{64}$/.test(input.sha256 ?? "")) {
    throw new Error("INTERVIEW_RECORDING_PART_DIGEST_INVALID");
  }
  if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new Error("INTERVIEW_RECORDING_PART_DIGEST_INVALID");
  }
  const key = recordingPartKey(input.sessionId, input.index);
  // New objects are verified from R2 checksum metadata. A genuinely
  // pre-rollout Version 1 object has no checksum, so that one compatibility
  // case consumes and hashes its bounded (<=8 MiB) body before acknowledging.
  const existing = await bucket.head(key);
  const legacyExistingMatches = Boolean(
    existing?.size === input.byteSize &&
    Number(existing.customMetadata?.byteSize ?? 0) === input.byteSize &&
    state.version === 1 &&
    !existing.customMetadata?.sha256 &&
    input.digestDeclared === false &&
    input.sha256 &&
    await legacyRecordingPartBodyMatches({
      bucket,
      key,
      byteSize: input.byteSize,
      sha256: input.sha256,
    })
  );
  if (
    existing?.size === input.byteSize &&
    Number(existing.customMetadata?.byteSize ?? 0) === input.byteSize &&
    (
      (input.sha256 && verifiedRecordingPartSha256(existing, input.sha256)) ||
      // Only an object actually created before the checksum rollout may use
      // the legacy size-only receipt. New requests always carry the SHA that
      // the server computed from their exact buffered body.
      legacyExistingMatches
    )
  ) {
    // This receipt is also the durable activity fence used by server recovery.
    // Long mobile uploads can span several cron ticks; refreshing D1 only after
    // R2 has proved the exact part prevents an active upload being reclaimed.
    await heartbeatInterviewRecordingUpload(input.sessionId);
    return { stored: true, duplicate: true };
  }
  // A deterministic part key is immutable once present. Replacing an existing
  // object would let a delayed retry silently change a finalized recording.
  if (existing) throw new Error("INTERVIEW_RECORDING_PART_DIGEST_CONFLICT");
  const stored = await bucket.put(key, input.body, {
    // Make the deterministic part key create-only. This closes the race where
    // two different same-size requests both observed an absent object.
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: {
      sessionId: input.sessionId,
      byteSize: String(input.byteSize),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
      retentionUntil: state.retentionUntil,
    },
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
  });
  if (!stored) {
    const concurrent = await bucket.head(key);
    const legacyConcurrentMatches = Boolean(
      concurrent?.size === input.byteSize &&
      Number(concurrent.customMetadata?.byteSize ?? 0) === input.byteSize &&
      state.version === 1 &&
      !concurrent.customMetadata?.sha256 &&
      input.digestDeclared === false &&
      input.sha256 &&
      await legacyRecordingPartBodyMatches({
        bucket,
        key,
        byteSize: input.byteSize,
        sha256: input.sha256,
      })
    );
    if (
      concurrent?.size === input.byteSize &&
      Number(concurrent.customMetadata?.byteSize ?? 0) === input.byteSize &&
      (
        (input.sha256 && verifiedRecordingPartSha256(concurrent, input.sha256)) ||
        legacyConcurrentMatches
      )
    ) {
      await heartbeatInterviewRecordingUpload(input.sessionId);
      return { stored: true, duplicate: true };
    }
    throw new Error("INTERVIEW_RECORDING_PART_DIGEST_CONFLICT");
  }
  if (
    stored.size !== input.byteSize ||
    (input.sha256 && !verifiedRecordingPartSha256(stored, input.sha256))
  ) {
    throw new Error("INTERVIEW_RECORDING_PART_SIZE_INVALID");
  }
  await heartbeatInterviewRecordingUpload(input.sessionId);
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
    // Completion only needs object metadata. R2 `get()` also opens a body stream;
    // leaving many of those streams unread exhausts the Worker's subrequest/body
    // slots and made Android recordings hang until the request was cancelled.
    const part = await bucket.head(key);
    const byteSize = Number(part?.customMetadata?.byteSize ?? 0);
    const sha256 = part?.customMetadata?.sha256 ?? "";
    const expectedSize = index === state.totalParts - 1
      ? state.byteSize - state.partSize * (state.totalParts - 1)
      : state.partSize;
    if (
      !part ||
      part.size !== expectedSize ||
      byteSize !== expectedSize ||
      !verifiedRecordingPartForCompletion(state, part)
    ) {
      throw new Error("INTERVIEW_RECORDING_PART_MISSING");
    }
    parts.push({ key, byteSize, ...(sha256 ? { sha256 } : {}) });
  }
  if (parts.reduce((total, part) => total + part.byteSize, 0) !== state.byteSize) {
    throw new Error("INTERVIEW_RECORDING_SIZE_MISMATCH");
  }
  const manifest: RecordingPartManifest = {
    version: state.version,
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

/**
 * Finalizes a completed interview whose candidate uploaded every recording part
 * but whose original completion request was interrupted. This is intentionally
 * server-side and idempotent so the recruiter recovery loop never needs the
 * candidate's expired access token.
 */
export async function recoverResumableInterviewRecording(sessionId: string) {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const session = await db.prepare(
    "SELECT id, access_token_hash, candidate_name, employment, preferred_location, status, recording_status, expires_at, retention_until FROM interview_sessions WHERE id = ? LIMIT 1",
  ).bind(sessionId).first<InterviewSessionRecord>();
  if (!session) throw new Error("INTERVIEW_NOT_FOUND");
  if (session.status !== "completed") {
    const seal = await db.prepare(`SELECT
        EXISTS (
          SELECT 1 FROM recorded_interview_completions
          WHERE session_id = s.id
        ) AS recorded_fallback_sealed,
        (
          EXISTS (
            SELECT 1 FROM interview_audit_events
            WHERE session_id = s.id AND event_type = 'voice_transcript_sealed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM interview_audit_events
            WHERE session_id = s.id AND event_type = 'recorded_fallback_started'
          )
          AND s.transcript_json IS NOT NULL
          AND json_valid(s.transcript_json)
          AND EXISTS (
            SELECT 1 FROM json_each(s.transcript_json) AS turn
            WHERE json_extract(turn.value, '$.speaker') = 'candidate'
              AND length(trim(COALESCE(json_extract(turn.value, '$.text'), ''))) > 0
          )
        ) AS voice_transcript_sealed
      FROM interview_sessions s WHERE s.id = ? LIMIT 1`)
      .bind(sessionId)
      .first<{ recorded_fallback_sealed: number; voice_transcript_sealed: number }>();
    const hasRecoverySeal = Number(seal?.recorded_fallback_sealed ?? 0) === 1 ||
      Number(seal?.voice_transcript_sealed ?? 0) === 1;
    if (!hasRecoverySeal || !["in_progress", "evaluation_pending", "evaluation_processing"].includes(session.status)) {
      throw new Error("INTERVIEW_RECORDING_RECOVERY_NOT_READY");
    }
  }
  if (session.recording_status === "stored") return { stored: true, alreadyStored: true };
  if (!["uploading", "failed"].includes(session.recording_status)) {
    throw new Error("INTERVIEW_RECORDING_RECOVERY_NOT_AVAILABLE");
  }
  return await completeResumableInterviewRecording(session);
}

export async function recoverNextSealedResumableInterviewRecording() {
  const db = database();
  if (!db) throw new Error("INTERVIEW_DATABASE_UNAVAILABLE");
  await ensureSchema(db);
  const staleBefore = new Date(Date.now() - 60 * 1_000).toISOString();
  // Keep the global selector aligned with the authenticated staff planner: a
  // completed evaluation gets a five-minute grace period for the candidate's
  // foreground upload. The shorter updated_at fence still excludes an upload
  // whose part heartbeat shows current activity.
  const completedBefore = new Date(Date.now() - 5 * 60 * 1_000).toISOString();
  const targets = await db.prepare(`SELECT s.id, s.expires_at, s.created_at,
      COALESCE(
        (SELECT c.requested_at FROM recorded_interview_completions c WHERE c.session_id = s.id),
        (SELECT MIN(a.created_at) FROM interview_audit_events a
          WHERE a.session_id = s.id AND a.event_type = 'voice_transcript_sealed'),
        s.completed_at,
        s.created_at
      ) AS recovery_sealed_at,
      (SELECT COUNT(*) FROM interview_audit_events missing
        WHERE missing.session_id = s.id
          AND missing.event_type = '${RECORDING_RECOVERY_MISSING_EVENT}') AS missing_attempt_count
    FROM interview_sessions s
    WHERE s.recording_status IN ('uploading', 'failed')
      AND s.updated_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM interview_audit_events terminal
        WHERE terminal.session_id = s.id
          AND terminal.event_type = '${RECORDING_RECOVERY_MANUAL_ATTENTION_EVENT}'
      )
      AND (
        (
          s.status = 'completed'
          AND s.completed_at IS NOT NULL
          AND s.completed_at <= ?
        )
        OR (
          s.status IN ('in_progress', 'evaluation_pending', 'evaluation_processing')
          AND (
            EXISTS (
              SELECT 1 FROM recorded_interview_completions c
              WHERE c.session_id = s.id
            )
            OR (
              EXISTS (
                SELECT 1 FROM interview_audit_events
                WHERE session_id = s.id AND event_type = 'voice_transcript_sealed'
              )
              AND NOT EXISTS (
                SELECT 1 FROM interview_audit_events
                WHERE session_id = s.id AND event_type = 'recorded_fallback_started'
              )
              AND s.transcript_json IS NOT NULL
              AND json_valid(s.transcript_json)
              AND EXISTS (
                SELECT 1 FROM json_each(s.transcript_json) AS turn
                WHERE json_extract(turn.value, '$.speaker') = 'candidate'
                  AND length(trim(COALESCE(json_extract(turn.value, '$.text'), ''))) > 0
              )
            )
          )
        )
      )
    ORDER BY s.updated_at ASC, COALESCE(
      (SELECT c.requested_at FROM recorded_interview_completions c WHERE c.session_id = s.id),
      (SELECT MIN(a.created_at) FROM interview_audit_events a
        WHERE a.session_id = s.id AND a.event_type = 'voice_transcript_sealed')
    ) ASC, s.id ASC
    LIMIT 10`)
    .bind(staleBefore, completedBefore)
    .all<{
      id: string;
      expires_at: string;
      created_at: string;
      recovery_sealed_at: string;
      missing_attempt_count: number;
    }>();
  let firstDeferred: {
    state: "waiting" | "manual_attention" | "failed";
    sessionId: string;
    errorCode: string;
  } | null = null;
  for (const target of targets.results ?? []) {
    try {
      const result = await recoverResumableInterviewRecording(target.id);
      return { state: "stored", sessionId: target.id, result } as const;
    } catch (error) {
      const code = error instanceof Error ? error.message : "INTERVIEW_RECORDING_RECOVERY_FAILED";
      if (code.includes("PART_MISSING")) {
        const observedAt = new Date();
        const observedAtIso = observedAt.toISOString();
        const attemptCount = Math.max(0, Number(target.missing_attempt_count) || 0) + 1;
        await db.prepare(`INSERT INTO interview_audit_events (
          id, session_id, event_type, actor_type, detail_json, created_at
        ) VALUES (?, ?, '${RECORDING_RECOVERY_MISSING_EVENT}', 'system', ?, ?)`)
          .bind(
            crypto.randomUUID(),
            target.id,
            JSON.stringify({ attemptCount, errorCode: code.slice(0, 120) }),
            observedAtIso,
          ).run();

        const expiresAt = Date.parse(target.expires_at);
        const sealedAt = Date.parse(target.recovery_sealed_at || target.created_at);
        const candidateResumeDeadline = Number.isFinite(expiresAt)
          ? expiresAt + RECORDING_RECOVERY_EXPIRY_GRACE_MS
          : Number.POSITIVE_INFINITY;
        const absoluteDeadline = Number.isFinite(sealedAt)
          ? sealedAt + RECORDING_RECOVERY_ABSOLUTE_DEADLINE_MS
          : Number.POSITIVE_INFINITY;
        const candidateGraceElapsed = observedAt.getTime() >= candidateResumeDeadline;
        const shouldTerminalize = candidateGraceElapsed && (
          attemptCount >= RECORDING_RECOVERY_MISSING_ATTEMPT_LIMIT ||
          observedAt.getTime() >= absoluteDeadline
        );

        if (shouldTerminalize) {
          // `failed` remains resumable by the authenticated foreground path;
          // the durable marker terminates only unattended selection so cron no
          // longer emits the same attention state forever.
          await failInterviewRecordingUpload(target.id);
          await db.prepare(`INSERT INTO interview_audit_events (
            id, session_id, event_type, actor_type, detail_json, created_at
          ) SELECT ?, ?, '${RECORDING_RECOVERY_MANUAL_ATTENTION_EVENT}', 'system', ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM interview_audit_events
              WHERE session_id = ? AND event_type = '${RECORDING_RECOVERY_MANUAL_ATTENTION_EVENT}'
            )`)
            .bind(
              crypto.randomUUID(),
              target.id,
              JSON.stringify({
                attemptCount,
                errorCode: code.slice(0, 120),
                expiresAt: target.expires_at,
                recoverySealedAt: target.recovery_sealed_at,
              }),
              observedAtIso,
              target.id,
            ).run();
          firstDeferred ??= {
            state: "manual_attention",
            sessionId: target.id,
            errorCode: code.slice(0, 120),
          };
          continue;
        }

        // Missing parts are not yet a failed upload: the candidate may still
        // be sending them. Move this row behind the one-minute activity fence
        // and inspect another bounded candidate in the same tick.
        await heartbeatInterviewRecordingUpload(target.id);
        firstDeferred ??= { state: "waiting", sessionId: target.id, errorCode: code.slice(0, 120) };
        continue;
      }
      await failInterviewRecordingUpload(target.id);
      firstDeferred ??= { state: "failed", sessionId: target.id, errorCode: code.slice(0, 120) };
    }
  }
  return firstDeferred ?? { state: "none" } as const;
}

async function loadRecordingObject(bucket: R2Bucket, objectKey: string) {
  const object = await bucket.get(objectKey);
  if (!object) return null;
  if (!objectKey.endsWith(".manifest.json")) {
    return { body: object.body, etag: object.etag, customMetadata: object.customMetadata ?? {} };
  }
  const manifest = JSON.parse(await r2ObjectText(object)) as RecordingPartManifest;
  if (
    ![1, 2].includes(manifest.version) ||
    !Array.isArray(manifest.parts) ||
    manifest.parts.length === 0 ||
    (manifest.version === 2 && manifest.parts.some((part) => !/^[a-f0-9]{64}$/.test(part.sha256 ?? "")))
  ) return null;
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
