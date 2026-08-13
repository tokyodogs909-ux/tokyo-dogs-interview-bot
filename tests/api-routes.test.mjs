import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

// vinext evaluates the worker module at import time. Set a non-secret fixture
// before that import so server-side credential helpers are testable regardless of
// whether the bundler reads process.env lazily or snapshots it during evaluation.
process.env.OPENAI_API_KEY = "test-key-never-returned";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("api-test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

const workerEnv = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const workerContext = {
  waitUntil() {},
  passThroughOnException() {},
};

function request(path, init, env = workerEnv) {
  return worker.fetch(new Request(`http://localhost${path}`, init), env, workerContext);
}

function scheduleInterviewRecovery(env) {
  let scheduledWork = null;
  worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env, {
    waitUntil(promise) {
      scheduledWork = promise;
    },
    passThroughOnException() {},
  });
  assert.ok(scheduledWork instanceof Promise);
  return scheduledWork;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function captureConsoleWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    return { value: await callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

class FakeD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    let changes = 0;
    if (this.sql.startsWith("INSERT INTO interview_sessions")) {
      const [id, accessTokenHash, candidateName, employment, preferredLocation, consentVersion,
        consentedAt, expiresAt, retentionUntil, createdAt, updatedAt] = this.values;
      if (this.sql.includes("WHERE EXISTS")) {
        const [nonceHash, comparedAt] = this.values.slice(11);
        const invite = this.database.invites.get(nonceHash);
        if (!invite || invite.used_at !== null || invite.expires_at <= comparedAt) {
          return { success: true, meta: { changes: 0 } };
        }
      }
      this.database.sessions.set(id, {
        id,
        access_token_hash: accessTokenHash,
        candidate_name: candidateName,
        employment,
        preferred_location: preferredLocation,
        consent_version: consentVersion,
        consented_at: consentedAt,
        status: "created",
        recording_status: "not_started",
        expires_at: expiresAt,
        retention_until: retentionUntil,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      changes = 1;
    } else if (this.sql.startsWith("INSERT INTO interview_invites")) {
      const [nonceHash, expiresAt] = this.values;
      this.database.invites.set(nonceHash, {
        nonce_hash: nonceHash,
        expires_at: expiresAt,
        used_at: null,
        session_id: null,
      });
      changes = 1;
    } else if (this.sql.startsWith("INSERT INTO interview_public_entries")) {
      const [id, sourceHash, candidateHash, createdAt, sourceToCount, sourceCutoff, sourceLimit,
        candidateToCount, candidateCutoff, candidateLimit, globalCutoff, globalLimit] = this.values;
      const sourceCount = this.database.publicEntries.filter((entry) =>
        entry.source_hash === sourceToCount && entry.created_at > sourceCutoff).length;
      const candidateCount = this.database.publicEntries.filter((entry) =>
        entry.candidate_hash === candidateToCount && entry.created_at > candidateCutoff).length;
      const globalCount = this.database.publicEntries.filter((entry) => entry.created_at > globalCutoff).length;
      if (sourceCount < sourceLimit && candidateCount < candidateLimit && globalCount < globalLimit) {
        this.database.publicEntries.push({
          id,
          source_hash: sourceHash,
          candidate_hash: candidateHash,
          created_at: createdAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("DELETE FROM interview_public_entries")) {
      const [staleBefore] = this.values;
      const previousLength = this.database.publicEntries.length;
      this.database.publicEntries = this.database.publicEntries.filter((entry) => entry.created_at > staleBefore);
      changes = previousLength - this.database.publicEntries.length;
    } else if (this.sql.startsWith("UPDATE interview_invites SET used_at")) {
      const [usedAt, sessionId, nonceHash, comparedAt] = this.values;
      const invite = this.database.invites.get(nonceHash);
      if (invite && invite.used_at === null && invite.expires_at > comparedAt) {
        invite.used_at = usedAt;
        invite.session_id = sessionId;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_invites SET session_id")) {
      const [sessionId, nonceHash] = this.values;
      const invite = this.database.invites.get(nonceHash);
      if (invite?.used_at) {
        invite.session_id = sessionId;
        changes = 1;
      }
    } else if (this.sql.startsWith("INSERT INTO interview_artifacts")) {
      this.database.artifacts.push(this.values);
      changes = 1;
    } else if (this.sql.startsWith("INSERT OR IGNORE INTO recorded_answer_transcriptions")) {
      const [sessionId, answerIndex, objectKey, contentType, byteSize, audioSha256,
        createdAt, updatedAt] = this.values;
      const key = `${sessionId}:${answerIndex}`;
      if (!this.database.recordedAnswers.has(key)) {
        this.database.recordedAnswers.set(key, {
          session_id: sessionId,
          answer_index: answerIndex,
          object_key: objectKey,
          content_type: contentType,
          byte_size: byteSize,
          audio_sha256: audioSha256,
          etag: null,
          status: "pending",
          transcript_text: null,
          claim_id: null,
          claimed_at: null,
          attempt_count: 0,
          last_error_code: null,
          next_retry_at: null,
          created_at: createdAt,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("INSERT OR IGNORE INTO recorded_interview_completions")) {
      const [sessionId, expectedAnswerCount, requestedAt, createdAt, updatedAt] = this.values;
      if (!this.database.recordedCompletions.has(sessionId)) {
        this.database.recordedCompletions.set(sessionId, {
          session_id: sessionId,
          expected_answer_count: expectedAnswerCount,
          requested_at: requestedAt,
          created_at: createdAt,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE recorded_answer_transcriptions SET etag")) {
      const [etag, updatedAt, sessionId, answerIndex, audioSha256] = this.values;
      const answer = this.database.recordedAnswers.get(`${sessionId}:${answerIndex}`);
      if (answer?.audio_sha256 === audioSha256) {
        answer.etag = etag;
        answer.updated_at = updatedAt;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE recorded_answer_transcriptions SET status = 'processing'")) {
      const [claimId, claimedAt, updatedAt, sessionId, answerIndex, staleBefore] = this.values;
      const answer = this.database.recordedAnswers.get(`${sessionId}:${answerIndex}`);
      if (answer && (
        answer.status === "pending" ||
        (answer.status === "processing" && answer.claimed_at < staleBefore)
      )) {
        Object.assign(answer, {
          status: "processing",
          claim_id: claimId,
          claimed_at: claimedAt,
          attempt_count: answer.attempt_count + 1,
          last_error_code: null,
          next_retry_at: null,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE recorded_answer_transcriptions SET status = 'pending'")) {
      const [errorCode, nextRetryAt, updatedAt, sessionId, answerIndex, claimId] = this.values;
      const answer = this.database.recordedAnswers.get(`${sessionId}:${answerIndex}`);
      if (answer?.status === "processing" && answer.claim_id === claimId) {
        Object.assign(answer, {
          status: "pending",
          claim_id: null,
          claimed_at: null,
          last_error_code: errorCode,
          next_retry_at: nextRetryAt,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE recorded_answer_transcriptions SET status = 'failed'")) {
      const [errorCode, updatedAt, sessionId, answerIndex, claimId] = this.values;
      const answer = this.database.recordedAnswers.get(`${sessionId}:${answerIndex}`);
      if (answer?.status === "processing" && answer.claim_id === claimId) {
        Object.assign(answer, {
          status: "failed",
          claim_id: null,
          claimed_at: null,
          last_error_code: errorCode,
          next_retry_at: null,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE recorded_answer_transcriptions SET status = 'completed'")) {
      const [transcriptText, updatedAt, sessionId, answerIndex, claimId] = this.values;
      const answer = this.database.recordedAnswers.get(`${sessionId}:${answerIndex}`);
      if (answer?.status === "processing" && answer.claim_id === claimId) {
        Object.assign(answer, {
          status: "completed",
          transcript_text: transcriptText,
          claim_id: null,
          claimed_at: null,
          last_error_code: null,
          next_retry_at: null,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("INSERT INTO interview_external_syncs")) {
      const [sessionId, requestedAt, updatedAt] = this.values;
      const current = this.database.externalSyncs.get(sessionId);
      const stillRunning = current?.status === "running";
      this.database.externalSyncs.set(sessionId, {
        provider: "google_drive",
        status: stillRunning ? "running" : "pending",
        requested_at: requestedAt,
        started_at: current?.started_at ?? null,
        completed_at: current?.completed_at ?? null,
        folder_id: current?.folder_id ?? null,
        folder_url: current?.folder_url ?? null,
        manifest_json: current?.manifest_json ?? null,
        error_code: current?.error_code ?? null,
        // A running claim keeps its own heartbeat; only a settled row is refreshed.
        updated_at: stillRunning ? current.updated_at : updatedAt,
      });
      changes = 1;
    } else if (this.sql.startsWith("UPDATE interview_external_syncs SET updated_at")) {
      const [updatedAt, sessionId, expectedStartedAt] = this.values;
      const sync = this.database.externalSyncs.get(sessionId);
      if (sync?.status === "running" && sync.started_at === expectedStartedAt) {
        sync.updated_at = updatedAt;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_external_syncs SET status = 'running'")) {
      const [startedAt, updatedAt, sessionId] = this.values;
      const sync = this.database.externalSyncs.get(sessionId);
      if (sync?.status === "pending") {
        Object.assign(sync, {
          status: "running",
          started_at: startedAt,
          completed_at: null,
          error_code: null,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_external_syncs SET status = 'pending'")) {
      const [updatedAt, sessionId, staleBefore] = this.values;
      const sync = this.database.externalSyncs.get(sessionId);
      if (sync?.status === "running" && sync.started_at && sync.updated_at <= staleBefore) {
        Object.assign(sync, {
          status: "pending",
          started_at: null,
          completed_at: null,
          error_code: null,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_external_syncs SET status = CASE")) {
      const [startedAtForStatus, , completedAt, folderId, folderUrl, manifestJson,
        updatedAt, sessionId, expectedStartedAt] = this.values;
      const sync = this.database.externalSyncs.get(sessionId);
      if (sync?.started_at === expectedStartedAt) {
        const retry = sync.requested_at > startedAtForStatus;
        Object.assign(sync, {
          status: retry ? "pending" : "completed",
          completed_at: retry ? null : completedAt,
          folder_id: folderId,
          folder_url: folderUrl,
          manifest_json: manifestJson,
          error_code: null,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_external_syncs SET status = 'failed'")) {
      const [errorCode, updatedAt, sessionId, expectedStartedAt] = this.values;
      const sync = this.database.externalSyncs.get(sessionId);
      if (sync?.started_at === expectedStartedAt) {
        Object.assign(sync, { status: "failed", error_code: errorCode, updated_at: updatedAt });
        changes = 1;
      }
    } else if (this.sql.startsWith("INSERT INTO interview_drive_upload_steps")) {
      const [sessionId, startedAt, uploadUrlCiphertext, uploadUrlIv, totalBytes,
        contentType, recordingName, folderId, folderUrl, contextJson, createdAt, updatedAt] = this.values;
      this.database.driveUploadSteps.set(sessionId, {
        session_id: sessionId,
        started_at: startedAt,
        phase: "uploading",
        upload_url_ciphertext: uploadUrlCiphertext,
        upload_url_iv: uploadUrlIv,
        committed_offset: 0,
        total_bytes: totalBytes,
        content_type: contentType,
        recording_name: recordingName,
        folder_id: folderId,
        folder_url: folderUrl,
        context_json: contextJson,
        recording_file_json: null,
        lease_token: null,
        lease_expires_at: null,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      changes = 1;
    } else if (this.sql.startsWith("UPDATE interview_drive_upload_steps SET lease_token = ?, lease_expires_at")) {
      const [leaseToken, leaseExpiresAt, updatedAt, sessionId, startedAt, now] = this.values;
      const step = this.database.driveUploadSteps.get(sessionId);
      if (step?.started_at === startedAt && (!step.lease_token || !step.lease_expires_at || step.lease_expires_at <= now)) {
        Object.assign(step, { lease_token: leaseToken, lease_expires_at: leaseExpiresAt, updated_at: updatedAt });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_drive_upload_steps SET committed_offset")) {
      const [committedOffset, phase, replaceMarker, recordingFileJson,
        uploadUrlCiphertext, uploadUrlIv, releaseLease, , updatedAt,
        sessionId, startedAt, leaseToken] = this.values;
      const step = this.database.driveUploadSteps.get(sessionId);
      if (step?.started_at === startedAt && step.lease_token === leaseToken) {
        step.committed_offset = committedOffset;
        if (phase) step.phase = phase;
        if (replaceMarker) step.recording_file_json = recordingFileJson;
        if (uploadUrlCiphertext) step.upload_url_ciphertext = uploadUrlCiphertext;
        if (uploadUrlIv) step.upload_url_iv = uploadUrlIv;
        if (releaseLease === 1) {
          step.lease_token = null;
          step.lease_expires_at = null;
        }
        step.updated_at = updatedAt;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_drive_upload_steps SET lease_token = NULL")) {
      const [updatedAt, sessionId, startedAt, leaseToken] = this.values;
      const step = this.database.driveUploadSteps.get(sessionId);
      if (step?.started_at === startedAt && step.lease_token === leaseToken) {
        Object.assign(step, { lease_token: null, lease_expires_at: null, updated_at: updatedAt });
        changes = 1;
      }
    } else if (this.sql.startsWith("DELETE FROM interview_drive_upload_steps")) {
      const [sessionId, startedAt] = this.values;
      const step = this.database.driveUploadSteps.get(sessionId);
      if (step?.started_at === startedAt) {
        this.database.driveUploadSteps.delete(sessionId);
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_sessions SET recording_status = 'uploading'")) {
      const [updatedAt, id, staleBefore] = this.values;
      const session = this.database.sessions.get(id);
      if (session && (
        ["not_started", "failed"].includes(session.recording_status) ||
        (session.recording_status === "uploading" && session.updated_at < staleBefore)
      )) {
        session.recording_status = "uploading";
        session.updated_at = updatedAt;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_sessions SET recording_status = 'failed'")) {
      const [updatedAt, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session && ["uploading", "failed"].includes(session.recording_status)) {
        session.recording_status = "failed";
        session.updated_at = updatedAt;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_sessions SET updated_at = ? WHERE id = ? AND recording_status IN ('uploading', 'failed')")) {
      const [updatedAt, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session && ["uploading", "failed"].includes(session.recording_status)) {
        session.updated_at = updatedAt;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_sessions SET recording_status = 'stored'")) {
      const [updatedAt, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session) {
        session.recording_status = "stored";
        session.updated_at = updatedAt;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_sessions SET transcript_json = ?")) {
      const [transcriptJson, updatedAt, sessionId, comparedTranscriptJson,
        fallbackSessionId, sealSessionId] = this.values;
      const session = this.database.sessions.get(sessionId);
      const fallbackStarted = this.database.auditEvents.some((event) =>
        event.session_id === fallbackSessionId && event.event_type === "recorded_fallback_started");
      const alreadySealed = this.database.auditEvents.some((event) =>
        event.session_id === sealSessionId && event.event_type === "voice_transcript_sealed");
      if (
        session &&
        ["in_progress", "evaluation_pending", "evaluation_processing"].includes(session.status) &&
        (session.transcript_json == null || session.transcript_json === comparedTranscriptJson) &&
        !fallbackStarted &&
        !alreadySealed
      ) {
        session.transcript_json = transcriptJson;
        session.updated_at = updatedAt;
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_sessions SET status = 'in_progress'")) {
      const [updatedAt, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session && ["created", "in_progress"].includes(session.status)) {
        session.status = "in_progress";
        if (this.sql.includes("recording_status = 'not_applicable'")) {
          session.recording_status = "not_applicable";
        }
        session.updated_at = updatedAt;
        changes = 1;
      }
    } else if (this.sql.startsWith("INSERT INTO interview_evaluation_claims")) {
      const [claimId, startedAt, createdAt, updatedAt, sessionId, staleBefore] = this.values;
      const session = this.database.sessions.get(sessionId);
      const current = this.database.evaluationClaims.get(sessionId);
      const eligible = session && (
        ["in_progress", "evaluation_pending"].includes(session.status) ||
        (session.status === "evaluation_processing" && (
          (current?.started_at && current.started_at <= staleBefore) ||
          (!current && session.updated_at <= staleBefore)
        ))
      );
      if (eligible && (!current || current.started_at <= staleBefore)) {
        this.database.evaluationClaims.set(sessionId, {
          session_id: sessionId,
          claim_id: claimId,
          started_at: startedAt,
          created_at: current?.created_at ?? createdAt,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("DELETE FROM interview_evaluation_claims")) {
      const [sessionId, claimId] = this.values;
      const current = this.database.evaluationClaims.get(sessionId);
      const completedAt = this.values[3];
      const session = this.database.sessions.get(sessionId);
      const completionFencePassed = completedAt === undefined || session?.completed_at === completedAt;
      if (current?.claim_id === claimId && completionFencePassed) {
        this.database.evaluationClaims.delete(sessionId);
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_sessions SET status = 'evaluation_processing'")) {
      const [transcriptJson, updatedAt, id, claimSessionId, claimId, sealSessionId, sealedTranscriptJson] = this.values;
      const session = this.database.sessions.get(id);
      const claim = this.database.evaluationClaims.get(claimSessionId);
      const voiceSealed = this.database.auditEvents.some((event) =>
        event.session_id === sealSessionId && event.event_type === "voice_transcript_sealed");
      if (session && claim?.claim_id === claimId &&
        ["in_progress", "evaluation_pending", "evaluation_processing"].includes(session.status) &&
        (!voiceSealed || session.transcript_json === sealedTranscriptJson)) {
        Object.assign(session, {
          status: "evaluation_processing",
          transcript_json: transcriptJson,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (
      this.sql.startsWith("UPDATE interview_sessions SET status = 'evaluation_pending'") &&
      this.sql.includes("WHERE id = ? AND status = 'evaluation_processing'")
    ) {
      const [updatedAt, id, claimSessionId] = this.values;
      const session = this.database.sessions.get(id);
      if (session?.status === "evaluation_processing" &&
        !this.database.evaluationClaims.has(claimSessionId)) {
        Object.assign(session, {
          status: "evaluation_pending",
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("UPDATE interview_sessions SET status = 'evaluation_pending'")) {
      const [transcriptJson, updatedAt, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session) Object.assign(session, { status: "evaluation_pending", transcript_json: transcriptJson, updated_at: updatedAt });
    } else if (this.sql.startsWith("UPDATE interview_sessions SET status = 'completed'")) {
      const [transcriptJson, evaluationJson, summary, completedAt, updatedAt, id,
        claimSessionId, claimId, sealSessionId, sealedTranscriptJson] = this.values;
      const session = this.database.sessions.get(id);
      const claim = this.database.evaluationClaims.get(claimSessionId);
      const voiceSealed = this.database.auditEvents.some((event) =>
        event.session_id === sealSessionId && event.event_type === "voice_transcript_sealed");
      if (session?.status === "evaluation_processing" && claim?.claim_id === claimId &&
        (!voiceSealed || session.transcript_json === sealedTranscriptJson)) {
        Object.assign(session, {
          status: "completed",
          transcript_json: transcriptJson,
          evaluation_json: evaluationJson,
          summary,
          completed_at: completedAt,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (this.sql.startsWith("INSERT INTO interview_human_reviews")) {
      const [, sessionId, reviewerName, videoScoresJson, overallNote, , updatedAt] = this.values;
      this.database.humanReviews.set(`${sessionId}:${reviewerName}`, {
        reviewer_name: reviewerName,
        video_scores_json: videoScoresJson,
        overall_note: overallNote,
        updated_at: updatedAt,
      });
    } else if (
      this.sql.startsWith("INSERT INTO interview_audit_events") &&
      this.sql.includes("'voice_transcript_sealed'")
    ) {
      const [, detailJson, sessionId, transcriptJson] = this.values;
      const session = this.database.sessions.get(sessionId);
      const fallbackStarted = this.database.auditEvents.some((event) =>
        event.session_id === sessionId && event.event_type === "recorded_fallback_started");
      const alreadySealed = this.database.auditEvents.some((event) =>
        event.session_id === sessionId && event.event_type === "voice_transcript_sealed");
      if (
        session &&
        ["in_progress", "evaluation_pending", "evaluation_processing"].includes(session.status) &&
        session.transcript_json === transcriptJson &&
        !fallbackStarted &&
        !alreadySealed
      ) {
        this.database.auditEvents.push({
          event_type: "voice_transcript_sealed",
          detail_json: detailJson,
          created_at: new Date().toISOString(),
          session_id: sessionId,
        });
        changes = 1;
      }
    } else if (
      this.sql.startsWith("INSERT INTO interview_audit_events") &&
      this.sql.includes("'recorded_fallback_started'")
    ) {
      const [, sessionId, existingSessionId, checkedSessionId] = this.values;
      const exists = this.database.sessions.has(existingSessionId);
      const alreadyStarted = this.database.auditEvents.some((event) =>
        event.session_id === checkedSessionId && event.event_type === "recorded_fallback_started");
      if (exists && !alreadyStarted) {
        this.database.auditEvents.push({
          event_type: "recorded_fallback_started",
          detail_json: "{}",
          created_at: new Date().toISOString(),
          session_id: sessionId,
        });
        changes = 1;
      }
    } else if (
      this.sql.startsWith("INSERT INTO interview_audit_events") &&
      this.sql.includes("SELECT ?, ?, 'interview_started'")
    ) {
      const [, sessionId, existingSessionId] = this.values;
      if (this.database.sessions.has(existingSessionId)) {
        this.database.auditEvents.push({
          event_type: "interview_started",
          detail_json: "{}",
          created_at: new Date().toISOString(),
          session_id: sessionId,
        });
        changes = 1;
      }
    } else if (
      this.sql.startsWith("INSERT INTO interview_audit_events") &&
      this.sql.includes("'realtime_connection_reserved'")
    ) {
      const [, sessionId, detailJson, sessionToCount, limit] = this.values;
      const attempts = this.database.auditEvents.filter((event) =>
        event.session_id === sessionToCount && event.event_type === "realtime_connection_reserved").length;
      if (attempts < limit) {
        this.database.auditEvents.push({
          event_type: "realtime_connection_reserved",
          detail_json: detailJson,
          created_at: new Date().toISOString(),
          session_id: sessionId,
        });
        changes = 1;
      }
    } else if (
      this.sql.startsWith("INSERT INTO interview_audit_events") &&
      this.sql.includes("'reasonable_accommodation_text_selected'")
    ) {
      const [, sessionId, detailJson] = this.values;
      this.database.auditEvents.push({
        event_type: "reasonable_accommodation_text_selected",
        detail_json: detailJson,
        created_at: new Date().toISOString(),
        session_id: sessionId,
      });
      changes = 1;
    } else if (
      this.sql.startsWith("INSERT INTO interview_audit_events") &&
      this.sql.includes("'transcription_failed', 'system'")
    ) {
      const [, sessionId, detailJson] = this.values;
      this.database.auditEvents.push({
        event_type: "transcription_failed",
        detail_json: detailJson,
        created_at: new Date().toISOString(),
        session_id: sessionId,
      });
      changes = 1;
    } else if (
      this.sql.startsWith("INSERT INTO interview_audit_events") &&
      this.sql.includes("VALUES (?, ?, ?, 'candidate', ?)")
    ) {
      const [, sessionId, eventType, detailJson] = this.values;
      this.database.auditEvents.push({
        event_type: eventType,
        detail_json: detailJson,
        created_at: new Date().toISOString(),
        session_id: sessionId,
      });
    } else if (this.sql.startsWith("INSERT INTO interview_staff_audit_events")) {
      const [, reviewerName, detailJson] = this.values;
      this.database.staffAuditEvents.push({
        reviewer_name: reviewerName,
        event_type: "interview_list_opened",
        detail_json: detailJson,
        created_at: new Date().toISOString(),
      });
      changes = 1;
    } else if (this.sql.startsWith("INSERT INTO google_drive_connection")) {
      const [ciphertext, iv, scope, createdAt, updatedAt] = this.values;
      this.database.driveConnection = {
        refresh_token_ciphertext: ciphertext,
        refresh_token_iv: iv,
        root_folder_id: this.database.driveConnection?.root_folder_id ?? null,
        root_folder_name: this.database.driveConnection?.root_folder_name ?? null,
        root_folder_url: this.database.driveConnection?.root_folder_url ?? null,
        scope,
        created_at: this.database.driveConnection?.created_at ?? createdAt,
        updated_at: updatedAt,
      };
      changes = 1;
    } else if (this.sql.startsWith("UPDATE google_drive_connection SET")) {
      if (this.database.driveConnection) {
        const [folderId, folderName, folderUrl, updatedAt] = this.values;
        Object.assign(this.database.driveConnection, {
          root_folder_id: folderId,
          root_folder_name: folderName,
          root_folder_url: folderUrl,
          updated_at: updatedAt,
        });
        changes = 1;
      }
    }
    return { success: true, meta: { changes } };
  }

  async first() {
    if (this.sql.startsWith("SELECT s.status AS session_status")) {
      const sessionId = this.values[0];
      const session = this.database.sessions.get(sessionId);
      if (!session) return null;
      const artifact = this.database.artifacts.find((item) =>
        item[1] === sessionId && item[2] && item[3] && Number.isFinite(Number(item[4])));
      const sync = this.database.externalSyncs.get(sessionId);
      const step = this.database.driveUploadSteps.get(sessionId);
      const candidateTranscriptionFailed = this.database.auditEvents.some((event) => {
        if (event.session_id !== sessionId || event.event_type !== "transcription_failed") return false;
        try {
          return JSON.parse(event.detail_json ?? "{}").code === "TRANSCRIPTION_FAILED";
        } catch {
          return false;
        }
      });
      return {
        session_status: session.status,
        recording_status: session.recording_status,
        transcript_json: session.transcript_json ?? null,
        candidate_transcription_failed: candidateTranscriptionFailed ? 1 : 0,
        recording_byte_size: artifact ? Number(artifact[4]) : null,
        drive_status: sync?.status ?? null,
        drive_manifest_json: sync?.manifest_json ?? null,
        drive_error_code: sync?.error_code ?? null,
        drive_step_phase: step?.phase ?? null,
        drive_committed_offset: step?.committed_offset ?? null,
        drive_total_bytes: step?.total_bytes ?? null,
      };
    }
    if (this.sql.startsWith("SELECT s.status, s.transcript_json,")) {
      const session = this.database.sessions.get(this.values[0]);
      if (!session) return null;
      return {
        status: session.status,
        transcript_json: session.transcript_json ?? null,
        voice_transcript_sealed: this.database.auditEvents.some((event) =>
          event.session_id === session.id && event.event_type === "voice_transcript_sealed") ? 1 : 0,
      };
    }
    if (this.sql.startsWith("SELECT EXISTS ( SELECT 1 FROM recorded_interview_completions")) {
      const sessionId = this.values[0];
      const session = this.database.sessions.get(sessionId);
      const transcriptHasCandidate = (() => {
        try {
          return JSON.parse(session?.transcript_json ?? "[]").some((turn) =>
            turn?.speaker === "candidate" && typeof turn.text === "string" && turn.text.trim());
        } catch {
          return false;
        }
      })();
      const fallbackStarted = this.database.auditEvents.some((event) =>
        event.session_id === sessionId && event.event_type === "recorded_fallback_started");
      const voiceSealed = this.database.auditEvents.some((event) =>
        event.session_id === sessionId && event.event_type === "voice_transcript_sealed");
      return session ? {
        recorded_fallback_sealed: this.database.recordedCompletions.has(sessionId) ? 1 : 0,
        voice_transcript_sealed: voiceSealed && !fallbackStarted && transcriptHasCandidate ? 1 : 0,
      } : null;
    }
    if (this.sql.startsWith("SELECT s.id, s.transcript_json FROM interview_sessions")) {
      const [staleBefore, legacyStaleBefore, pendingStaleBefore] = this.values;
      return [...this.database.sessions.values()]
        .filter((session) => {
          const claim = this.database.evaluationClaims.get(session.id);
          if (
            !((session.status === "evaluation_processing" &&
              ((claim?.started_at && claim.started_at <= staleBefore) ||
                (!claim && session.updated_at <= legacyStaleBefore))) ||
              (session.status === "evaluation_pending" && !claim &&
                session.updated_at <= pendingStaleBefore) ||
              (session.status === "in_progress" && session.recording_status === "stored" && !claim &&
                this.database.auditEvents.some((event) =>
                  event.session_id === session.id && event.event_type === "voice_transcript_sealed"))) ||
            typeof session.transcript_json !== "string"
          ) return false;
          try {
            const transcript = JSON.parse(session.transcript_json);
            if (!Array.isArray(transcript)) return false;
            const candidateTurns = transcript.slice(0, 300).filter((turn) =>
              turn?.speaker === "candidate" && typeof turn.id === "string" &&
              typeof turn.text === "string" && turn.text.trim());
            if (candidateTurns.length === 0 || candidateTurns.some((turn) =>
              turn.id.startsWith("recorded-fallback-answer-"))) return false;
            const realtimeGap = this.database.auditEvents.some((event) => {
              if (event.session_id !== session.id || event.event_type !== "transcription_failed") return false;
              try {
                return JSON.parse(event.detail_json ?? "{}").code === "TRANSCRIPTION_FAILED";
              } catch {
                return false;
              }
            });
            return !realtimeGap || candidateTurns.every((turn) =>
              turn.id.startsWith("recorded-transcribed-answer-"));
          } catch {
            return false;
          }
        })
        .sort((left, right) => {
          const leftStartedAt = this.database.evaluationClaims.get(left.id)?.started_at ?? left.updated_at;
          const rightStartedAt = this.database.evaluationClaims.get(right.id)?.started_at ?? right.updated_at;
          return leftStartedAt.localeCompare(rightStartedAt) || left.id.localeCompare(right.id);
        })
        .map((session) => ({ id: session.id, transcript_json: session.transcript_json }))[0] ?? null;
    }
    if (this.sql.startsWith("SELECT s.id FROM interview_sessions s WHERE s.recording_status IN")) {
      const [staleBefore, completedBefore] = this.values;
      return [...this.database.sessions.values()]
        .filter((session) => {
          let transcriptHasCandidate = false;
          try {
            transcriptHasCandidate = JSON.parse(session.transcript_json ?? "[]").some((turn) =>
              turn?.speaker === "candidate" && typeof turn.text === "string" && turn.text.trim());
          } catch {
            transcriptHasCandidate = false;
          }
          const fallbackStarted = this.database.auditEvents.some((event) =>
            event.session_id === session.id && event.event_type === "recorded_fallback_started");
          const voiceSealed = this.database.auditEvents.some((event) =>
            event.session_id === session.id && event.event_type === "voice_transcript_sealed");
          const hasSeal = this.database.recordedCompletions.has(session.id) ||
            (voiceSealed && !fallbackStarted && transcriptHasCandidate);
          const recoverableStatus = session.status === "completed"
            ? typeof session.completed_at === "string" && session.completed_at <= completedBefore
            : hasSeal && ["in_progress", "evaluation_pending", "evaluation_processing"].includes(session.status);
          return recoverableStatus &&
            ["uploading", "failed"].includes(session.recording_status) &&
            session.updated_at <= staleBefore;
        })
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((session) => ({ id: session.id }))[0] ?? null;
    }
    if (this.sql.startsWith("SELECT r.session_id, r.answer_index, r.object_key")) {
      const [now, staleBefore] = this.values;
      return [...this.database.recordedAnswers.values()]
        .filter((answer) => {
          const session = this.database.sessions.get(answer.session_id);
          if (!session || !["in_progress", "evaluation_pending", "evaluation_processing"].includes(session.status)) return false;
          if (session.recording_status !== "stored") return false;
          return (answer.status === "pending" && (!answer.next_retry_at || answer.next_retry_at <= now)) ||
            (answer.status === "processing" && (!answer.claimed_at || answer.claimed_at < staleBefore));
        })
        .sort((left, right) =>
          String(left.updated_at).localeCompare(String(right.updated_at)) ||
          left.session_id.localeCompare(right.session_id) ||
          left.answer_index - right.answer_index)[0] ?? null;
    }
    if (this.sql.startsWith("SELECT c.session_id, c.expected_answer_count")) {
      const [staleBefore, legacyStaleBefore] = this.values;
      return [...this.database.recordedCompletions.values()]
        .filter((completion) => {
          const session = this.database.sessions.get(completion.session_id);
          if (!session || !["in_progress", "evaluation_pending", "evaluation_processing"].includes(session.status)) return false;
          if (session.status === "evaluation_processing") {
            const claim = this.database.evaluationClaims.get(session.id);
            if (!((claim?.started_at && claim.started_at < staleBefore) ||
              (!claim && session.updated_at < legacyStaleBefore))) return false;
          }
          if (session.recording_status !== "stored") return false;
          const answers = [...this.database.recordedAnswers.values()]
            .filter((answer) => answer.session_id === completion.session_id);
          if (answers.some((answer) => answer.answer_index > completion.expected_answer_count)) return false;
          return Array.from({ length: completion.expected_answer_count }, (_, index) => answers.find((answer) =>
            answer.answer_index === index + 1 && answer.status === "completed" && answer.transcript_text?.trim())).every(Boolean);
        })
        .sort((left, right) => left.requested_at.localeCompare(right.requested_at) || left.session_id.localeCompare(right.session_id))[0] ?? null;
    }
    if (this.sql.startsWith("SELECT used_at, expires_at FROM interview_invites")) {
      const invite = this.database.invites.get(this.values[0]);
      return invite ? { used_at: invite.used_at, expires_at: invite.expires_at } : null;
    }
    if (this.sql.startsWith("SELECT id, access_token_hash")) {
      return this.database.sessions.get(this.values[0]) ?? null;
    }
    if (this.sql.startsWith("SELECT id, status, recording_status")) {
      const session = this.database.sessions.get(this.values[0]);
      return session ? {
        id: session.id,
        status: session.status,
        recording_status: session.recording_status,
        transcript_json: session.transcript_json ?? null,
      } : null;
    }
    if (this.sql.startsWith("SELECT id, candidate_name, employment, preferred_location")) {
      return this.database.sessions.get(this.values[0]) ?? null;
    }
    if (this.sql.startsWith("SELECT id FROM interview_sessions")) {
      const session = this.database.sessions.get(this.values[0]);
      return session ? { id: session.id } : null;
    }
    if (this.sql.startsWith("SELECT object_key, content_type, byte_size")) {
      const sessionId = this.values[0];
      const values = this.database.artifacts.find((item) => item[1] === sessionId);
      return values ? { object_key: values[2], content_type: values[3], byte_size: values[4] } : null;
    }
    if (this.sql.startsWith("SELECT provider, status, requested_at")) {
      return this.database.externalSyncs.get(this.values[0]) ?? null;
    }
    if (this.sql.startsWith("SELECT session_id, answer_index, object_key")) {
      return this.database.recordedAnswers.get(`${this.values[0]}:${this.values[1]}`) ?? null;
    }
    if (this.sql.startsWith("SELECT session_id, expected_answer_count, requested_at")) {
      return this.database.recordedCompletions.get(this.values[0]) ?? null;
    }
    if (this.sql.startsWith("SELECT session_id FROM recorded_interview_completions")) {
      const completion = this.database.recordedCompletions.get(this.values[0]);
      return completion ? { session_id: completion.session_id } : null;
    }
    if (this.sql.startsWith("SELECT session_id, started_at, phase")) {
      return this.database.driveUploadSteps.get(this.values[0]) ?? null;
    }
    if (this.sql.startsWith("SELECT refresh_token_ciphertext")) {
      return this.database.driveConnection;
    }
    return null;
  }

  async all() {
    if (this.sql.startsWith("PRAGMA table_info(interview_sessions)")) {
      return { results: [{ name: "candidate_name" }] };
    }
    if (this.sql.startsWith("SELECT reviewer_name, video_scores_json")) {
      const sessionId = this.values[0];
      return {
        results: [...this.database.humanReviews.entries()]
          .filter(([key]) => key.startsWith(`${sessionId}:`))
          .map(([, value]) => value),
      };
    }
    if (this.sql.startsWith("SELECT event_type, detail_json FROM interview_audit_events")) {
      return {
        results: this.database.auditEvents
          .filter((event) => event.session_id === this.values[0] && event.event_type === "transcription_failed")
          .map((event) => ({ event_type: event.event_type, detail_json: event.detail_json })),
      };
    }
    if (this.sql.startsWith("SELECT s.id FROM interview_sessions s WHERE s.recording_status IN")) {
      const [staleBefore, completedBefore] = this.values;
      return {
        results: [...this.database.sessions.values()]
          .filter((session) => {
            let transcriptHasCandidate = false;
            try {
              transcriptHasCandidate = JSON.parse(session.transcript_json ?? "[]").some((turn) =>
                turn?.speaker === "candidate" && typeof turn.text === "string" && turn.text.trim());
            } catch {
              transcriptHasCandidate = false;
            }
            const fallbackStarted = this.database.auditEvents.some((event) =>
              event.session_id === session.id && event.event_type === "recorded_fallback_started");
            const voiceSealed = this.database.auditEvents.some((event) =>
              event.session_id === session.id && event.event_type === "voice_transcript_sealed");
            const hasSeal = this.database.recordedCompletions.has(session.id) ||
              (voiceSealed && !fallbackStarted && transcriptHasCandidate);
            const recoverableStatus = session.status === "completed"
              ? typeof session.completed_at === "string" && session.completed_at <= completedBefore
              : hasSeal && ["in_progress", "evaluation_pending", "evaluation_processing"].includes(session.status);
            return recoverableStatus &&
              ["uploading", "failed"].includes(session.recording_status) &&
              session.updated_at <= staleBefore;
          })
          .sort((left, right) => {
            const updatedOrder = left.updated_at.localeCompare(right.updated_at);
            if (updatedOrder !== 0) return updatedOrder;
            const leftSeal = this.database.recordedCompletions.get(left.id)?.requested_at ??
              this.database.auditEvents.find((event) =>
                event.session_id === left.id && event.event_type === "voice_transcript_sealed")?.created_at ?? "";
            const rightSeal = this.database.recordedCompletions.get(right.id)?.requested_at ??
              this.database.auditEvents.find((event) =>
                event.session_id === right.id && event.event_type === "voice_transcript_sealed")?.created_at ?? "";
            return leftSeal.localeCompare(rightSeal) || left.id.localeCompare(right.id);
          })
          .slice(0, 10)
          .map((session) => ({ id: session.id })),
      };
    }
    if (this.sql.startsWith("SELECT s.id, s.transcript_json, EXISTS")) {
      const [failedBefore, pendingBefore] = this.values;
      return {
        results: [...this.database.sessions.values()]
          .filter((session) => {
            if (session.status !== "completed" || !["stored", "not_applicable"].includes(session.recording_status)) return false;
            let transcript;
            try {
              transcript = JSON.parse(session.transcript_json ?? "[]");
            } catch {
              return false;
            }
            if (!Array.isArray(transcript) || !transcript.some((turn) =>
              turn?.speaker === "candidate" && typeof turn.text === "string" && turn.text.trim())) return false;
            if (transcript.some((turn) => turn?.speaker === "candidate" &&
              String(turn.id ?? "").startsWith("recorded-fallback-answer-"))) return false;
            const sync = this.database.externalSyncs.get(session.id);
            if (!sync) return true;
            if (sync.status === "running") return true;
            if (sync.status === "failed") return sync.updated_at <= failedBefore;
            if (sync.status === "pending") return sync.updated_at <= pendingBefore;
            if (sync.status !== "completed") return false;
            let manifest;
            try {
              manifest = JSON.parse(sync.manifest_json ?? "{}");
            } catch {
              manifest = {};
            }
            return manifest.transcriptAvailable !== true || manifest.transcriptKind !== "actual_transcript" ||
              (session.recording_status === "stored" && manifest.recordingIncluded !== true);
          })
          .sort((left, right) => {
            const leftSync = this.database.externalSyncs.get(left.id);
            const rightSync = this.database.externalSyncs.get(right.id);
            const leftRunning = leftSync?.status === "running" ? 0 : 1;
            const rightRunning = rightSync?.status === "running" ? 0 : 1;
            return leftRunning - rightRunning ||
              String(leftSync?.updated_at ?? left.completed_at ?? left.created_at).localeCompare(
                String(rightSync?.updated_at ?? right.completed_at ?? right.created_at),
              ) || left.id.localeCompare(right.id);
          })
          .slice(0, 25)
          .map((session) => ({
            id: session.id,
            transcript_json: session.transcript_json,
            candidate_transcription_failed: this.database.auditEvents.some((event) =>
              event.session_id === session.id && event.event_type === "transcription_failed" &&
              JSON.parse(event.detail_json ?? "{}").code === "TRANSCRIPTION_FAILED") ? 1 : 0,
          })),
      };
    }
    if (this.sql.startsWith("SELECT s.id, s.candidate_name")) {
      const cursorProvided = this.values.length === 4;
      const cursorCreatedAt = cursorProvided ? this.values[0] : null;
      const cursorSessionId = cursorProvided ? this.values[2] : null;
      const limit = this.values.at(-1);
      return {
        results: [...this.database.sessions.values()]
          .filter((session) => !cursorProvided ||
            session.created_at < cursorCreatedAt ||
            (session.created_at === cursorCreatedAt && session.id < cursorSessionId))
          .sort((left, right) =>
            String(right.created_at).localeCompare(String(left.created_at)) || right.id.localeCompare(left.id))
          .slice(0, limit)
          .map((session) => {
            const sync = this.database.externalSyncs.get(session.id);
            return {
              id: session.id,
              candidate_name: session.candidate_name,
              employment: session.employment,
              preferred_location: session.preferred_location,
              status: session.status,
              recording_status: session.recording_status,
              transcript_json: session.transcript_json,
              candidate_transcription_failed: this.database.auditEvents.some((event) =>
                event.session_id === session.id &&
                event.event_type === "transcription_failed" &&
                JSON.parse(event.detail_json ?? "{}").code === "TRANSCRIPTION_FAILED") ? 1 : 0,
              created_at: session.created_at,
              completed_at: session.completed_at ?? null,
              retention_until: session.retention_until,
              drive_status: sync?.status ?? null,
              drive_folder_url: sync?.folder_url ?? null,
              drive_updated_at: sync?.updated_at ?? null,
              drive_manifest_json: sync?.manifest_json ?? null,
            };
          }),
      };
    }
    if (this.sql.startsWith("SELECT event_type, detail_json, created_at")) {
      const technicalEventTypes = new Set([
        "audio_playback_blocked", "transcription_failed", "recording_unavailable",
        "connection_failed", "candidate_requested_stop", "time_limit_reached",
        "reasonable_accommodation_text_selected",
      ]);
      return {
        results: this.database.auditEvents.filter((event) =>
          event.session_id === this.values[0] && technicalEventTypes.has(event.event_type)),
      };
    }
    if (this.sql.startsWith("SELECT answer_index, status, transcript_text")) {
      return {
        results: [...this.database.recordedAnswers.values()]
          .filter((answer) => answer.session_id === this.values[0])
          .sort((left, right) => left.answer_index - right.answer_index)
          .map((answer) => ({
            answer_index: answer.answer_index,
            status: answer.status,
            transcript_text: answer.transcript_text,
          })),
      };
    }
    if (this.sql.startsWith("SELECT r.session_id, r.answer_index, r.status, r.transcript_text")) {
      return {
        results: [...this.database.recordedAnswers.values()]
          .filter((answer) => {
            const session = this.database.sessions.get(answer.session_id);
            return session &&
              ["in_progress", "evaluation_pending", "evaluation_processing"].includes(session.status) &&
              session.recording_status === "stored";
          })
          .sort((left, right) =>
            String(left.updated_at).localeCompare(String(right.updated_at)) ||
            left.session_id.localeCompare(right.session_id) ||
            left.answer_index - right.answer_index)
          .slice(0, 300)
          .map((answer) => ({
            session_id: answer.session_id,
            answer_index: answer.answer_index,
            status: answer.status,
            transcript_text: answer.transcript_text,
          })),
      };
    }
    return { results: [] };
  }

}

class FakeD1 {
  constructor() {
    this.sessions = new Map();
    this.artifacts = [];
    this.humanReviews = new Map();
    this.auditEvents = [];
    this.staffAuditEvents = [];
    this.invites = new Map();
    this.publicEntries = [];
    this.externalSyncs = new Map();
    this.driveUploadSteps = new Map();
    this.evaluationClaims = new Map();
    this.recordedAnswers = new Map();
    this.recordedCompletions = new Map();
    this.driveConnection = null;
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class FakeR2 {
  constructor() {
    this.objects = new Map();
    this.putCount = 0;
    this.getCount = 0;
    this.headCount = 0;
  }

  async put(key, body, options) {
    this.putCount += 1;
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const bytes = body instanceof ReadableStream
      ? new Uint8Array(await new Response(body).arrayBuffer())
      : body instanceof Uint8Array
        ? Uint8Array.from(body)
        : body instanceof ArrayBuffer
          ? new Uint8Array(body.slice(0))
            : typeof body === "string"
              ? new TextEncoder().encode(body)
              : new Uint8Array(await new Response(body).arrayBuffer());
    if (options?.sha256 && sha256Hex(bytes) !== options.sha256) {
      throw new Error("R2_SHA256_MISMATCH");
    }
    this.objects.set(key, { body: bytes, options });
    return {
      etag: "test-etag",
      size: bytes.byteLength,
      customMetadata: options?.customMetadata ?? {},
      checksums: options?.sha256
        ? { sha256: Uint8Array.from(Buffer.from(options.sha256, "hex")).buffer }
        : {},
    };
  }

  async get(key, options = {}) {
    this.getCount += 1;
    const object = this.objects.get(key);
    if (!object) return null;
    const storedBytes = object.body instanceof Uint8Array
      ? object.body
      : new Uint8Array(await new Response(object.body).arrayBuffer());
    object.body = storedBytes;
    const offset = options.range?.offset ?? 0;
    const length = options.range?.length ?? (storedBytes.byteLength - offset);
    const bytes = storedBytes.slice(offset, offset + length);
    return {
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      etag: "test-etag",
      size: bytes.byteLength,
      customMetadata: object.options?.customMetadata ?? {},
    };
  }

  async head(key) {
    this.headCount += 1;
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      etag: "test-etag",
      size: object.body.byteLength,
      customMetadata: object.options?.customMetadata ?? {},
      checksums: object.options?.sha256
        ? { sha256: Uint8Array.from(Buffer.from(object.options.sha256, "hex")).buffer }
        : {},
    };
  }

}

async function createTestInterviewSession(
  env,
  employment = "正社員",
  location = "越谷店",
  options = {},
) {
  const response = await request("/api/interviews/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.connectingAddress ? { "CF-Connecting-IP": options.connectingAddress } : {}),
    },
    body: JSON.stringify({
      candidateName: options.candidateName ?? "テスト 応募者",
      employment,
      location,
      consent: true,
    }),
  }, env);
  assert.equal(response.status, 201);
  return response.json();
}

async function sealRecordedCompletion(env, session, expectedAnswerCount) {
  const response = await request("/api/interviews/recorded/seal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.sessionId, expectedAnswerCount }),
  }, env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.deepEqual(await response.json(), { sealed: true, expectedAnswerCount });
}

async function sealVoiceTranscript(env, session, transcript, transcriptionComplete = true) {
  return await request("/api/interviews/voice/transcript/seal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: session.sessionId,
      transcript,
      transcriptionComplete,
    }),
  }, env);
}

test("scheduled recovery runs a bounded global tick without staff browser authentication", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  let scheduledWork = null;
  const heartbeats = [];
  const originalInfo = console.info;
  console.info = (...args) => heartbeats.push(args);
  try {
    worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, {
      ...workerEnv,
      DB: database,
      RECORDINGS: recordings,
    }, {
      waitUntil(promise) {
        scheduledWork = promise;
      },
      passThroughOnException() {},
    });
    assert.ok(scheduledWork instanceof Promise);
    await scheduledWork;
  } finally {
    console.info = originalInfo;
  }
  assert.equal(database.staffAuditEvents.length, 0, "cron recovery must not impersonate or require a reviewer");
  assert.deepEqual(heartbeats, [["interview_background_recovery", {
    tick: "completed",
    states: {
      recording: "idle",
      transcription: "idle",
      completion: "idle",
      evaluation: "idle",
      drive: "idle",
    },
  }]]);
});

test("internal recovery fails closed without a dedicated strong bearer token", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  for (const token of ["", "x".repeat(42)]) {
    const response = await request("/api/internal/recovery", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, {
      ...workerEnv,
      DB: database,
      RECORDINGS: recordings,
      INTERVIEW_RECOVERY_TOKEN: token,
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Background recovery authentication is not configured.",
    });
  }
});

test("internal recovery rejects the wrong bearer and returns only aggregate states for the right one", async () => {
  const recoveryToken = "recovery-token-never-returned-0123456789abcdef";
  assert.ok(recoveryToken.length >= 43);
  const privateSessionId = "TD-PRIVATE-SESSION";
  const privateCandidateMarker = "PRIVATE-CANDIDATE-MARKER";
  const database = new FakeD1();
  database.sessions.set(privateSessionId, {
    id: privateSessionId,
    candidate_name: privateCandidateMarker,
    status: "created",
    recording_status: "not_started",
    transcript_json: null,
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
  });
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_RECOVERY_TOKEN: recoveryToken,
  };

  const unauthorized = await request("/api/internal/recovery", {
    method: "POST",
    headers: { Authorization: `Bearer ${"z".repeat(43)}` },
  }, env);
  assert.equal(unauthorized.status, 401);
  const unauthorizedText = await unauthorized.text();
  assert.deepEqual(JSON.parse(unauthorizedText), {
    error: "Background recovery authentication failed.",
  });

  const logs = [];
  const originals = {
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.info = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  let authorized;
  try {
    authorized = await request("/api/internal/recovery", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${recoveryToken}`,
        "Content-Type": "application/json",
        "Content-Length": "2",
      },
      body: "{}",
    }, env);
  } finally {
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
  }

  assert.equal(authorized.status, 200);
  assert.match(authorized.headers.get("cache-control") ?? "", /no-store/);
  const authorizedText = await authorized.text();
  assert.deepEqual(JSON.parse(authorizedText), {
    tick: "completed",
    states: {
      recording: "idle",
      transcription: "idle",
      completion: "idle",
      evaluation: "idle",
      drive: "idle",
    },
  });
  const observableOutput = `${unauthorizedText}\n${authorizedText}\n${JSON.stringify(logs)}`;
  assert.equal(observableOutput.includes(recoveryToken), false);
  assert.equal(observableOutput.includes(privateSessionId), false);
  assert.equal(observableOutput.includes(privateCandidateMarker), false);

  const invalidContentType = await request("/api/internal/recovery", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${recoveryToken}`,
      "Content-Type": "text/plain",
      "Content-Length": "2",
    },
    body: "{}",
  }, env);
  assert.equal(invalidContentType.status, 415);

  const oversizedBody = " ".repeat(65);
  const oversized = await request("/api/internal/recovery", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${recoveryToken}`,
      "Content-Type": "application/json",
      "Content-Length": String(oversizedBody.length),
    },
    body: oversizedBody,
  }, env);
  assert.equal(oversized.status, 413);
});

test("manual transcript draft uses only its dedicated strong URL-safe bearer token", async () => {
  const syntheticSessionIds = [
    "TD-TEST0001-SESS001",
    "TD-TEST0002-SESS002",
    "TD-TEST0003-SESS003",
  ];
  const sessionAllowlist = syntheticSessionIds.join(",");
  const audio = new Uint8Array([1, 2, 3]);
  const requestHeaders = {
    "Content-Type": "audio/mpeg",
    "Content-Length": String(audio.byteLength),
    "X-Interview-Session-Id": syntheticSessionIds[0],
    "X-Interview-Audio-Sha256": sha256Hex(audio),
    "X-Interview-Audio-Index": "1",
  };

  for (const token of [undefined, "x".repeat(42), `${"x".repeat(42)}.`]) {
    const response = await request("/api/internal/manual-transcript-draft", {
      method: "POST",
      headers: {
        ...requestHeaders,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: audio,
    }, {
      ...workerEnv,
      INTERVIEW_RECOVERY_TOKEN: "recovery-token-must-not-authorize-this-route-0123456789",
      INTERVIEW_MANUAL_REPAIR_SESSION_IDS: sessionAllowlist,
      ...(token ? { INTERVIEW_MANUAL_REPAIR_TOKEN: token } : {}),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: "manual_repair_authentication_unconfigured" },
    });
  }

  const repairToken = "manual_repair_token_never_returned_0123456789abcdef";
  let paidCalls = 0;
  for (const invalidAllowlist of [
    undefined,
    syntheticSessionIds.slice(0, 2).join(","),
    [syntheticSessionIds[0], syntheticSessionIds[0], syntheticSessionIds[2]].join(","),
    [syntheticSessionIds[0], "INVALID", syntheticSessionIds[2]].join(","),
  ]) {
    const response = await request("/api/internal/manual-transcript-draft", {
      method: "POST",
      headers: { Authorization: `Bearer ${repairToken}` },
    }, {
      ...workerEnv,
      INTERVIEW_MANUAL_REPAIR_TOKEN: repairToken,
      ...(invalidAllowlist ? { INTERVIEW_MANUAL_REPAIR_SESSION_IDS: invalidAllowlist } : {}),
      OPENAI_API: { fetch: async () => {
        paidCalls += 1;
        throw new Error("MUST_NOT_RUN");
      } },
    });
    assert.equal(response.status, 503);
    const responseText = await response.text();
    assert.deepEqual(JSON.parse(responseText), {
      error: { code: "manual_repair_authentication_unconfigured" },
    });
    assert.equal(responseText.includes(syntheticSessionIds[0]), false);
  }
  assert.equal(paidCalls, 0);

  const wrongBearer = await request("/api/internal/manual-transcript-draft", {
    method: "POST",
    headers: {
      ...requestHeaders,
      Authorization: `Bearer ${"z".repeat(43)}`,
    },
    body: audio,
  }, {
    ...workerEnv,
    INTERVIEW_MANUAL_REPAIR_TOKEN: repairToken,
    INTERVIEW_MANUAL_REPAIR_SESSION_IDS: sessionAllowlist,
  });
  assert.equal(wrongBearer.status, 401);
  assert.equal((await wrongBearer.text()).includes(repairToken), false);
});

test("manual transcript draft validates the exact session, audio headers, body size, and digest before paid work", async () => {
  const syntheticSessionIds = [
    "TD-TEST0001-SESS001",
    "TD-TEST0002-SESS002",
    "TD-TEST0003-SESS003",
  ];
  const repairToken = "manual_repair_token_validation_0123456789abcdef";
  const audio = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4]);
  let paidCalls = 0;
  const env = {
    ...workerEnv,
    OPENAI_API_KEY: "test-key-never-returned",
    INTERVIEW_MANUAL_REPAIR_TOKEN: repairToken,
    INTERVIEW_MANUAL_REPAIR_SESSION_IDS: syntheticSessionIds.join(","),
    OPENAI_API: { fetch: async () => {
      paidCalls += 1;
      return Response.json({
        segments: [{ speaker: "A", start: 0, end: 1, text: "must not run" }],
      });
    } },
  };
  const validHeaders = {
    Authorization: `Bearer ${repairToken}`,
    "Content-Type": "audio/mpeg",
    "Content-Length": String(audio.byteLength),
    "X-Interview-Session-Id": syntheticSessionIds[0],
    "X-Interview-Audio-Sha256": sha256Hex(audio),
    "X-Interview-Audio-Index": "1",
  };
  const cases = [
    { header: "Content-Type", value: "audio/webm", expectedStatus: 415 },
    { header: "Content-Length", value: "", expectedStatus: 411 },
    { header: "Content-Length", value: "24000001", expectedStatus: 413 },
    { header: "X-Interview-Session-Id", value: "TD-UNKNOWN1-UNKNOWN", expectedStatus: 400 },
    { header: "X-Interview-Audio-Sha256", value: "a".repeat(64), expectedStatus: 400 },
    { header: "X-Interview-Audio-Index", value: "0", expectedStatus: 400 },
    { header: "X-Interview-Audio-Index", value: "7", expectedStatus: 400 },
  ];
  for (const validationCase of cases) {
    const headers = { ...validHeaders };
    if (validationCase.value) headers[validationCase.header] = validationCase.value;
    else delete headers[validationCase.header];
    const response = await request("/api/internal/manual-transcript-draft", {
      method: "POST",
      headers,
      body: audio,
    }, env);
    assert.equal(response.status, validationCase.expectedStatus, validationCase.header);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal((await response.text()).includes(syntheticSessionIds[0]), false);
  }

  const sizeMismatch = await request("/api/internal/manual-transcript-draft", {
    method: "POST",
    headers: { ...validHeaders, "Content-Length": String(audio.byteLength + 1) },
    body: audio,
  }, env);
  assert.equal(sizeMismatch.status, 400);

  const bodyless = await request("/api/internal/manual-transcript-draft", {
    method: "POST",
    headers: { ...validHeaders, "Content-Length": "1" },
  }, env);
  assert.equal(bodyless.status, 400);
  assert.equal(paidCalls, 0);
});

test("manual transcript draft makes one diarization request and returns only bounded segments", async () => {
  const repairToken = "manual_repair_token_success_0123456789abcdef";
  const audio = new Uint8Array([0x49, 0x44, 0x33, 7, 8, 9]);
  const sessionId = "TD-TEST0001-SESS001";
  const sessionAllowlist = [sessionId, "TD-TEST0002-SESS002", "TD-TEST0003-SESS003"].join(",");
  let paidCalls = 0;
  let persistenceCalls = 0;
  const openAI = { fetch: async (upstreamRequest) => {
    paidCalls += 1;
    assert.equal(upstreamRequest.method, "POST");
    assert.equal(new URL(upstreamRequest.url).pathname, "/v1/audio/transcriptions");
    assert.equal(upstreamRequest.headers.get("authorization"), "Bearer test-key-never-returned");
    assert.notEqual(upstreamRequest.headers.get("openai-safety-identifier"), sessionId);
    const form = await upstreamRequest.formData();
    assert.equal(form.get("model"), "gpt-4o-transcribe-diarize");
    assert.equal(form.get("language"), "ja");
    assert.equal(form.get("response_format"), "diarized_json");
    assert.equal(form.get("chunking_strategy"), "auto");
    const file = form.get("file");
    assert.ok(file instanceof File);
    assert.equal(file.name, "manual-audio-01.mp3");
    assert.equal(file.type, "audio/mpeg");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audio);
    return Response.json({
      task: "transcribe",
      duration: 2.5,
      text: "private full transcript must not be duplicated",
      segments: [
        { id: "segment-1", speaker: "A", start: 0, end: 1.2, text: " 質問です。 " },
        { id: "segment-2", speaker: "B", start: 1.3, end: 2.5, text: "回答です。" },
      ],
    });
  } };
  const response = await request("/api/internal/manual-transcript-draft", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${repairToken}`,
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.byteLength),
      "X-Interview-Session-Id": sessionId,
      "X-Interview-Audio-Sha256": sha256Hex(audio),
      "X-Interview-Audio-Index": "1",
    },
    body: audio,
  }, {
    ...workerEnv,
    OPENAI_API_KEY: "test-key-never-returned",
    INTERVIEW_MANUAL_REPAIR_TOKEN: repairToken,
    INTERVIEW_MANUAL_REPAIR_SESSION_IDS: sessionAllowlist,
    OPENAI_API: openAI,
    DB: { prepare() { persistenceCalls += 1; throw new Error("D1_MUST_NOT_BE_USED"); } },
    RECORDINGS: { put() { persistenceCalls += 1; throw new Error("R2_MUST_NOT_BE_USED"); } },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.deepEqual(await response.json(), {
    model: "gpt-4o-transcribe-diarize",
    segments: [
      { speaker: "A", start: 0, end: 1.2, text: "質問です。" },
      { speaker: "B", start: 1.3, end: 2.5, text: "回答です。" },
    ],
  });
  assert.equal(paidCalls, 1);
  assert.equal(persistenceCalls, 0);
});

test("manual transcript draft never retries ambiguous upstream failures or logs private request data", async () => {
  const repairToken = "manual_repair_token_failure_0123456789abcdef";
  const sessionId = "TD-TEST0001-SESS001";
  const sessionAllowlist = [sessionId, "TD-TEST0002-SESS002", "TD-TEST0003-SESS003"].join(",");
  const privateMarker = new TextEncoder().encode("PRIVATE-AUDIO-MARKER");
  const logs = [];
  const originals = { info: console.info, warn: console.warn, error: console.error };
  console.info = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  try {
    for (const fakeFetch of [
      async () => new Response(JSON.stringify({ error: { message: "PRIVATE-UPSTREAM-MARKER" } }), {
        status: 503,
        headers: { "x-request-id": "PRIVATE-REQUEST-ID-MARKER" },
      }),
      async () => { throw new Error("PRIVATE-TRANSPORT-MARKER"); },
      async () => Response.json({ segments: [{ speaker: "A", start: "0", end: 1, text: "bad" }] }),
    ]) {
      let paidCalls = 0;
      const response = await request("/api/internal/manual-transcript-draft", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${repairToken}`,
          "Content-Type": "audio/mpeg",
          "Content-Length": String(privateMarker.byteLength),
          "X-Interview-Session-Id": sessionId,
          "X-Interview-Audio-Sha256": sha256Hex(privateMarker),
          "X-Interview-Audio-Index": "1",
        },
        body: privateMarker,
      }, {
        ...workerEnv,
        OPENAI_API_KEY: "test-key-never-returned",
        INTERVIEW_MANUAL_REPAIR_TOKEN: repairToken,
        INTERVIEW_MANUAL_REPAIR_SESSION_IDS: sessionAllowlist,
        OPENAI_API: { fetch: async (upstreamRequest) => {
          paidCalls += 1;
          return await fakeFetch(upstreamRequest);
        } },
      });
      assert.equal(response.status, 200, "streaming starts before the long upstream request");
      const responseText = await response.text();
      assert.equal(paidCalls, 1);
      assert.equal(responseText.includes(sessionId), false);
      assert.equal(responseText.includes(repairToken), false);
      assert.equal(responseText.includes("PRIVATE-UPSTREAM-MARKER"), false);
      assert.equal(responseText.includes("PRIVATE-TRANSPORT-MARKER"), false);
      assert.equal(responseText.includes("PRIVATE-REQUEST-ID-MARKER"), false);
      assert.match(responseText, /manual_repair_(?:upstream_unavailable|upstream_response_invalid)/);
    }
  } finally {
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  const output = JSON.stringify(logs);
  assert.equal(output.includes(sessionId), false);
  assert.equal(output.includes(repairToken), false);
  assert.equal(output.includes("PRIVATE-AUDIO-MARKER"), false);
  assert.equal(output.includes("PRIVATE-UPSTREAM-MARKER"), false);
  assert.equal(output.includes("PRIVATE-TRANSPORT-MARKER"), false);
  assert.equal(output.includes("PRIVATE-REQUEST-ID-MARKER"), false);
});

test("internal recovery status returns only the fixed technical projection", async () => {
  const recoveryToken = "status-recovery-token-never-returned-0123456789abcdef";
  const sessionId = "TD-STATUS-123456";
  const privateCandidateMarker = "PRIVATE-CANDIDATE-NAME";
  const privateTranscriptMarker = "PRIVATE-TRANSCRIPT-TEXT";
  const privateObjectKey = "interviews/private-recording-object.manifest.json";
  const privateFolderId = "PRIVATE-DRIVE-FOLDER-ID";
  const privateFolderUrl = "https://drive.example/private-folder";
  const privateFileId = "PRIVATE-DRIVE-FILE-ID";
  const database = new FakeD1();
  database.sessions.set(sessionId, {
    id: sessionId,
    candidate_name: privateCandidateMarker,
    employment: "private-employment",
    preferred_location: "private-location",
    status: "completed",
    recording_status: "stored",
    transcript_json: JSON.stringify([{
      id: "candidate-1",
      speaker: "candidate",
      text: privateTranscriptMarker,
      createdAt: "2026-08-13T00:00:00.000Z",
    }]),
    created_at: "2026-08-13T00:00:00.000Z",
    updated_at: "2026-08-13T00:00:00.000Z",
  });
  database.artifacts.push([
    "artifact-private", sessionId, privateObjectKey, "video/webm", 73_400_321,
  ]);
  database.externalSyncs.set(sessionId, {
    provider: "google_drive",
    status: "failed",
    requested_at: "2026-08-13T00:00:00.000Z",
    started_at: "2026-08-13T00:01:00.000Z",
    completed_at: null,
    folder_id: privateFolderId,
    folder_url: privateFolderUrl,
    manifest_json: JSON.stringify({
      files: { recording: { id: privateFileId, name: "private-name" } },
      recordingIncluded: false,
      transcriptAvailable: true,
      transcriptKind: "actual_transcript",
    }),
    error_code: "GOOGLE_DRIVE_API_503",
    updated_at: "2026-08-13T00:02:00.000Z",
  });
  database.driveUploadSteps.set(sessionId, {
    session_id: sessionId,
    phase: "uploading",
    committed_offset: 4_194_304,
    total_bytes: 73_400_321,
    upload_url_ciphertext: "PRIVATE-UPLOAD-CAPABILITY",
    upload_url_iv: "PRIVATE-UPLOAD-IV",
    folder_id: privateFolderId,
    folder_url: privateFolderUrl,
    recording_file_json: JSON.stringify({ id: privateFileId }),
  });
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_RECOVERY_TOKEN: recoveryToken,
  };
  const body = JSON.stringify({ sessionId });

  const unauthorized = await request("/api/internal/recovery/status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${"z".repeat(43)}`,
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    },
    body,
  }, env);
  assert.equal(unauthorized.status, 401);

  const response = await request("/api/internal/recovery/status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${recoveryToken}`,
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
      Origin: "https://machine.invalid",
    },
    body,
  }, env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const responseText = await response.text();
  assert.deepEqual(JSON.parse(responseText), {
    technicalStatus: {
      session: { status: "completed", recordingStatus: "stored" },
      sourceTranscriptVerified: true,
      recording: { byteSize: 73_400_321 },
      driveSync: {
        status: "failed",
        manifest: {
          present: true,
          recordingIncluded: false,
          transcriptAvailable: true,
          transcriptKind: "actual_transcript",
        },
      },
      driveStep: {
        phase: "uploading",
        committedOffset: 4_194_304,
        totalBytes: 73_400_321,
        lastError: "GOOGLE_DRIVE_API_503",
      },
    },
  });
  for (const privateValue of [
    recoveryToken,
    sessionId,
    privateCandidateMarker,
    privateTranscriptMarker,
    privateObjectKey,
    privateFolderId,
    privateFolderUrl,
    privateFileId,
    "PRIVATE-UPLOAD-CAPABILITY",
    "PRIVATE-UPLOAD-IV",
  ]) {
    assert.equal(responseText.includes(privateValue), false);
  }

  database.externalSyncs.get(sessionId).error_code = "GOOGLE_DRIVE_PRIVATE_CANDIDATE_NAME";
  const sanitizedErrorResponse = await request("/api/internal/recovery/status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${recoveryToken}`,
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    },
    body,
  }, env);
  const sanitizedErrorText = await sanitizedErrorResponse.text();
  assert.equal(sanitizedErrorResponse.status, 200);
  assert.equal(
    JSON.parse(sanitizedErrorText).technicalStatus.driveStep.lastError,
    "GOOGLE_DRIVE_SYNC_FAILED",
  );
  assert.equal(sanitizedErrorText.includes("PRIVATE_CANDIDATE_NAME"), false);

  const invalidBody = JSON.stringify({ sessionId, extra: true });
  const invalid = await request("/api/internal/recovery/status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${recoveryToken}`,
      "Content-Type": "application/json",
      "Content-Length": String(invalidBody.length),
    },
    body: invalidBody,
  }, env);
  assert.equal(invalid.status, 400);

  const oversizedBody = JSON.stringify({ sessionId: `TD-${"A".repeat(110)}` });
  const oversized = await request("/api/internal/recovery/status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${recoveryToken}`,
      "Content-Type": "application/json",
      "Content-Length": String(oversizedBody.length),
    },
    body: oversizedBody,
  }, env);
  assert.equal(oversized.status, 413);
});

test("Apps Script recovery uses one locked strict and secret-free five-minute trigger", async () => {
  const script = await readFile(
    new URL("../scripts/apps-script-interview-recovery.gs", import.meta.url),
    "utf8",
  );
  const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(script, /INTERVIEW_RECOVERY_URL\s*=\s*\n?\s*"https:\/\/recruit\.tokyo-dogs\.com\/api\/internal\/recovery"/);
  assert.match(script, /getScriptProperties\(\)[\s\S]*?\.getProperty\(INTERVIEW_RECOVERY_TOKEN_PROPERTY\)/);
  assert.match(script, /token\.length < 43/);
  assert.match(script, /\^\[A-Za-z0-9_-\]\+\$/);
  assert.match(script, /LockService\.getScriptLock\(\)/);
  assert.match(script, /lock\.tryLock\(1000\)/);
  assert.match(script, /finally\s*\{\s*lock\.releaseLock\(\)/);
  assert.match(script, /UrlFetchApp\.fetch\(INTERVIEW_RECOVERY_URL/);
  assert.match(script, /method: "post"/);
  assert.match(script, /contentType: "application\/json"/);
  assert.match(script, /payload: "\{\}"/);
  assert.match(script, /muteHttpExceptions: true/);
  assert.match(script, /followRedirects: false/);
  assert.match(script, /timeoutSeconds: 120/);
  assert.match(script, /response\.getResponseCode\(\) !== 200/);
  assert.match(script, /\^application\\\/json;\\s\*charset=utf-8\$\/i/);
  assert.match(script, /isExactObjectWithKeys_\(result, \["states", "tick"\]\)/);
  assert.match(script, /result\.tick !== "completed"/);
  assert.deepEqual(
    [...script.matchAll(/^\s+"(completion|drive|evaluation|recording|transcription)",$/gm)]
      .map((match) => match[1]),
    ["completion", "drive", "evaluation", "recording", "transcription"],
  );
  assert.match(script, /"idle",\s+"advanced",\s+"waiting",\s+"attention",/s);
  assert.match(script, /throw new Error\("INTERVIEW_RECOVERY_ATTENTION"\)/);
  assert.match(script, /ScriptApp\.getProjectTriggers\(\)/);
  assert.match(script, /trigger\.getHandlerFunction\(\) === INTERVIEW_RECOVERY_HANDLER/);
  assert.match(script, /ScriptApp\.deleteTrigger\(trigger\)/);
  assert.match(script, /ScriptApp\.newTrigger\(INTERVIEW_RECOVERY_HANDLER\)[\s\S]*?\.everyMinutes\(5\)[\s\S]*?\.create\(\)/);
  assert.doesNotMatch(script, /\.everyMinutes\(1\)/);
  assert.match(viteConfig, /triggers:\s*\{\s*crons:\s*\["2-59\/5 \* \* \* \*"\]\s*\}/);
  assert.doesNotMatch(viteConfig, /crons:\s*\["\* \* \* \* \*"\]/);
  assert.doesNotMatch(script, /Logger\.|console\.|console\.log|gh api|github\.token|secrets\./i);
  for (const error of script.matchAll(/new Error\(([^)]+)\)/g)) {
    assert.match(error[1], /^"INTERVIEW_RECOVERY_[A-Z_]+"$/);
  }

  await assert.rejects(
    readFile(new URL("../.github/workflows/interview-background-recovery.yml", import.meta.url)),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(new URL("../.github/workflows/repository-activity-heartbeat.yml", import.meta.url)),
    { code: "ENOENT" },
  );
});

test("health endpoint verifies server authentication without returning the key", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const healthUrls = [];
  const healthAuthorizations = [];
  let serviceBindingCalls = 0;
  const response = await request("/api/health", {}, {
    ...workerEnv,
    OPENAI_API_KEY: "test-key-never-returned",
    OPENAI_HEALTH_API: { fetch: async (upstreamRequest) => {
      healthUrls.push(upstreamRequest.url);
      healthAuthorizations.push(upstreamRequest.headers.get("Authorization") ?? "");
      return Response.json({ data: [] });
    } },
    OPENAI_API: { fetch: async () => {
      serviceBindingCalls += 1;
      return new Promise(() => undefined);
    } },
  });
  assert.deepEqual(healthUrls.sort(), [
    "https://api.openai.com/v1/models/gpt-5.6-sol",
    "https://api.openai.com/v1/models/gpt-realtime-2.1",
  ]);
  assert.deepEqual(healthAuthorizations, [
    "Bearer test-key-never-returned",
    "Bearer test-key-never-returned",
  ]);
  assert.equal(serviceBindingCalls, 0,
    "readiness must not use a hosted Fetcher that can outlive its abort fence");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: true });
  assert.equal(response.headers.get("permissions-policy"), "camera=(self), microphone=(self), display-capture=(self)");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("health endpoint fails closed when the configured OpenAI key is rejected", async () => {
  process.env.OPENAI_API_KEY = "rejected-test-key-never-returned";
  const warnings = [];
  let upstreamCalls = 0;
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let response;
  try {
    response = await request("/api/health", {}, {
      ...workerEnv,
      OPENAI_API_KEY: "rejected-test-key-never-returned",
      OPENAI_HEALTH_API: { fetch: async () => {
        upstreamCalls += 1;
        return Response.json(
          { error: {
            code: "invalid_api_key",
            type: "invalid_request_error",
            message: "rejected-test-key-never-returned",
          } },
          { status: 401 },
        );
      } },
    });
  } finally {
    console.warn = originalWarn;
  }
  const responseText = await response.clone().text();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { configured: false });
  assert.equal(responseText.includes("rejected-test-key-never-returned"), false);
  assert.equal(JSON.stringify(warnings).includes("rejected-test-key-never-returned"), false);
  assert.match(JSON.stringify(warnings), /invalid_api_key/);
  assert.match(JSON.stringify(warnings), /invalid_request_error/);
  assert.equal(upstreamCalls, 2, "definitive authentication failures must not be retried");
});

test("a cold isolate retries each transient model probe once and turns green on exact recovery", async () => {
  const attempts = new Map();
  const originalWarn = console.warn;
  console.warn = () => undefined;
  const env = {
    ...workerEnv,
    OPENAI_API_KEY: "cold-transient-recovery-health-test-key",
    OPENAI_HEALTH_API: { fetch: async (upstreamRequest) => {
      const attempt = (attempts.get(upstreamRequest.url) ?? 0) + 1;
      attempts.set(upstreamRequest.url, attempt);
      return attempt === 1
        ? Response.json({ error: { type: "server_error" } }, { status: 500 })
        : Response.json({ data: [] });
    } },
  };
  try {
    assert.equal((await request("/api/health", {}, env)).status, 200);
    assert.deepEqual([...attempts.values()].sort(), [2, 2]);
    assert.equal((await request("/api/health", {}, env)).status, 200);
    assert.deepEqual([...attempts.values()].sort(), [2, 2],
      "the recovered result must enter the normal healthy cache");
  } finally {
    console.warn = originalWarn;
  }
});

test("health checks models independently and keeps a recent known-good model green across a transient timeout", async () => {
  const originalNow = Date.now;
  const originalWarn = console.warn;
  let now = originalNow();
  let mode = "healthy";
  const calls = [];
  const signals = [];
  const warnings = [];
  Date.now = () => now;
  console.warn = (...args) => warnings.push(args);
  const env = {
    ...workerEnv,
    OPENAI_API_KEY: "stale-good-health-test-key",
    OPENAI_HEALTH_API: { fetch: async (upstreamRequest) => {
      calls.push(upstreamRequest.url);
      signals.push(upstreamRequest.signal);
      if (mode === "partial-timeout" && upstreamRequest.url.includes("gpt-realtime")) {
        throw new DOMException("simulated timeout", "AbortError");
      }
      return Response.json({ data: [] });
    } },
  };
  try {
    assert.equal((await request("/api/health", {}, env)).status, 200);
    assert.equal(calls.length, 2);
    assert.notEqual(signals[0], signals[1], "each model must own an independent abort fence");

    now += 5 * 60 * 1_000 + 1;
    mode = "partial-timeout";
    assert.equal((await request("/api/health", {}, env)).status, 200,
      "a transient timeout must not erase a recent verified success");
    assert.equal(calls.length, 5);
    assert.match(JSON.stringify(warnings), /OPENAI_AUTHENTICATION_CHECK_TRANSIENT/);

    assert.equal((await request("/api/health", {}, env)).status, 200);
    assert.equal(calls.length, 5, "transient results have a short anti-amplification cache");

    now += 30 * 1_000 + 1;
    mode = "healthy";
    assert.equal((await request("/api/health", {}, env)).status, 200);
    assert.equal(calls.length, 6, "only the model whose transient cache expired is re-probed");
  } finally {
    Date.now = originalNow;
    console.warn = originalWarn;
  }
});

test("health fails closed and caches a transient partial failure before any known-good readback", async () => {
  let calls = 0;
  const originalWarn = console.warn;
  console.warn = () => undefined;
  const env = {
    ...workerEnv,
    OPENAI_API_KEY: "cold-partial-health-test-key",
    OPENAI_HEALTH_API: { fetch: async (upstreamRequest) => {
      calls += 1;
      return upstreamRequest.url.includes("gpt-realtime")
        ? Response.json({ error: { type: "server_error" } }, { status: 503 })
        : Response.json({ data: [] });
    } },
  };
  try {
    assert.equal((await request("/api/health", {}, env)).status, 503);
    assert.equal(calls, 3);
    assert.equal((await request("/api/health", {}, env)).status, 503);
    assert.equal(calls, 3, "two cold transient failures are cached briefly without claiming healthy");
  } finally {
    console.warn = originalWarn;
  }
});

test("health aborts a hung native probe and stops after one bounded retry per model", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWarn = console.warn;
  const signals = [];
  let timerId = 0;
  globalThis.setTimeout = (callback) => {
    const id = ++timerId;
    queueMicrotask(callback);
    return id;
  };
  globalThis.clearTimeout = () => undefined;
  console.warn = () => undefined;
  try {
    const response = await request("/api/health", {}, {
      ...workerEnv,
      OPENAI_API_KEY: "hung-native-health-probe-test-key",
      OPENAI_HEALTH_API: { fetch: async (upstreamRequest) => {
        signals.push(upstreamRequest.signal);
        return await new Promise((_, reject) => {
          upstreamRequest.signal.addEventListener("abort", () => {
            reject(new DOMException("simulated hung fetch abort", "AbortError"));
          }, { once: true });
        });
      } },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { configured: false });
    assert.equal(signals.length, 4, "two models receive one initial attempt and one retry each");
    assert.equal(signals.every((signal) => signal.aborted), true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    console.warn = originalWarn;
  }
});

test("health clears known-good evidence after exhausted credit and cannot resurrect it on transients", async () => {
  const originalNow = Date.now;
  const originalWarn = console.warn;
  let now = originalNow();
  let mode = "healthy";
  let calls = 0;
  Date.now = () => now;
  console.warn = () => undefined;
  const env = {
    ...workerEnv,
    OPENAI_API_KEY: "credit-exhaustion-health-test-key",
    OPENAI_HEALTH_API: { fetch: async (upstreamRequest) => {
      calls += 1;
      if (!upstreamRequest.url.includes("gpt-realtime")) return Response.json({ data: [] });
      if (mode === "quota") {
        return Response.json(
          { error: { code: "credit_balance_exhausted", type: "insufficient_quota" } },
          { status: 429 },
        );
      }
      if (mode === "transient") {
        return Response.json({ error: { type: "server_error" } }, { status: 503 });
      }
      return Response.json({ data: [] });
    } },
  };
  try {
    assert.equal((await request("/api/health", {}, env)).status, 200);
    now += 5 * 60 * 1_000 + 1;
    mode = "quota";
    assert.equal((await request("/api/health", {}, env)).status, 503);
    assert.equal(calls, 4, "a definitive credit failure must not receive a transient retry");
    now += 30 * 1_000 + 1;
    mode = "transient";
    assert.equal((await request("/api/health", {}, env)).status, 503,
      "a definitive failure must erase stale-good before later transient probes");
    assert.equal(calls, 6, "the transient class receives exactly one retry after the red cache expires");
    now += 30 * 1_000 + 1;
    mode = "healthy";
    assert.equal((await request("/api/health", {}, env)).status, 200,
      "only a new verified healthy probe may restore green after a definitive failure");
    assert.equal(calls, 7);
  } finally {
    Date.now = originalNow;
    console.warn = originalWarn;
  }
});

test("authenticated production readiness reports missing components without exposing secrets", async () => {
  const unauthorized = await request("/api/admin/readiness", {}, {
    ...workerEnv,
    INTERVIEW_ADMIN_TOKEN: "readiness-admin-secret",
  });
  assert.equal(unauthorized.status, 401);

  const response = await request("/api/admin/readiness", {
    headers: { Authorization: "Bearer readiness-admin-secret" },
  }, {
    ...workerEnv,
    INTERVIEW_ADMIN_TOKEN: "readiness-admin-secret",
    OPENAI_API_KEY: "readiness-rejected-openai-key",
    OPENAI_HEALTH_API: {
      fetch: async () => Response.json({ error: { type: "invalid_request_error" } }, { status: 401 }),
    },
  });
  const responseText = await response.clone().text();
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.technicallyReady, false);
  assert.equal(payload.openAIAuthenticated, false);
  assert.equal(payload.database, false);
  assert.equal(payload.recordingStorage, false);
  assert.deepEqual(payload.reviewerAuth, { configured: false, dedicated: false });
  assert.ok(payload.missing.includes("OPENAI_AUTHENTICATION"));
  assert.ok(payload.missing.includes("INTERVIEW_DATABASE"));
  assert.ok(payload.missing.includes("RECORDING_STORAGE"));
  assert.equal(payload.missing.includes("INTERVIEW_STAFF_AUTHENTICATION"), true);
  assert.ok(payload.missing.includes("GOOGLE_DRIVE_REFRESH_TOKEN"));
  assert.equal(payload.driveOAuthSetup.configured, false);
  assert.ok(payload.missing.includes("GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET"));
  assert.equal(payload.missing.includes("GOOGLE_PICKER_API_KEY"), false);
  assert.equal(responseText.includes("readiness-admin-secret"), false);
  assert.equal(responseText.includes("readiness-rejected-openai-key"), false);
});

test("Google Drive admin health check fails closed without secrets or authorization", async () => {
  const unauthorized = await request("/api/admin/google-drive/health", {}, {
    ...workerEnv,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
  });
  assert.equal(unauthorized.status, 401);

  const unconfigured = await request("/api/admin/google-drive/health", {
    headers: { Authorization: "Bearer drive-admin-secret" },
  }, {
    ...workerEnv,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
  });
  const payload = await unconfigured.json();
  assert.equal(unconfigured.status, 503);
  assert.equal(payload.configured, false);
  assert.equal(payload.authenticated, false);
  assert.ok(payload.missing.includes("GOOGLE_DRIVE_REFRESH_TOKEN"));
  assert.equal(JSON.stringify(payload).includes("drive-admin-secret"), false);
});

test("Google Drive admin health check refreshes OAuth and verifies only the approved writable folder", async () => {
  const originalFetch = globalThis.fetch;
  const rootFolderId = "10z2FVOAv_MXGlfgxfsO-VgC_41v3Ui3T";
  let tokenRequestBody = "";
  try {
    globalThis.fetch = async (url, init = {}) => {
      if (url === "https://oauth2.googleapis.com/token") {
        tokenRequestBody = String(init.body);
        assert.equal(init.method, "POST");
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      assert.match(String(url), new RegExp(`/drive/v3/files/${rootFolderId}`));
      assert.equal(init.headers.Authorization, "Bearer temporary-google-access-token");
      return Response.json({
        id: rootFolderId,
        name: "オンライン一次面接_自動格納",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
        capabilities: { canAddChildren: true },
        webViewLink: `https://drive.google.com/drive/folders/${rootFolderId}`,
      });
    };
    const response = await request("/api/admin/google-drive/health", {
      headers: { Authorization: "Bearer drive-admin-secret" },
    }, {
      ...workerEnv,
      INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
      GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
      GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
      GOOGLE_DRIVE_REFRESH_TOKEN: "google-refresh-token",
      GOOGLE_DRIVE_ROOT_FOLDER_ID: rootFolderId,
      GOOGLE_DRIVE_EXPECTED_ROOT_NAME: "オンライン一次面接_自動格納",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.configured, true);
    assert.equal(payload.authenticated, true);
    assert.equal(payload.root.id, rootFolderId);
    assert.equal(payload.root.name, "オンライン一次面接_自動格納");
    assert.equal(payload.root.canAddChildren, true);
    assert.equal(payload.root.locationType, "my_drive");
    assert.match(tokenRequestBody, /grant_type=refresh_token/);
    assert.match(tokenRequestBody, /client_id=google-client-id/);
    const responseText = JSON.stringify(payload);
    assert.equal(responseText.includes("google-client-secret"), false);
    assert.equal(responseText.includes("google-refresh-token"), false);
    assert.equal(responseText.includes("temporary-google-access-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google Drive setup starts with PKCE and grants a short-lived HttpOnly admin session", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_OAUTH_REDIRECT_URI: "http://localhost/api/admin/google-drive/oauth/callback",
    GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET: "test-only-encryption-material-over-32-characters",
    GOOGLE_PICKER_API_KEY: "public-picker-browser-key",
    GOOGLE_CLOUD_PROJECT_NUMBER: "123456789012",
  };
  const response = await request("/api/admin/google-drive/oauth/start", {
    method: "POST",
    headers: {
      Authorization: "Bearer drive-admin-secret",
      Origin: "http://localhost",
    },
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const authorizationUrl = new URL(payload.authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://accounts.google.com");
  assert.equal(authorizationUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizationUrl.searchParams.get("code_challenge"));
  assert.ok(authorizationUrl.searchParams.get("state"));
  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.some((value) => value.startsWith("td_drive_admin_setup=")), true);
  assert.equal(setCookies.some((value) => value.startsWith("td_drive_oauth_state=")), true);
  assert.equal(setCookies.some((value) => value.startsWith("td_drive_oauth_verifier=")), true);
  assert.equal(setCookies.every((value) => value.includes("HttpOnly") && value.includes("SameSite=Lax")), true);
  const responseText = JSON.stringify(payload) + setCookies.join(";");
  assert.equal(responseText.includes("google-client-secret"), false);
  assert.equal(responseText.includes("drive-admin-secret"), false);
});

test("Google Drive setup can derive separated token encryption from a strong admin secret", async () => {
  const strongAdminSecret = "test-admin-secret-64-characters-or-more-1234567890-abcdef";
  const response = await request("/api/admin/google-drive/oauth/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${strongAdminSecret}`,
      Origin: "http://localhost",
    },
  }, {
    ...workerEnv,
    DB: new FakeD1(),
    INTERVIEW_ADMIN_TOKEN: strongAdminSecret,
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_OAUTH_REDIRECT_URI: "http://localhost/api/admin/google-drive/oauth/callback",
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(JSON.stringify(payload).includes(strongAdminSecret), false);
});

test("Google Drive invalid OAuth callbacks fail closed", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_OAUTH_REDIRECT_URI: "http://localhost/api/admin/google-drive/oauth/callback",
    GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET: "test-only-encryption-material-over-32-characters",
  };
  const invalidCallback = await request("/api/admin/google-drive/oauth/callback?code=unused&state=invalid", {}, env);
  assert.equal(invalidCallback.status, 303);
  assert.equal(new URL(invalidCallback.headers.get("location")).pathname, "/staff/google-drive");
  assert.equal(new URL(invalidCallback.headers.get("location")).searchParams.get("error"), "oauth_failed");
});

test("Google Drive OAuth callback encrypts the refresh token and the approved folder is read back", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const rootFolderId = "10z2FVOAv_MXGlfgxfsO-VgC_41v3Ui3T";
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_OAUTH_REDIRECT_URI: "http://localhost/api/admin/google-drive/oauth/callback",
    GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET: "test-only-encryption-material-over-32-characters",
    GOOGLE_PICKER_API_KEY: "public-picker-browser-key",
    GOOGLE_CLOUD_PROJECT_NUMBER: "123456789012",
    GOOGLE_DRIVE_EXPECTED_ROOT_NAME: "オンライン一次面接_自動格納",
    GOOGLE_DRIVE_ROOT_FOLDER_ID: rootFolderId,
  };
  try {
    const start = await request("/api/admin/google-drive/oauth/start", {
      method: "POST",
      headers: { Authorization: "Bearer drive-admin-secret", Origin: "http://localhost" },
    }, env);
    const startPayload = await start.json();
    const authorizationUrl = new URL(startPayload.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    const cookieHeader = start.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const setupCookie = cookieHeader.split("; ").find((value) => value.startsWith("td_drive_admin_setup="));
    assert.ok(state);
    assert.ok(setupCookie);

    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(String(init.body));
        if (body.get("grant_type") === "authorization_code") {
          assert.equal(body.get("code"), "authorization-code-from-google");
          assert.ok(body.get("code_verifier"));
          return Response.json({
            refresh_token: "stored-google-refresh-token-never-returned",
            scope: "https://www.googleapis.com/auth/drive.file",
          });
        }
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "stored-google-refresh-token-never-returned");
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      if (href.includes("/drive/v3/about?")) {
        assert.equal(init.headers.Authorization, "Bearer temporary-google-access-token");
        return Response.json({ user: { emailAddress: "tokyodogs909@gmail.com" } });
      }
      if (href.includes(`/drive/v3/files/${rootFolderId}`)) {
        assert.equal(init.headers.Authorization, "Bearer temporary-google-access-token");
        return Response.json({
          id: rootFolderId,
          name: "オンライン一次面接_自動格納",
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
          capabilities: { canAddChildren: true },
          webViewLink: `https://drive.google.com/drive/folders/${rootFolderId}`,
        });
      }
      throw new Error(`Unexpected Google request: ${href}`);
    };

    const callback = await request(`/api/admin/google-drive/oauth/callback?code=authorization-code-from-google&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookieHeader },
    }, env);
    assert.equal(callback.status, 303);
    assert.equal(new URL(callback.headers.get("location")).searchParams.get("connected"), "1");
    assert.ok(database.driveConnection);
    assert.notEqual(database.driveConnection.refresh_token_ciphertext, "stored-google-refresh-token-never-returned");
    assert.equal(JSON.stringify(database.driveConnection).includes("stored-google-refresh-token-never-returned"), false);

    const rootResponse = await request("/api/admin/google-drive/root", {
      method: "POST",
      headers: {
        Cookie: setupCookie,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }, env);
    const rootPayload = await rootResponse.json();
    assert.equal(rootResponse.status, 200, JSON.stringify(rootPayload));
    assert.equal(rootPayload.saved, true);
    assert.equal(rootPayload.root.id, rootFolderId);
    assert.equal(database.driveConnection.root_folder_id, rootFolderId);
    assert.equal(database.driveConnection.root_folder_name, "オンライン一次面接_自動格納");
    assert.equal(JSON.stringify(rootPayload).includes("temporary-google-access-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google Drive setup creates and reuses an app-managed root when drive.file cannot see the old empty folder", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const oldRootFolderId = "10z2FVOAv_MXGlfgxfsO-VgC_41v3Ui3T";
  const managedRootFolderId = "managedRootFolder987654321";
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "drive-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_OAUTH_REDIRECT_URI: "http://localhost/api/admin/google-drive/oauth/callback",
    GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET: "test-only-encryption-material-over-32-characters",
    GOOGLE_DRIVE_ROOT_FOLDER_ID: oldRootFolderId,
    GOOGLE_DRIVE_EXPECTED_ROOT_NAME: "オンライン一次面接_自動格納",
  };
  let createCalls = 0;
  try {
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(String(init.body));
        if (body.get("grant_type") === "authorization_code") {
          return Response.json({
            refresh_token: "stored-google-refresh-token-never-returned",
            scope: "https://www.googleapis.com/auth/drive.file",
          });
        }
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      if (href.includes("/drive/v3/about?")) {
        return Response.json({ user: { emailAddress: "tokyodogs909@gmail.com" } });
      }
      if (href.includes(`/drive/v3/files/${oldRootFolderId}?`)) {
        return Response.json({ error: { code: 404 } }, { status: 404 });
      }
      if (href.includes("appProperties+has") && init.method !== "POST") {
        return Response.json({ files: createCalls ? [{
          id: managedRootFolderId,
          name: "オンライン一次面接_自動格納_システム管理",
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
          capabilities: { canAddChildren: true },
          webViewLink: `https://drive.google.com/drive/folders/${managedRootFolderId}`,
        }] : [] });
      }
      if (href.startsWith("https://www.googleapis.com/drive/v3/files?") && init.method === "POST") {
        createCalls += 1;
        const metadata = JSON.parse(String(init.body));
        assert.equal(metadata.name, "オンライン一次面接_自動格納_システム管理");
        return Response.json({
          id: managedRootFolderId,
          name: metadata.name,
          mimeType: metadata.mimeType,
          trashed: false,
          capabilities: { canAddChildren: true },
          webViewLink: `https://drive.google.com/drive/folders/${managedRootFolderId}`,
        });
      }
      if (href.includes(`/drive/v3/files/${managedRootFolderId}?`)) {
        return Response.json({
          id: managedRootFolderId,
          name: "オンライン一次面接_自動格納_システム管理",
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
          capabilities: { canAddChildren: true },
          webViewLink: `https://drive.google.com/drive/folders/${managedRootFolderId}`,
        });
      }
      throw new Error(`Unexpected Google request: ${href}`);
    };

    const start = await request("/api/admin/google-drive/oauth/start", {
      method: "POST",
      headers: { Authorization: "Bearer drive-admin-secret", Origin: "http://localhost" },
    }, env);
    const startPayload = await start.json();
    const authorizationUrl = new URL(startPayload.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    const cookieHeader = start.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const setupCookie = cookieHeader.split("; ").find((value) => value.startsWith("td_drive_admin_setup="));
    assert.ok(state);
    assert.ok(setupCookie);
    const callback = await request(`/api/admin/google-drive/oauth/callback?code=authorization-code-from-google&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookieHeader },
    }, env);
    assert.equal(callback.status, 303);

    const firstResponse = await request("/api/admin/google-drive/root", {
      method: "POST",
      headers: {
        Cookie: setupCookie,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }, env);
    const firstPayload = await firstResponse.json();
    assert.equal(firstResponse.status, 200, JSON.stringify(firstPayload));
    assert.equal(firstPayload.saved, true);
    assert.equal(firstPayload.root.id, managedRootFolderId);
    assert.equal(firstPayload.accountEmail, "tokyodogs909@gmail.com");
    assert.equal(database.driveConnection.root_folder_id, managedRootFolderId);
    assert.equal(createCalls, 1);

    const secondResponse = await request("/api/admin/google-drive/root", {
      method: "POST",
      headers: {
        Cookie: setupCookie,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }, env);
    assert.equal(secondResponse.status, 200);
    assert.equal(createCalls, 1, "the tagged app-managed root must not be duplicated");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("candidate archive fails closed before writes for a mismatched transcript duplicate, then repairs an exact duplicate", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const recordings = new FakeR2();
  const rootFolderId = "10z2FVOAv_MXGlfgxfsO-VgC_41v3Ui3T";
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    INTERVIEW_ADMIN_TOKEN: "interview-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_REFRESH_TOKEN: "google-refresh-token",
    GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET: "test-only-drive-step-encryption-secret-at-least-32-characters",
    GOOGLE_DRIVE_ROOT_FOLDER_ID: rootFolderId,
    GOOGLE_DRIVE_EXPECTED_ROOT_NAME: "オンライン一次面接_自動格納",
  };
  const session = await createTestInterviewSession(env, "正社員", "越谷店・相談可");
  const stored = database.sessions.get(session.sessionId);
  stored.status = "completed";
  stored.recording_status = "stored";
  stored.completed_at = "2026-07-29T03:00:00.000Z";
  stored.transcript_json = JSON.stringify([
    { id: "turn-1", speaker: "interviewer", text: "自己紹介をお願いします。", createdAt: "2026-07-29T02:50:00.000Z" },
    { id: "turn-2", speaker: "candidate", text: "接客経験があります。", createdAt: "2026-07-29T02:50:10.000Z" },
  ]);
  stored.evaluation_json = JSON.stringify({
    recommendation: "human_review",
    summary: "採用担当者による確認が必要です。",
    dimensions: [],
    strengths: ["接客経験"],
    concerns: [],
    contradictions: [],
    missingTopics: ["勤務開始時期"],
    conditions: ["他店舗配属は相談"],
    evidenceValidationWarnings: [],
    humanReviewRequired: true,
  });
  stored.summary = "採用担当者による確認が必要です。";
  const recordingKey = `interviews/${session.sessionId}/recording.manifest.json`;
  const recordingByteSize = 71 * 1024 * 1024 + 123;
  const recordingPartSize = 4 * 1024 * 1024;
  const recordingParts = [];
  for (let index = 0, offset = 0; offset < recordingByteSize; index += 1, offset += recordingPartSize) {
    const byteSize = Math.min(recordingPartSize, recordingByteSize - offset);
    const key = `interviews/${session.sessionId}/recording-parts/part-${String(index).padStart(3, "0")}`;
    recordingParts.push({ key, byteSize });
    recordings.objects.set(key, {
      body: new Uint8Array(byteSize).fill(65 + (index % 20)),
      options: { httpMetadata: { contentType: "application/octet-stream" } },
    });
  }
  assert.equal(recordingParts.length, 18);
  recordings.objects.set(recordingKey, {
    body: new TextEncoder().encode(JSON.stringify({
      version: 1,
      contentType: "video/webm",
      byteSize: recordingByteSize,
      audioCoverage: "both",
      parts: recordingParts,
    })),
    options: { httpMetadata: { contentType: "application/json" } },
  });
  database.artifacts.push([
    "artifact-id",
    session.sessionId,
    recordingKey,
    "video/webm",
    recordingByteSize,
    "test-etag",
    "2027-07-29T02:00:00.000Z",
  ]);
  database.externalSyncs.set(session.sessionId, {
    provider: "google_drive",
    // This models the production failure: the old worker wrote the five small
    // files and marked the row completed before the durable recording existed.
    // A completed status must not short-circuit today's repair sync.
    status: "completed",
    requested_at: "2026-07-29T02:00:00.000Z",
    started_at: "2026-07-29T02:00:00.000Z",
    completed_at: "2026-07-29T02:10:00.000Z",
    folder_id: "legacy-video-less-folder",
    folder_url: "https://drive.google.com/drive/folders/legacy-video-less-folder",
    manifest_json: JSON.stringify({
      files: {
        transcript: { id: "old-transcript", name: `${session.sessionId}_文字起こし.txt`, size: 100 },
      },
      recordingIncluded: false,
      transcriptAvailable: true,
      transcriptKind: "actual_transcript",
    }),
    error_code: null,
    updated_at: "2026-07-29T02:00:00.000Z",
  });

  let nextFile = 0;
  const uploadedNames = [];
  const artifactUploadRequests = [];
  const createdFolders = [];
  const expectedTranscriptText = [
    "TOKYO DOGS オンライン一次面接 文字起こし",
    `面接ID: ${session.sessionId}`,
    "応募者氏名: テスト 応募者",
    "雇用形態: 正社員",
    "入職希望対象店舗: 越谷店・相談可",
    "面接完了日時: 2026/07/29 12:00",
    "確認区分: 応募者端末で生成された文字起こし（録画との照合が必要）",
    "",
    "[2026/07/29 11:50] オンライン採用担当者 茂木",
    "自己紹介をお願いします。",
    "",
    "[2026/07/29 11:50] 応募者",
    "接客経験があります。",
    "",
  ].join("\n");
  let uploadedTranscriptBytes = new TextEncoder().encode(expectedTranscriptText);
  const uploadedDriveFiles = [{
    id: "existing-transcript-a",
    name: `${session.sessionId}_文字起こし.txt`,
    mimeType: "text/plain; charset=utf-8",
    size: String(uploadedTranscriptBytes.byteLength),
    trashed: false,
    parents: ["folder-3"],
    appProperties: {
      tokyoDogsArtifact: "transcript",
      tokyoDogsProvider: "google_drive",
    },
  }];
  const legacyDuplicateFile = {
    id: "legacy-duplicate-transcript",
    name: `${session.sessionId}_旧文字起こし_同内容.txt`,
    mimeType: "text/plain",
    size: String(uploadedTranscriptBytes.byteLength),
    trashed: false,
    parents: ["folder-3"],
    appProperties: {
      tokyoDogsArtifact: "transcript",
      tokyoDogsProvider: "google_drive",
    },
  };
  const legacyDuplicatePatches = [];
  const duplicateRepairReads = [];
  const folderListDebug = [];
  const blockingDriveFiles = [];
  let duplicateTranscriptMatches = false;
  let deleteCalls = 0;
  let injectQuarantineTransientFailure = true;
  let simulateLostQuarantineResponse = true;
  let manifestPostCount = 0;
  let recordingUploadFinished = false;
  const recordingUploadRanges = [];
  let recordingMetadata = null;
  let uploadedTranscriptText = "";
  let injectFirstRecordingChunkFailure = true;
  let replacedRecordingUploadLocation = false;
  let recordingCommittedBytes = 0;
  let recordingDataPutsThisApiCall = 0;
  try {
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      if (href.includes(`/drive/v3/files/${rootFolderId}?`)) {
        return Response.json({
          id: rootFolderId,
          name: "オンライン一次面接_自動格納",
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
          capabilities: { canAddChildren: true },
          webViewLink: `https://drive.google.com/drive/folders/${rootFolderId}`,
        });
      }
      if (href.includes("/drive/v3/files/folder-3?")) {
        return Response.json({
          id: "folder-3",
          name: `テスト 応募者_${session.sessionId}`,
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
          parents: ["folder-2"],
          appProperties: {
            tokyoDogsKind: "tokyoDogsInterviewSession",
            tokyoDogsInterviewSession: session.sessionId,
          },
          webViewLink: "https://drive.google.com/drive/folders/folder-3",
        });
      }
      if (href.startsWith("https://www.googleapis.com/drive/v3/files?") && init.method !== "POST") {
        const query = new URL(href).searchParams.get("q") ?? "";
        const isFolderChildrenReadback = query === "'folder-3' in parents and trashed = false";
        folderListDebug.push({ query, uploadedCount: uploadedDriveFiles.length, isFolderChildrenReadback });
        return Response.json({
          files: isFolderChildrenReadback
            ? [...uploadedDriveFiles, legacyDuplicateFile, ...blockingDriveFiles]
            : [],
        });
      }
      if (
        blockingDriveFiles.some((file) => href.includes(`/drive/v3/files/${file.id}?`)) &&
        href.includes("alt=media")
      ) {
        return new Response(uploadedTranscriptBytes, {
          status: 200,
          headers: { "Content-Length": String(uploadedTranscriptBytes.byteLength) },
        });
      }
      if (
        href.includes("/drive/v3/files/legacy-duplicate-transcript?") &&
        init.method !== "PATCH"
      ) {
        duplicateRepairReads.push("legacy");
        const duplicateBytes = duplicateTranscriptMatches
          ? uploadedTranscriptBytes
          : Uint8Array.from(uploadedTranscriptBytes, (value, index) => index === 0 ? value ^ 1 : value);
        return new Response(duplicateBytes, {
          status: 200,
          headers: { "Content-Length": String(duplicateBytes.byteLength) },
        });
      }
      if (
        uploadedDriveFiles.some((file) => href.includes(`/drive/v3/files/${file.id}?`)) &&
        href.includes("alt=media")
      ) {
        const file = uploadedDriveFiles.find((item) => href.includes(`/drive/v3/files/${item.id}?`));
        if (file?.appProperties?.tokyoDogsArtifact !== "transcript") {
          throw new Error("only the bounded transcript may be fetched for duplicate repair");
        }
        duplicateRepairReads.push("canonical");
        return new Response(uploadedTranscriptBytes, {
          status: 200,
          // A proxy may report the transferred representation length rather
          // than Drive's logical file size. The bounded final bytes remain the
          // authoritative size/hash receipt.
          headers: { "Content-Length": String(uploadedTranscriptBytes.byteLength + 1) },
        });
      }
      if (href.includes("/drive/v3/files/legacy-duplicate-transcript?") && init.method === "PATCH") {
        const metadata = JSON.parse(String(init.body));
        legacyDuplicatePatches.push(metadata);
        legacyDuplicateFile.appProperties = {
          ...legacyDuplicateFile.appProperties,
          ...metadata.appProperties,
        };
        if (injectQuarantineTransientFailure) {
          injectQuarantineTransientFailure = false;
          if (simulateLostQuarantineResponse) {
            simulateLostQuarantineResponse = false;
            return new Response(null, { status: 503 });
          }
        }
        return Response.json(legacyDuplicateFile);
      }
      if (init.method === "DELETE") {
        deleteCalls += 1;
        return new Response(null, { status: 204 });
      }
      if (href.startsWith("https://www.googleapis.com/drive/v3/files?") && init.method === "POST") {
        const metadata = JSON.parse(String(init.body));
        const id = `folder-${++nextFile}`;
        createdFolders.push(metadata.name);
        return Response.json({
          id,
          name: metadata.name,
          mimeType: metadata.mimeType,
          parents: metadata.parents,
          appProperties: metadata.appProperties,
          webViewLink: `https://drive.google.com/drive/folders/${id}`,
        });
      }
      if (href.includes("/export?")) {
        return new Response(new TextEncoder().encode("%PDF-1.7 test report"), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }
      if (href.includes("uploadType=resumable")) {
        const metadata = JSON.parse(String(init.body));
        recordingMetadata = metadata;
        uploadedNames.push(metadata.name);
        return new Response(null, {
          status: 200,
          headers: { Location: "https://upload.example.test/recording-session" },
        });
      }
      if (href === "https://upload.example.test/recording-session" || href === "https://upload.example.test/recording-session-2") {
        assert.equal(init.method, "PUT");
        assert.equal(init.redirect, "manual");
        const contentRange = init.headers["Content-Range"];
        if (contentRange === `bytes */${recordingByteSize}`) {
          return new Response(null, {
            status: 308,
            headers: recordingCommittedBytes > 0 ? { Range: `bytes=0-${recordingCommittedBytes - 1}` } : {},
          });
        }
        recordingDataPutsThisApiCall += 1;
        assert.ok(recordingDataPutsThisApiCall <= 1, "one archive API call must send at most one Drive data chunk");
        assert.match(contentRange, /^bytes \d+-\d+\/\d+$/);
        recordingUploadRanges.push(contentRange);
        const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        const end = Number(match[2]);
        const total = Number(match[3]);
        assert.equal(Number(init.headers["Content-Length"]), end - Number(match[1]) + 1);
        if (injectFirstRecordingChunkFailure) {
          injectFirstRecordingChunkFailure = false;
          return new Response(null, { status: 503 });
        }
        if (end + 1 < total) {
          recordingCommittedBytes = end + 1;
          const headers = { Range: `bytes=0-${end}` };
          if (!replacedRecordingUploadLocation) {
            replacedRecordingUploadLocation = true;
            headers.Location = "https://upload.example.test/recording-session-2";
          }
          return new Response(null, { status: 308, headers });
        }
        await new Promise((resolve) => setTimeout(resolve, 75));
        recordingCommittedBytes = total;
        recordingUploadFinished = true;
        const recordingFile = {
          id: `file-${++nextFile}`,
          name: recordingMetadata.name,
          mimeType: "video/webm",
          size: String(recordingByteSize),
          parents: recordingMetadata.parents,
          appProperties: recordingMetadata.appProperties,
        };
        uploadedDriveFiles.push(recordingFile);
        return Response.json(recordingFile);
      }
      if (href.includes("uploadType=multipart")) {
        const metadataBlob = init.body.get("metadata");
        const metadata = JSON.parse(await metadataBlob.text());
        uploadedNames.push(metadata.name);
        const mediaBlob = init.body.get("media");
        artifactUploadRequests.push({
          artifact: metadata.appProperties?.tokyoDogsArtifact,
          method: init.method,
          href,
        });
        if (metadata.appProperties?.tokyoDogsArtifact === "transcript") {
          uploadedTranscriptText = await mediaBlob.text();
          uploadedTranscriptBytes = new TextEncoder().encode(uploadedTranscriptText);
          legacyDuplicateFile.size = String(uploadedTranscriptBytes.byteLength);
        }
        const target = uploadedDriveFiles.find((file) =>
          href.includes(`/files/${encodeURIComponent(file.id)}?`));
        if (metadata.appProperties?.tokyoDogsArtifact === "manifest" && !target) manifestPostCount += 1;
        const uploadedFile = {
          id: target?.id ?? `file-${++nextFile}`,
          name: metadata.name,
          mimeType: metadata.mimeType || mediaBlob.type,
          size: String(mediaBlob.size),
          parents: metadata.parents ?? target?.parents,
          trashed: target?.trashed ?? false,
          appProperties: metadata.appProperties,
        };
        if (target) Object.assign(target, uploadedFile);
        else uploadedDriveFiles.push(uploadedFile);
        return Response.json(uploadedFile);
      }
      throw new Error(`Unexpected Drive request: ${href}`);
    };

    const unauthorized = await request("/api/interviews/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.sessionId }),
    }, env);
    assert.equal(unauthorized.status, 401);

    const mismatched = await request("/api/interviews/archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: session.sessionId }),
    }, env);
    assert.equal(mismatched.status, 502);
    assert.equal(uploadedNames.length, 0, "mismatched duplicate content must fail before any content upload");
    assert.equal(legacyDuplicatePatches.length, 0, "mismatched duplicate content must not be retagged");
    assert.equal(deleteCalls, 0, "mismatched duplicate content must never be deleted");
    assert.equal(uploadedDriveFiles[0].appProperties.tokyoDogsArtifact, "transcript");
    assert.equal(legacyDuplicateFile.appProperties.tokyoDogsArtifact, "transcript");
    assert.equal(database.externalSyncs.get(session.sessionId).status, "failed");
    assert.equal(database.externalSyncs.get(session.sessionId).completed_at, null);

    // Retry only after the fixture proves that both bounded transcripts are the
    // exact current source bytes. Reuse the same folder ID for this in-memory
    // Drive fixture; the failed preflight performed no artifact mutation.
    duplicateTranscriptMatches = true;
    nextFile = 0;
    createdFolders.length = 0;

    legacyDuplicateFile.size = String(uploadedTranscriptBytes.byteLength - 1);
    const differentDeclaredSize = await request("/api/interviews/archive", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.sessionId }),
    }, env);
    assert.equal(differentDeclaredSize.status, 502);
    assert.equal(uploadedNames.length, 0);
    assert.equal(legacyDuplicatePatches.length, 0);
    assert.equal(deleteCalls, 0);
    legacyDuplicateFile.size = String(uploadedTranscriptBytes.byteLength);
    nextFile = 0;
    createdFolders.length = 0;

    blockingDriveFiles.push({
      ...legacyDuplicateFile,
      id: "third-transcript",
      name: `${session.sessionId}_3件目文字起こし.txt`,
      appProperties: { ...legacyDuplicateFile.appProperties },
    });
    const threeTranscripts = await request("/api/interviews/archive", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.sessionId }),
    }, env);
    assert.equal(threeTranscripts.status, 502);
    assert.equal(uploadedNames.length, 0);
    assert.equal(legacyDuplicatePatches.length, 0);
    assert.equal(deleteCalls, 0);
    blockingDriveFiles.length = 0;
    nextFile = 0;
    createdFolders.length = 0;

    blockingDriveFiles.push({
      id: "duplicate-evaluation",
      name: `${session.sessionId}_重複評価.json`,
      mimeType: "application/json",
      size: "2",
      trashed: false,
      parents: ["folder-3"],
      appProperties: { tokyoDogsArtifact: "evaluation_json", tokyoDogsProvider: "google_drive" },
    }, {
      id: "canonical-evaluation",
      name: `${session.sessionId}_評価.json`,
      mimeType: "application/json",
      size: "2",
      trashed: false,
      parents: ["folder-3"],
      appProperties: { tokyoDogsArtifact: "evaluation_json", tokyoDogsProvider: "google_drive" },
    });
    const duplicatedOtherArtifact = await request("/api/interviews/archive", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.sessionId }),
    }, env);
    assert.equal(duplicatedOtherArtifact.status, 502);
    assert.equal(uploadedNames.length, 0);
    assert.equal(legacyDuplicatePatches.length, 0);
    assert.equal(deleteCalls, 0);
    blockingDriveFiles.length = 0;
    nextFile = 0;
    createdFolders.length = 0;

    let payload = null;
    let archiveApiCalls = 0;
    for (; archiveApiCalls < 22; archiveApiCalls += 1) {
      recordingDataPutsThisApiCall = 0;
      const response = await request("/api/interviews/archive", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId: session.sessionId }),
      }, env);
      payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify({
        payload,
        sync: database.externalSyncs.get(session.sessionId),
        uploadedNames,
        createdFolders,
        uploadedDriveFiles,
        legacyDuplicatePatches,
        duplicateRepairReads,
        folderListDebug,
      }));
      assert.ok(recordingDataPutsThisApiCall <= 1);
      if (payload.pending && payload.phase === "retrying" && manifestPostCount > 0) {
        assert.equal(manifestPostCount, 1,
          "a transient quarantine failure may not create a second manifest before retry");
      }
      if (payload.stored) break;
      assert.equal(payload.pending, true);
      assert.ok(["initializing", "uploading", "finalizing", "busy", "retrying"].includes(payload.phase));
      assert.equal(Number.isInteger(payload.committedOffset), true);
      assert.equal(Number.isInteger(payload.totalBytes), true);
      assert.equal(Number.isInteger(payload.retryAfterMs), true);
      if (archiveApiCalls === 0) {
        const durableStep = database.driveUploadSteps.get(session.sessionId);
        assert.ok(durableStep, "the first request must persist the resumable session before returning");
        assert.equal(durableStep.committed_offset, 0);
        assert.equal(durableStep.upload_url_ciphertext.includes("upload.example.test"), false);
        assert.equal(JSON.stringify(durableStep).includes("https://upload.example.test"), false,
          "the bearer-like Drive upload URI must never be stored in plaintext");
      }
    }
    assert.ok(archiveApiCalls < 22, JSON.stringify({ payload, sync: database.externalSyncs.get(session.sessionId) }));
    assert.equal(payload.stored, true);
    assert.equal(payload.recordingIncluded, true);
    assert.equal(payload.transcriptAvailable, true);
    assert.equal(payload.transcriptKind, "actual_transcript");
    assert.match(uploadedTranscriptText, /応募者[\s\S]*接客経験があります。/,
      "the verified transcript artifact must contain a non-empty candidate utterance");
    assert.equal(recordingUploadFinished, true, "the API must not respond before the recording upload finishes");
    assert.deepEqual(recordingUploadRanges, [
      `bytes 0-4194303/${recordingByteSize}`,
      `bytes 0-4194303/${recordingByteSize}`,
      ...Array.from({ length: 17 }, (_, index) => {
        const start = (index + 1) * recordingPartSize;
        const end = Math.min(start + recordingPartSize, recordingByteSize) - 1;
        return `bytes ${start}-${end}/${recordingByteSize}`;
      }),
    ]);
    assert.equal(database.driveUploadSteps.has(session.sessionId), false, "durable upload capability is removed after exact readback");
    assert.match(database.externalSyncs.get(session.sessionId).folder_url, /^https:\/\/drive\.google\.com\/drive\/folders\/folder-/);
    assert.deepEqual(createdFolders, ["2026", "07", `テスト 応募者_${session.sessionId}`]);
    assert.deepEqual(new Set(uploadedNames), new Set([
      `${session.sessionId}_文字起こし.txt`,
      `${session.sessionId}_評価データ.json`,
      `${session.sessionId}_オンライン一次面接レポート`,
      `${session.sessionId}_オンライン一次面接レポート.pdf`,
      `${session.sessionId}_面接録画.webm`,
      `${session.sessionId}_格納結果.json`,
    ]));
    assert.equal(database.externalSyncs.get(session.sessionId).status, "completed");
    assert.equal(manifestPostCount, 1, "manifest response-loss retry must converge on the first uploaded ID");
    assert.equal(artifactUploadRequests.filter((call) => call.artifact === "manifest" && call.method === "POST").length, 1);
    assert.equal(artifactUploadRequests.filter((call) => call.artifact === "manifest" && call.method === "PATCH").length, 1);
    assert.equal(legacyDuplicatePatches.length, 1,
      "a lost quarantine response must be recognized from exact legacy readback without another PATCH");
    assert.notEqual(database.externalSyncs.get(session.sessionId).started_at, "2026-07-29T02:00:00.000Z");
    const canonicalTranscript = uploadedDriveFiles.find((file) =>
      file.appProperties?.tokyoDogsArtifact === "transcript");
    assert.ok(canonicalTranscript);
    assert.equal(canonicalTranscript.id, "existing-transcript-a");
    assert.equal(artifactUploadRequests.filter((call) => call.artifact === "transcript").length, 1);
    assert.equal(artifactUploadRequests.find((call) => call.artifact === "transcript").method, "PATCH");
    assert.match(
      artifactUploadRequests.find((call) => call.artifact === "transcript").href,
      /\/upload\/drive\/v3\/files\/existing-transcript-a\?/,
      "the exact deterministic preflight target must be updated",
    );
    assert.deepEqual(legacyDuplicatePatches, [{
      appProperties: {
        tokyoDogsArtifact: "legacy_duplicate_transcript",
        tokyoDogsLegacyArtifact: "transcript",
      },
    }]);
    assert.equal(deleteCalls, 0, "legacy Drive artifacts must be quarantined without deletion");
    assert.equal(legacyDuplicateFile.id, "legacy-duplicate-transcript");
    assert.equal(legacyDuplicateFile.name, `${session.sessionId}_旧文字起こし_同内容.txt`);
    assert.equal(legacyDuplicateFile.size, String(uploadedTranscriptBytes.byteLength));
    assert.equal(legacyDuplicateFile.appProperties.tokyoDogsArtifact, "legacy_duplicate_transcript");
    assert.equal(legacyDuplicateFile.appProperties.tokyoDogsLegacyArtifact, "transcript");
    const completedManifest = JSON.parse(database.externalSyncs.get(session.sessionId).manifest_json);
    assert.equal(completedManifest.files.transcript.id, canonicalTranscript.id,
      "the current-run canonical file must remain the durable receipt");
    const responseText = JSON.stringify(payload);
    assert.equal(responseText.includes("google-client-secret"), false);
    assert.equal(responseText.includes("google-refresh-token"), false);
    assert.equal(responseText.includes("temporary-google-access-token"), false);

    const driveCallsBeforeIdempotentRead = uploadedNames.length + recordingUploadRanges.length + createdFolders.length;
    recordingDataPutsThisApiCall = 0;
    const replay = await request("/api/interviews/archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: session.sessionId }),
    }, env);
    assert.deepEqual(await replay.json(), {
      stored: true,
      recordingIncluded: true,
      transcriptAvailable: true,
      transcriptKind: "actual_transcript",
    });
    assert.equal(recordingDataPutsThisApiCall, 0);
    assert.equal(uploadedNames.length + recordingUploadRanges.length + createdFolders.length, driveCallsBeforeIdempotentRead,
      "a completed receipt must be an exact D1 readback, not another Drive write");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production invite links are admin-only, expire, and can create exactly one interview session", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "interview-admin-secret",
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  };

  const unauthorized = await request("/api/admin/interviews/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInHours: 24 }),
  }, env);
  assert.equal(unauthorized.status, 401);

  const issue = await request("/api/admin/interviews/invite", {
    method: "POST",
    headers: {
      Authorization: "Bearer interview-admin-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresInHours: 24 }),
  }, env);
  const issued = await issue.json();
  assert.equal(issue.status, 201);
  assert.match(issued.link, /^http:\/\/localhost\/\?invite=/);
  assert.ok(Date.parse(issued.expiresAt) > Date.now());
  assert.equal(JSON.stringify(issued).includes("interview-admin-secret"), false);
  assert.equal(JSON.stringify(issued).includes("test-signing-secret"), false);
  const inviteToken = new URL(issued.link).searchParams.get("invite");
  assert.ok(inviteToken);

  const missingInvite = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "招待なし", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  assert.equal(missingInvite.status, 403);

  const create = () => request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "招待済み 候補者",
      employment: "正社員",
      location: "越谷店、または他店舗相談",
      consent: true,
      inviteToken,
    }),
  }, env);
  const accepted = await create();
  const acceptedPayload = await accepted.json();
  assert.equal(accepted.status, 201);
  assert.ok(database.sessions.has(acceptedPayload.sessionId));
  assert.equal([...database.invites.values()][0].session_id, acceptedPayload.sessionId);

  const reused = await create();
  const reusedPayload = await reused.json();
  assert.equal(reused.status, 403);
  assert.equal(reusedPayload.status, "used");
  assert.match(reusedPayload.error, /使用済み/);
  assert.equal(database.sessions.size, 1);
});

test("required invite mode fails closed when the signing secret is not configured", async () => {
  const database = new FakeD1();
  const response = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, {
    ...workerEnv,
    DB: database,
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.status, "signing-unavailable");
  assert.match(payload.error, /受付準備が完了していません/);
  assert.equal(database.sessions.size, 0);
});

test("invite pre-flight blocks the fixed top URL before camera and microphone permission", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "interview-admin-secret",
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  };

  // The fixed top URL a candidate reaches without their personal link.
  const noToken = await request("/api/interviews/invite", undefined, env);
  const noTokenPayload = await noToken.json();
  assert.equal(noToken.status, 403);
  assert.equal(noTokenPayload.status, "missing");
  assert.match(noTokenPayload.error, /専用のリンクを開いてください/);

  const forged = await request("/api/interviews/invite?token=not-a-real-token", undefined, env);
  const forgedPayload = await forged.json();
  assert.equal(forged.status, 403);
  assert.equal(forgedPayload.status, "invalid");

  const issue = await request("/api/admin/interviews/invite", {
    method: "POST",
    headers: { Authorization: "Bearer interview-admin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInHours: 24 }),
  }, env);
  const inviteToken = new URL((await issue.json()).link).searchParams.get("invite");

  const valid = await request(`/api/interviews/invite?token=${encodeURIComponent(inviteToken)}`, undefined, env);
  const validPayload = await valid.json();
  assert.equal(valid.status, 200);
  assert.equal(validPayload.status, "ok");
  assert.equal(validPayload.inviteRequired, true);
  // Pre-flight must not hand out anything usable or consume the invite.
  assert.equal(validPayload.sessionId, undefined);
  assert.equal(validPayload.accessToken, undefined);
  assert.equal([...database.invites.values()][0].used_at, null);

  // Once the invite is consumed, the same link reports "used" rather than "invalid".
  await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "招待済み 候補者",
      employment: "正社員",
      location: "越谷店",
      consent: true,
      inviteToken,
    }),
  }, env);
  const used = await request(`/api/interviews/invite?token=${encodeURIComponent(inviteToken)}`, undefined, env);
  const usedPayload = await used.json();
  assert.equal(used.status, 403);
  assert.equal(usedPayload.status, "used");
});

test("invite pre-flight separates operator-side gaps and never names internal settings", async () => {
  const signingMissing = await request("/api/interviews/invite?token=abc.def", undefined, {
    ...workerEnv,
    DB: new FakeD1(),
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  });
  const signingPayload = await signingMissing.json();
  assert.equal(signingMissing.status, 503);
  assert.equal(signingPayload.status, "signing-unavailable");

  // Signing configured and the link itself is genuine, but no storage binding is
  // available to look the invite up.
  const signingEnv = {
    ...workerEnv,
    DB: new FakeD1(),
    INTERVIEW_ADMIN_TOKEN: "interview-admin-secret",
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  };
  const issue = await request("/api/admin/interviews/invite", {
    method: "POST",
    headers: { Authorization: "Bearer interview-admin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInHours: 24 }),
  }, signingEnv);
  const genuineToken = new URL((await issue.json()).link).searchParams.get("invite");
  const storageMissing = await request(`/api/interviews/invite?token=${encodeURIComponent(genuineToken)}`, undefined, {
    ...workerEnv,
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  });
  const storagePayload = await storageMissing.json();
  assert.equal(storageMissing.status, 503);
  assert.equal(storagePayload.status, "storage-unavailable");
  assert.match(storagePayload.error, /保存領域を準備できませんでした/);

  for (const payload of [signingPayload, storagePayload]) {
    const text = JSON.stringify(payload);
    assert.equal(/INTERVIEW_|DB|RECORDINGS|OPENAI/.test(text), false);
  }
});

test("connection check stays available on the fixed URL while signed invites are required", async () => {
  const env = {
    ...workerEnv,
    DB: new FakeD1(),
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  };
  // The connection check is client-only, so the portal itself must still be served
  // on the fixed URL even though no interview can be started from it.
  const page = await request("/", { headers: { accept: "text/html" } }, env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /接続確認（選考対象外）/);
});

test("invite pre-flight opens up only when signed invites are not required", async () => {
  const response = await request("/api/interviews/invite", undefined, { ...workerEnv, DB: new FakeD1() });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.status, "ok");
  assert.equal(payload.inviteRequired, false);
});

test("common entry URL creates separate sessions and throttles repeated paid starts", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "test-admin-secret",
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "false",
  };
  const start = (candidateName, address = "203.0.113.10", userAgent = "TOKYO-DOGS-COMMON-ENTRY-TEST") => request("/api/interviews/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": address,
      "User-Agent": userAgent,
    },
    body: JSON.stringify({
      candidateName,
      employment: "正社員",
      location: "越谷店",
      consent: true,
    }),
  }, env);

  const first = await start("共通 一郎");
  const second = await start("共通 二郎");
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstPayload = await first.json();
  const secondPayload = await second.json();
  assert.notEqual(firstPayload.sessionId, secondPayload.sessionId);
  assert.notEqual(firstPayload.accessToken, secondPayload.accessToken);
  assert.equal(database.publicEntries.length, 2);
  assert.equal("source_address" in database.publicEntries[0], false);
  assert.doesNotMatch(JSON.stringify(database.publicEntries), /203\.0\.113|共通/);

  assert.equal((await start("同一 応募者", "203.0.113.11")).status, 201);
  assert.equal((await start("同一 応募者", "203.0.113.11")).status, 201);
  assert.equal((await start("同一 応募者", "203.0.113.11")).status, 201);
  const throttled = await start("同一 応募者", "203.0.113.11");
  assert.equal(throttled.status, 429);
  assert.match((await throttled.json()).error, /時間を空けて/);

  for (let index = 0; index < 8; index += 1) {
    assert.equal((await start(`接続元制限 ${index}`, "203.0.113.12")).status, 201);
  }
  const sourceThrottled = await start("接続元制限 9", "203.0.113.12");
  assert.equal(sourceThrottled.status, 429);

  for (let index = 0; index < 8; index += 1) {
    assert.equal((await start(`UA変更制限 ${index}`, "203.0.113.13", `FORGED-UA-${index}`)).status, 201);
  }
  assert.equal((await start("UA変更制限 9", "203.0.113.13", "FORGED-UA-9")).status, 429);

  let globalIndex = 0;
  while (database.publicEntries.length < 60) {
    assert.equal((await start(`全体上限 ${globalIndex}`, `198.51.100.${globalIndex + 1}`)).status, 201);
    globalIndex += 1;
  }
  assert.equal((await start("全体上限 超過", "192.0.2.200")).status, 429);

  const issuedResponse = await request("/api/admin/interviews/invite", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-admin-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresInHours: 24 }),
  }, env);
  assert.equal(issuedResponse.status, 201);
  const individualToken = new URL((await issuedResponse.json()).link).searchParams.get("invite");
  const individual = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "個別 招待者",
      employment: "正社員",
      location: "越谷店",
      consent: true,
      inviteToken: individualToken,
    }),
  }, env);
  assert.equal(individual.status, 201);
  const reused = await request(`/api/interviews/invite?token=${encodeURIComponent(individualToken)}`, undefined, env);
  assert.equal(reused.status, 403);
  assert.equal((await reused.json()).status, "used");
});

test("invite pre-flight rejects cross-origin callers", async () => {
  const response = await request("/api/interviews/invite", {
    headers: { Origin: "https://attacker.example" },
  }, {
    ...workerEnv,
    DB: new FakeD1(),
    INTERVIEW_INVITE_SIGNING_SECRET: "test-signing-secret-with-sufficient-entropy",
    INTERVIEW_REQUIRE_SIGNED_INVITE: "true",
  });
  assert.equal(response.status, 403);
});

test("candidate can freely enter one or more preferred work locations and the server normalizes them", async () => {
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const response = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "テスト 応募者",
      employment: "正社員",
      location: "  新宿エリア   または越谷店（配属相談希望）  ",
      consent: true,
    }),
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(
    database.sessions.get(payload.sessionId).preferred_location,
    "新宿エリア または越谷店(配属相談希望)",
  );

  const missing = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "   ", consent: true }),
  }, env);
  assert.equal(missing.status, 400);

  const tooLong = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "店".repeat(121), consent: true }),
  }, env);
  assert.equal(tooLong.status, 400);
});

test("text interview starts without camera or recording and is visible as a technical mode event", async () => {
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "文字面接 テスト",
      employment: "アルバイト・パート",
      location: "希望店舗は相談",
      consent: true,
      interviewMode: "text",
    }),
  }, env);
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 201);

  const startResponse = await request("/api/interviews/text/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
    },
  }, env);
  assert.equal(startResponse.status, 200, await startResponse.clone().text());
  assert.deepEqual(await startResponse.json(), { started: true, recordingRequired: false });
  assert.equal(database.sessions.get(session.sessionId).status, "in_progress");
  assert.equal(database.sessions.get(session.sessionId).recording_status, "not_applicable");
  assert.equal(database.auditEvents.some((event) =>
    event.session_id === session.sessionId &&
    event.event_type === "reasonable_accommodation_text_selected"), true);
});

test("interview session stores the candidate name and protects the recording with a scoped bearer token", async () => {
  process.env.INTERVIEW_STAFF_TOKEN = "staff-review-secret";
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "山田 花子",
      employment: "正社員",
      location: "越谷店",
      consent: true,
    }),
  }, env);
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 201);
  assert.match(session.sessionId, /^TD-[A-Z0-9-]{6,40}$/);
  assert.equal(typeof session.accessToken, "string");
  assert.ok(session.accessToken.length > 20);
  assert.notEqual(database.sessions.get(session.sessionId).access_token_hash, session.accessToken);
  assert.equal(database.sessions.get(session.sessionId).candidate_name, "山田 花子");
  assert.equal(session.retentionDays, 365);
  assert.match(session.retentionUntil, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(database.sessions.get(session.sessionId).retention_until, session.retentionUntil);
  database.sessions.get(session.sessionId).status = "in_progress";

  const recordingBody = new TextEncoder().encode("small-webm-fixture");
  const uploadResponse = await request("/api/interviews/recording", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "X-Interview-Audio-Coverage": "both",
      "Content-Type": "video/webm",
      "Content-Length": String(recordingBody.byteLength),
    },
    body: recordingBody,
  }, env);
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200);
  assert.equal(upload.stored, true);
  assert.equal("objectKey" in upload, false);
  const storedObjectKey = `interviews/${session.sessionId}/recording.webm`;
  assert.equal(recordings.objects.has(storedObjectKey), true);
  assert.equal(recordings.objects.get(storedObjectKey).options.customMetadata.retentionUntil, session.retentionUntil);
  assert.equal(recordings.objects.get(storedObjectKey).options.customMetadata.audioCoverage, "both");
  assert.equal(database.sessions.get(session.sessionId).recording_status, "stored");

  const duplicate = await request("/api/interviews/recording", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "Content-Type": "video/webm",
      "Content-Length": String(recordingBody.byteLength),
    },
    body: recordingBody,
  }, env);
  assert.equal(duplicate.status, 409);
  assert.equal(recordings.putCount, 1);

  const unauthorized = await request("/api/interviews/recording", {
    method: "POST",
    headers: {
      "X-Interview-Session": session.sessionId,
      "Content-Type": "video/webm",
      "Content-Length": String(recordingBody.byteLength),
    },
    body: recordingBody,
  }, env);
  assert.equal(unauthorized.status, 401);
  assert.equal(typeof worker.scheduled, "function");
  assert.equal(recordings.objects.has(storedObjectKey), true);

  const protectedRecording = await request(`/api/staff/recording?sessionId=${session.sessionId}`, {}, env);
  assert.equal(protectedRecording.status, 401);
  const staffRecording = await request(`/api/staff/recording?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  assert.equal(staffRecording.status, 200);
  assert.equal(staffRecording.headers.get("content-type"), "video/webm");
  assert.equal(staffRecording.headers.get("x-interview-audio-coverage"), "both");
  assert.equal(await staffRecording.text(), "small-webm-fixture");

  const missingOperatorName = await request(`/api/staff/recording?sessionId=${session.sessionId}`, {
    headers: { Authorization: "Bearer staff-review-secret" },
  }, env);
  assert.equal(missingOperatorName.status, 401);
  const malformedOperatorName = await request(`/api/staff/recording?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": "%E0%A4%A",
    },
  }, env);
  assert.equal(malformedOperatorName.status, 401);
  const oversizedOperatorName = await request(`/api/staff/recording?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": "a".repeat(41),
    },
  }, env);
  assert.equal(oversizedOperatorName.status, 401);
});

test("staff inbox lists recent candidates with one shared login and records list access", async () => {
  process.env.INTERVIEW_STAFF_TOKEN = "staff-review-secret";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const first = await createTestInterviewSession(env, "正社員", "越谷店");
  const second = await createTestInterviewSession(env, "アルバイト・パート", "新宿エリア");
  database.sessions.get(first.sessionId).candidate_name = "山田 花子";
  database.sessions.get(second.sessionId).candidate_name = "佐藤 太郎";
  database.sessions.get(second.sessionId).status = "completed";
  database.sessions.get(second.sessionId).recording_status = "not_applicable";
  database.sessions.get(second.sessionId).transcript_json = JSON.stringify([
    {
      id: "candidate-answer-1",
      speaker: "candidate",
      text: "接客経験があり、安全確認を大切にしています。",
      createdAt: "2026-07-29T02:50:10.000Z",
    },
  ]);
  database.externalSyncs.set(second.sessionId, {
    status: "completed",
    folder_url: "https://drive.google.com/drive/folders/test",
    manifest_json: JSON.stringify({
      recordingIncluded: false,
      transcriptAvailable: true,
      transcriptKind: "actual_transcript",
    }),
  });

  const unauthorized = await request("/api/staff/interviews", {}, env);
  assert.equal(unauthorized.status, 401);
  const response = await request("/api/staff/interviews", {
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当C"),
    },
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.interviews.length, 2);
  assert.deepEqual(new Set(payload.interviews.map((item) => item.candidateName)), new Set(["山田 花子", "佐藤 太郎"]));
  const archived = payload.interviews.find((item) => item.sessionId === second.sessionId);
  assert.equal(archived.driveStatus, "completed");
  assert.equal(archived.driveFolderUrl, "https://drive.google.com/drive/folders/test");
  assert.deepEqual(payload.archiveHealth, {
    completedInterviews: 1,
    stored: 1,
    processing: 0,
    attention: 0,
    autoRecoveryScheduled: 0,
  });
  assert.equal(database.staffAuditEvents.length, 1);
  assert.equal(database.staffAuditEvents[0].reviewer_name, "採用担当C");
  assert.deepEqual(JSON.parse(database.staffAuditEvents[0].detail_json), { resultCount: 2, limit: 50 });

  const pollingResponse = await request("/api/staff/interviews?poll=1", {
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当C"),
    },
  }, env);
  assert.equal(pollingResponse.status, 200);
  assert.equal(database.staffAuditEvents.length, 1, "15-second completion polling must not flood the audit table");
});

test("staff inbox cursor exposes all 70 records without making recovery depend on the newest 50", async () => {
  process.env.INTERVIEW_STAFF_TOKEN = "staff-review-secret";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const seed = await createTestInterviewSession(env);
  const base = database.sessions.get(seed.sessionId);
  database.sessions.clear();
  for (let index = 0; index < 70; index += 1) {
    const id = `TD-PAGE-${String(index).padStart(4, "0")}`;
    const createdAt = new Date(Date.UTC(2026, 7, 1, 0, 0, 0, index)).toISOString();
    database.sessions.set(id, {
      ...base,
      id,
      candidate_name: `テスト候補者${index}`,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }
  const headers = {
    Authorization: "Bearer staff-review-secret",
    "X-Interview-Reviewer": encodeURIComponent("採用担当C"),
  };
  const firstResponse = await request("/api/staff/interviews", { headers }, env);
  const firstPage = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(firstPage.interviews.length, 50);
  assert.equal(typeof firstPage.nextCursor, "string");

  const secondResponse = await request(
    `/api/staff/interviews?cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    { headers },
    env,
  );
  const secondPage = await secondResponse.json();
  assert.equal(secondResponse.status, 200);
  assert.equal(secondPage.interviews.length, 20);
  assert.equal(secondPage.nextCursor, null);
  const allIds = new Set([
    ...firstPage.interviews.map((item) => item.sessionId),
    ...secondPage.interviews.map((item) => item.sessionId),
  ]);
  assert.equal(allIds.size, 70);

  const invalid = await request("/api/staff/interviews?cursor=not-a-valid-cursor", { headers }, env);
  assert.equal(invalid.status, 400);
});

test("recording upload survives one transient D1 failure after the R2 object is already stored", async () => {
  process.env.INTERVIEW_STAFF_TOKEN = "staff-review-secret";
  class FlakyD1 extends FakeD1 {
    constructor() {
      super();
      this.artifactBatchAttempts = 0;
    }

    async batch(statements) {
      if (statements.some((statement) => statement.sql.startsWith("INSERT INTO interview_artifacts"))) {
        this.artifactBatchAttempts += 1;
        if (this.artifactBatchAttempts === 1) throw new Error("D1_TRANSIENT_TEST_FAILURE");
      }
      return super.batch(statements);
    }
  }
  const database = new FlakyD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  const session = await sessionResponse.json();
  database.sessions.get(session.sessionId).status = "in_progress";

  const recordingBody = new TextEncoder().encode("small-webm-fixture");
  const storedObjectKey = `interviews/${session.sessionId}/recording.webm`;
  const uploadResponse = await request("/api/interviews/recording", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "Content-Type": "video/webm",
      "Content-Length": String(recordingBody.byteLength),
    },
    body: recordingBody,
  }, env);
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200);
  assert.equal(upload.stored, true);
  assert.equal(database.artifactBatchAttempts, 2);
  // The R2 object must not be re-uploaded or lost across the retry: it was already
  // durably stored before the first (failing) D1 write attempt.
  assert.equal(recordings.objects.has(storedObjectKey), true);
  assert.equal(database.sessions.get(session.sessionId).recording_status, "stored");
  assert.equal(database.artifacts.some((row) => row[2] === storedObjectKey), true);
});

test("resumable recording upload resumes 14 parts without opening stored body streams", async () => {
  process.env.INTERVIEW_STAFF_TOKEN = "staff-review-secret";
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidateName: "分割送信 テスト",
      employment: "正社員",
      location: "越谷店",
      consent: true,
      interviewMode: "camera",
    }),
  }, env);
  const session = await sessionResponse.json();
  database.sessions.get(session.sessionId).status = "in_progress";
  const partSize = 256 * 1024;
  const lastSize = 123;
  const totalParts = 14;
  const byteSize = partSize * (totalParts - 1) + lastSize;
  const commonHeaders = {
    Authorization: `Bearer ${session.accessToken}`,
    "X-Interview-Session": session.sessionId,
  };
  const start = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { ...commonHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      contentType: "video/webm",
      byteSize,
      partSize,
      totalParts,
      audioCoverage: "both",
      uploadVersion: 2,
    }),
  }, env);
  assert.equal(start.status, 200, await start.clone().text());
  assert.deepEqual((await start.json()).uploadedParts, []);

  const uploadPart = async (index, size, fill) => {
    const body = new Uint8Array(size).fill(fill);
    const part = await request("/api/interviews/recording/upload/part", {
      method: "PUT",
      headers: {
        ...commonHeaders,
        "Content-Type": "application/octet-stream",
        "X-Recording-Part-Index": String(index),
        "X-Recording-Part-Bytes": String(size),
        "X-Recording-Part-Sha256": sha256Hex(body),
      },
      body,
    }, env);
    assert.equal(part.status, 200, await part.clone().text());
    return await part.json();
  };

  const digestRequiredBody = new Uint8Array(partSize).fill(65);
  const serverDigested = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...commonHeaders,
      "Content-Type": "application/octet-stream",
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(partSize),
    },
    body: digestRequiredBody,
  }, env);
  assert.equal(serverDigested.status, 200, await serverDigested.clone().text());
  const malformedDigest = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...commonHeaders,
      "Content-Type": "application/octet-stream",
      "X-Recording-Part-Index": "1",
      "X-Recording-Part-Bytes": String(partSize),
      "X-Recording-Part-Sha256": "not-a-sha256",
    },
    body: new Uint8Array(partSize).fill(66),
  }, env);
  assert.equal(malformedDigest.status, 400, "a malformed declared digest must fail");
  assert.equal(recordings.objects.has(`interviews/${session.sessionId}/recording-parts/part-000`), true);
  assert.equal(recordings.objects.has(`interviews/${session.sessionId}/recording-parts/part-001`), false);

  for (let index = 0; index < 7; index += 1) {
    await uploadPart(index, partSize, 65 + index);
  }

  const firstPartObject = recordings.objects.get(`interviews/${session.sessionId}/recording-parts/part-000`);
  const firstPartDigest = sha256Hex(new Uint8Array(partSize).fill(65));
  assert.equal(firstPartObject.options.sha256, firstPartDigest, "R2 must validate the supplied checksum while storing");
  assert.equal(firstPartObject.options.customMetadata.sha256, firstPartDigest, "resume metadata must retain the checksum");
  const firstPartHead = await recordings.head(`interviews/${session.sessionId}/recording-parts/part-000`);
  assert.equal(Buffer.from(firstPartHead.checksums.sha256).toString("hex"), firstPartDigest);

  const duplicate = await uploadPart(0, partSize, 65);
  assert.equal(duplicate.duplicate, true);
  const conflictingBody = new Uint8Array(partSize).fill(66);
  const conflictingDuplicate = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...commonHeaders,
      "Content-Type": "application/octet-stream",
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(partSize),
      "X-Recording-Part-Sha256": sha256Hex(conflictingBody),
    },
    body: conflictingBody,
  }, env);
  assert.equal(conflictingDuplicate.status, 409, "same-size replacement bytes must never be accepted as a duplicate");
  assert.equal(recordings.objects.get(`interviews/${session.sessionId}/recording-parts/part-000`).body[0], 65);
  const forgedBody = new Uint8Array(partSize).fill(72);
  const forgedDigest = sha256Hex(new Uint8Array(partSize).fill(73));
  const forgedUpload = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...commonHeaders,
      "Content-Type": "application/octet-stream",
      "X-Recording-Part-Index": "7",
      "X-Recording-Part-Bytes": String(partSize),
      "X-Recording-Part-Sha256": forgedDigest,
    },
    body: forgedBody,
  }, env);
  assert.equal(forgedUpload.status, 400, "the server must reject a forged body/digest pair before R2 storage");
  assert.equal(recordings.objects.has(`interviews/${session.sessionId}/recording-parts/part-007`), false);
  const getCountBeforeResume = recordings.getCount;
  const headCountBeforeResume = recordings.headCount;
  const resume = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { ...commonHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      contentType: "video/webm",
      byteSize,
      partSize,
      totalParts,
      audioCoverage: "both",
      uploadVersion: 2,
    }),
  }, env);
  const resumed = await resume.json();
  assert.equal(resume.status, 200, JSON.stringify(resumed));
  assert.deepEqual(resumed.uploadedParts, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(recordings.getCount, getCountBeforeResume + 1, "resume may read only the small upload state body");
  assert.equal(recordings.headCount, headCountBeforeResume + totalParts, "resume must use metadata-only head for every part");

  for (let index = 7; index < totalParts; index += 1) {
    const size = index === totalParts - 1 ? lastSize : partSize;
    await uploadPart(index, size, 65 + index);
  }

  const getCountBeforeComplete = recordings.getCount;
  const headCountBeforeComplete = recordings.headCount;
  const complete = await request("/api/interviews/recording/upload/complete", {
    method: "POST",
    headers: commonHeaders,
  }, env);
  const completed = await complete.json();
  assert.equal(complete.status, 200, JSON.stringify(completed));
  assert.equal(completed.stored, true);
  assert.equal(completed.totalParts, totalParts);
  // Finalization must inspect metadata without opening unread R2 body streams.
  // Opening one body per part exhausts Worker connections on real 15-27 minute
  // Android recordings and leaves the completion request hanging.
  assert.equal(recordings.getCount, getCountBeforeComplete + 1, "finalize may read only the small upload state body");
  assert.equal(recordings.headCount, headCountBeforeComplete + totalParts);
  assert.equal(database.sessions.get(session.sessionId).recording_status, "stored");
  assert.equal(database.artifacts.some((row) => String(row[2]).endsWith("recording.manifest.json")), true);
  const manifestObject = recordings.objects.get(`interviews/${session.sessionId}/recording.manifest.json`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestObject.body));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.parts.length, totalParts);
  assert.equal(manifest.parts.every((part) => /^[a-f0-9]{64}$/.test(part.sha256)), true);

  const staffRecording = await request(`/api/staff/recording?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当"),
    },
  }, env);
  assert.equal(staffRecording.status, 200);
  assert.equal(Number(staffRecording.headers.get("content-length")), byteSize);
  const recording = new Uint8Array(await staffRecording.arrayBuffer());
  assert.equal(recording.length, byteSize);
  assert.equal(recording[0], 65);
  assert.equal(recording.at(-1), 65 + totalParts - 1);
});

test("voice transcript seal is authenticated, fail-closed, and exactly idempotent without completing the interview", async () => {
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  // Realtime call coverage separately proves that only a successful upstream
  // voice connection moves a production session into this state.
  stored.status = "in_progress";
  assert.equal(stored.status, "in_progress");
  const transcript = [
    { id: "voice-question-1", speaker: "interviewer", text: "志望理由を教えてください。", createdAt: "2026-08-12T10:00:00.000Z" },
    { id: "voice-answer-1", speaker: "candidate", text: " 犬とご家族に誠実に向き合います。 ", createdAt: "2026-08-12T10:00:10.000Z" },
  ];

  const incomplete = await sealVoiceTranscript(env, session, transcript, false);
  assert.equal(incomplete.status, 400);
  assert.equal(stored.transcript_json, undefined);

  const interviewerOnly = await sealVoiceTranscript(env, session, transcript.slice(0, 1));
  assert.equal(interviewerOnly.status, 400);
  assert.equal(stored.transcript_json, undefined);

  const unauthorized = await request("/api/interviews/voice/transcript/seal", {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId, transcript, transcriptionComplete: true }),
  }, env);
  assert.equal(unauthorized.status, 401);

  const crossOrigin = await request("/api/interviews/voice/transcript/seal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
    },
    body: JSON.stringify({ sessionId: session.sessionId, transcript, transcriptionComplete: true }),
  }, env);
  assert.equal(crossOrigin.status, 403);

  const first = await sealVoiceTranscript(env, session, transcript);
  const firstPayload = await first.json();
  assert.equal(first.status, 200, JSON.stringify(firstPayload));
  assert.deepEqual(firstPayload, { sealed: true, alreadySealed: false, turnCount: 2 });
  assert.equal(stored.status, "in_progress", "a transcript seal is not an interview completion receipt");
  assert.equal(JSON.parse(stored.transcript_json)[1].text, "犬とご家族に誠実に向き合います。");
  assert.equal(database.auditEvents.filter((event) =>
    event.session_id === session.sessionId && event.event_type === "voice_transcript_sealed").length, 1);

  const replay = await sealVoiceTranscript(env, session, transcript);
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal((await replay.json()).alreadySealed, true);
  assert.equal(database.auditEvents.filter((event) =>
    event.session_id === session.sessionId && event.event_type === "voice_transcript_sealed").length, 1);

  const conflicting = await sealVoiceTranscript(env, session, [
    transcript[0],
    { ...transcript[1], text: "後から別内容へ差し替えます。" },
  ]);
  assert.equal(conflicting.status, 409);
  assert.equal(JSON.parse(stored.transcript_json)[1].text, "犬とご家族に誠実に向き合います。");

  // A lost HTTP response can be replayed even after a separate evaluation has
  // completed; the exact transcript still gets a 200 durable receipt.
  stored.status = "completed";
  const completedReplay = await sealVoiceTranscript(env, session, transcript);
  assert.equal(completedReplay.status, 200, await completedReplay.clone().text());
  assert.equal((await completedReplay.json()).alreadySealed, true);
});

test("recorded fallback mode cannot forge the normal voice transcript recovery fence", async () => {
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const session = await createTestInterviewSession(env);
  const started = await request("/api/interviews/recorded/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
    },
  }, env);
  assert.equal(started.status, 200);
  assert.equal(database.auditEvents.some((event) =>
    event.session_id === session.sessionId && event.event_type === "recorded_fallback_started"), true);

  const forged = await sealVoiceTranscript(env, session, [{
    id: "placeholder-answer",
    speaker: "candidate",
    text: "回答音声に記録されています。",
    createdAt: "2026-08-12T10:00:10.000Z",
  }]);
  assert.equal(forged.status, 409);
  assert.equal(database.auditEvents.some((event) =>
    event.session_id === session.sessionId && event.event_type === "voice_transcript_sealed"), false);
});

test("candidate technical incidents are audited and cross-origin mutations are rejected", async () => {
  process.env.INTERVIEW_STAFF_TOKEN = "staff-review-secret";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const rejected = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  assert.equal(rejected.status, 403);

  // A spoofed X-Forwarded-Host must not be able to make an attacker's own Origin pass
  // the same-origin check, since it is an ordinary header any cross-origin fetch() can set.
  const spoofed = await request("/api/interviews/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
      "X-Forwarded-Host": "attacker.example",
      "X-Forwarded-Proto": "https",
    },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  assert.equal(spoofed.status, 403);

  const session = await createTestInterviewSession(env);
  const incident = await request("/api/interviews/event", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
      Origin: "http://localhost",
    },
    body: JSON.stringify({
      sessionId: session.sessionId,
      eventType: "transcription_failed",
      code: "TRANSCRIPTION_FAILED",
    }),
  }, env);
  assert.equal(incident.status, 200);
  assert.equal(database.auditEvents.some((event) => event.event_type === "transcription_failed"), true);

  const staffResponse = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const staffPayload = await staffResponse.json();
  assert.equal(staffResponse.status, 200);
  assert.equal(staffPayload.review.technicalEvents[0].type, "transcription_failed");
  assert.equal(staffPayload.review.sourceTranscriptVerified, false);
});

test("recorded contingency requires all 15 actual answer transcriptions before completion", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const upstreamRequests = [];
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    OPENAI_API_KEY: "test-key-never-returned",
    OPENAI_API: {
      fetch: async (upstreamRequest) => {
        upstreamRequests.push(upstreamRequest);
        const form = await upstreamRequest.clone().formData();
        const file = form.get("file");
        assert.equal(form.get("model"), "gpt-4o-transcribe");
        assert.equal(form.get("language"), "ja");
        assert.ok(file instanceof File);
        const index = Number(file.name.match(/answer-(\d+)/)?.[1]);
        return Response.json({ text: `応募者の実際の回答${index}` });
      },
    },
  };
  const session = await createTestInterviewSession(env);

  const unauthorized = await request("/api/interviews/recorded/start", {
    method: "POST",
    headers: { "X-Interview-Session": session.sessionId },
  }, env);
  assert.equal(unauthorized.status, 401);

  const start = await request("/api/interviews/recorded/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
    },
  }, env);
  assert.equal(start.status, 200);
  assert.deepEqual(await start.json(), { started: true });
  assert.equal(database.sessions.get(session.sessionId).status, "in_progress");
  database.sessions.get(session.sessionId).recording_status = "stored";

  const unsealed = await request("/api/interviews/recorded/complete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: 15 }),
  }, env);
  assert.equal(unsealed.status, 409, "recording storage alone must never infer the intended answer count");
  assert.equal(database.sessions.get(session.sessionId).status, "in_progress");

  await sealRecordedCompletion(env, session, 15);

  const premature = await request("/api/interviews/recorded/complete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: 15 }),
  }, env);
  const prematurePayload = await premature.json();
  assert.equal(premature.status, 409);
  assert.equal(prematurePayload.transcriptionPending, true);
  assert.equal(prematurePayload.completedAnswerCount, 0);
  assert.deepEqual(prematurePayload.missingAnswerIndexes, Array.from({ length: 15 }, (_, index) => index + 1));
  assert.equal(database.sessions.get(session.sessionId).transcript_json, undefined, "placeholder transcript must never be saved");

  for (let answerIndex = 1; answerIndex <= 15; answerIndex += 1) {
    const bytes = new TextEncoder().encode(`valid-independent-webm-answer-${answerIndex}`);
    const answer = await request("/api/interviews/recorded/answer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "audio/webm;codecs=opus",
        "X-Interview-Session": session.sessionId,
        "X-Recorded-Answer-Index": String(answerIndex),
        "X-Recorded-Answer-Bytes": String(bytes.byteLength),
      },
      body: bytes,
    }, env);
    const answerPayload = await answer.json();
    assert.equal(answer.status, 200, JSON.stringify(answerPayload));
    assert.deepEqual(answerPayload, {
      stored: true,
      transcribed: true,
      answerIndex,
      alreadyCompleted: false,
    });
  }
  assert.equal(upstreamRequests.length, 15);
  assert.ok(upstreamRequests.every((upstreamRequest) =>
    upstreamRequest.url === "https://api.openai.com/v1/audio/transcriptions"));
  assert.ok(upstreamRequests.every((upstreamRequest) =>
    upstreamRequest.headers.get("Authorization") === "Bearer test-key-never-returned"));
  assert.equal(recordings.putCount, 15);

  const complete = await request("/api/interviews/recorded/complete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: 15 }),
  }, env);
  const payload = await complete.json();
  assert.equal(complete.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload, { stored: true, humanReviewRequired: true });

  const stored = database.sessions.get(session.sessionId);
  assert.equal(stored.status, "completed");
  const transcript = JSON.parse(stored.transcript_json);
  const evaluation = JSON.parse(stored.evaluation_json);
  assert.equal(transcript.length, 30);
  assert.equal(transcript.filter((turn) => turn.speaker === "candidate").length, 15);
  assert.deepEqual(
    transcript.filter((turn) => turn.speaker === "candidate").map((turn) => turn.text),
    Array.from({ length: 15 }, (_, index) => `応募者の実際の回答${index + 1}`),
  );
  assert.ok(transcript.every((turn) => !/録画音声に記録/.test(turn.text)));
  assert.equal(evaluation.recommendation, "human_review");
  assert.equal(evaluation.humanReviewRequired, true);
  assert.ok(evaluation.dimensions.every((dimension) => dimension.score === null));
  assert.match(evaluation.summary, /自動文字起こしは完了/);

  const replay = await request("/api/interviews/recorded/complete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: 15 }),
  }, env);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { stored: true, humanReviewRequired: true, alreadyCompleted: true });
});

test("recorded contingency can complete a stopped interview with only its answered questions", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    OPENAI_API_KEY: "test-key-never-returned",
    OPENAI_API: {
      fetch: async (upstreamRequest) => {
        const file = (await upstreamRequest.formData()).get("file");
        assert.ok(file instanceof File);
        return Response.json({ text: `途中終了の実回答${Number(file.name.match(/answer-(\d+)/)?.[1])}` });
      },
    },
  };
  const session = await createTestInterviewSession(env);
  await request("/api/interviews/recorded/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
    },
  }, env);
  await sealRecordedCompletion(env, session, 3);
  database.sessions.get(session.sessionId).recording_status = "stored";
  for (let answerIndex = 1; answerIndex <= 3; answerIndex += 1) {
    const bytes = new TextEncoder().encode(`partial-answer-${answerIndex}`);
    const response = await request("/api/interviews/recorded/answer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "X-Interview-Session": session.sessionId,
        "X-Recorded-Answer-Index": String(answerIndex),
        "X-Recorded-Answer-Bytes": String(bytes.byteLength),
        "Content-Type": "audio/webm",
      },
      body: bytes,
    }, env);
    assert.equal(response.status, 200);
  }
  const understated = await request("/api/interviews/recorded/complete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: 2 }),
  }, env);
  assert.equal(understated.status, 409, "client must not omit a higher answer already stored on the server");
  const completed = await request("/api/interviews/recorded/complete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: 3 }),
  }, env);
  assert.equal(completed.status, 200, JSON.stringify(await completed.clone().json()));
  const transcript = JSON.parse(database.sessions.get(session.sessionId).transcript_json);
  assert.equal(transcript.length, 6);
  assert.deepEqual(
    transcript.filter((turn) => turn.speaker === "candidate").map((turn) => turn.text),
    ["途中終了の実回答1", "途中終了の実回答2", "途中終了の実回答3"],
  );
});

test("recorded answer keeps durable audio pending across OpenAI quota failure and retries without re-upload", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  let upstreamCalls = 0;
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    OPENAI_API_KEY: "test-key-never-returned",
    OPENAI_API: {
      fetch: async () => {
        upstreamCalls += 1;
        if (upstreamCalls === 1) {
          return Response.json(
            { error: {
              code: "insufficient_quota",
              type: "insufficient_quota",
              message: "test-key-never-returned one-independent-valid-webm-answer テスト 応募者",
            } },
            { status: 429, headers: { "Retry-After": "2", "x-request-id": "req_abc123def456" } },
          );
        }
        return Response.json({ text: "再試行で復旧した実回答" });
      },
    },
  };
  const session = await createTestInterviewSession(env);
  await request("/api/interviews/recorded/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
    },
  }, env);
  const bytes = new TextEncoder().encode("one-independent-valid-webm-answer");
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    "X-Interview-Session": session.sessionId,
    "X-Recorded-Answer-Index": "1",
  };
  const capturedFirst = await captureConsoleWarnings(() => request("/api/interviews/recorded/answer", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "audio/webm",
        "X-Recorded-Answer-Bytes": String(bytes.byteLength),
      },
      body: bytes,
    }, env));
  const first = capturedFirst.value;
  const firstPayload = await first.json();
  assert.equal(first.status, 202);
  assert.equal(firstPayload.stored, true);
  assert.equal(firstPayload.transcribed, false);
  assert.equal(first.headers.get("retry-after"), "2");
  const pending = database.recordedAnswers.get(`${session.sessionId}:1`);
  assert.equal(pending.status, "pending");
  assert.equal(pending.last_error_code, "insufficient_quota");
  assert.equal(recordings.putCount, 1);
  assert.equal(database.auditEvents.filter((event) => event.event_type === "transcription_failed").length, 1);
  assert.doesNotMatch(database.auditEvents.at(-1).detail_json, /one-independent-valid-webm-answer/);
  assert.equal(capturedFirst.warnings.length, 1);
  assert.equal(capturedFirst.warnings[0][0], "RECORDED_ANSWER_TRANSCRIPTION_RETRYABLE_FAILURE");
  assert.deepEqual(capturedFirst.warnings[0][1], {
    status: 429,
    code: "insufficient_quota",
    requestId: "req_abc123def456",
    sessionIdHash: capturedFirst.warnings[0][1].sessionIdHash,
    answerIndex: 1,
    retryAfterSeconds: 2,
    attempt: 1,
  });
  assert.match(capturedFirst.warnings[0][1].sessionIdHash, /^[a-f0-9]{32}$/);
  const safeLog = JSON.stringify(capturedFirst.warnings);
  assert.equal(safeLog.includes(session.sessionId), false);
  assert.equal(safeLog.includes("test-key-never-returned"), false);
  assert.equal(safeLog.includes("one-independent-valid-webm-answer"), false);
  assert.equal(safeLog.includes("テスト 応募者"), false);

  const tooEarly = await request("/api/interviews/recorded/answer", {
    method: "POST",
    headers,
    body: new Uint8Array(0),
  }, env);
  assert.equal(tooEarly.status, 202);
  assert.equal((await tooEarly.json()).pending, true);
  assert.equal(upstreamCalls, 1, "Retry-After must suppress immediate paid retries");

  pending.next_retry_at = new Date(0).toISOString();
  // Cloudflare/Vinext may normalize an omitted POST body to a truthy, empty
  // ReadableStream. This is still the body-less retry contract because no
  // X-Recorded-Answer-Bytes upload declaration is present.
  const capturedSuccess = await captureConsoleWarnings(() => request("/api/interviews/recorded/answer", {
      method: "POST",
      headers,
      body: new Uint8Array(0),
    }, env));
  const retried = capturedSuccess.value;
  assert.equal(retried.status, 200, JSON.stringify(await retried.clone().json()));
  assert.equal((await retried.json()).transcribed, true);
  assert.equal(upstreamCalls, 2);
  assert.equal(recordings.putCount, 1, "body-less retry must reuse the exact durable R2 object");
  assert.equal(database.recordedAnswers.get(`${session.sessionId}:1`).transcript_text, "再試行で復旧した実回答");
  assert.deepEqual(capturedSuccess.warnings, [], "successful transcription must not emit a warning");

  const completedReplay = await request("/api/interviews/recorded/answer", {
    method: "POST",
    headers,
    body: new Uint8Array(0),
  }, env);
  const completedPayload = await completedReplay.json();
  assert.equal(completedReplay.status, 200, JSON.stringify(completedPayload));
  assert.equal(completedPayload.transcribed, true);
  assert.equal(completedPayload.alreadyCompleted, true);
  assert.equal(upstreamCalls, 2, "a completed body-less replay must not call OpenAI again");
  assert.equal(recordings.putCount, 1, "a completed body-less replay must not re-upload audio");
});

test("forced 202 flow stores every recording part before a bodyless answer retry and completes", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  let upstreamCalls = 0;
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    OPENAI_API_KEY: "test-key-never-returned",
    OPENAI_API: {
      fetch: async () => {
        upstreamCalls += 1;
        if (upstreamCalls === 1) {
          return Response.json(
            { error: { code: "rate_limit_exceeded" } },
            { status: 429, headers: { "Retry-After": "2" } },
          );
        }
        return Response.json({ text: "録画確定後の再試行で復旧した実回答" });
      },
    },
  };
  const session = await createTestInterviewSession(env);
  const authorization = `Bearer ${session.accessToken}`;
  const candidateHeaders = {
    Authorization: authorization,
    "X-Interview-Session": session.sessionId,
  };
  const recordedStart = await request("/api/interviews/recorded/start", {
    method: "POST",
    headers: candidateHeaders,
  }, env);
  assert.equal(recordedStart.status, 200, await recordedStart.clone().text());

  const answerBytes = new TextEncoder().encode("forced-202-answer-stored-before-recording");
  const capturedInitial = await captureConsoleWarnings(() => request("/api/interviews/recorded/answer", {
    method: "POST",
    headers: {
      ...candidateHeaders,
      "Content-Type": "audio/webm",
      "X-Recorded-Answer-Index": "1",
      "X-Recorded-Answer-Bytes": String(answerBytes.byteLength),
    },
    body: answerBytes,
  }, env));
  const initialAnswer = capturedInitial.value;
  const initialAnswerPayload = await initialAnswer.json();
  assert.equal(initialAnswer.status, 202, JSON.stringify(initialAnswerPayload));
  assert.deepEqual(initialAnswerPayload, {
    stored: true,
    transcribed: false,
    pending: true,
    answerIndex: 1,
    retryAfterSeconds: 2,
  });
  assert.equal(Number.isInteger(initialAnswerPayload.retryAfterSeconds), true);
  assert.ok(initialAnswerPayload.retryAfterSeconds > 0);
  assert.equal(initialAnswer.headers.get("Retry-After"), String(initialAnswerPayload.retryAfterSeconds));
  assert.equal(recordings.putCount, 1, "the initial answer audio must be durable before the 202 receipt");

  await sealRecordedCompletion(env, session, 1);

  const partSize = 256 * 1024;
  const recordingByteSize = partSize + 17;
  const totalParts = 2;
  const startPayload = {
    sessionId: session.sessionId,
    contentType: "video/webm",
    byteSize: recordingByteSize,
    partSize,
    totalParts,
    audioCoverage: "both",
    uploadVersion: 2,
  };
  const uploadStart = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { ...candidateHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(startPayload),
  }, env);
  const uploadStartPayload = await uploadStart.json();
  assert.equal(uploadStart.status, 200, JSON.stringify(uploadStartPayload));
  assert.deepEqual(uploadStartPayload, {
    stored: false,
    uploadVersion: 2,
    uploadedParts: [],
    uploadedPartReceipts: [],
    contentType: "video/webm",
    byteSize: recordingByteSize,
    partSize,
    totalParts,
    audioCoverage: "both",
  });

  const unauthenticatedPart = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      "X-Interview-Session": session.sessionId,
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(partSize),
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(partSize).fill(3),
  }, env);
  assert.equal(unauthenticatedPart.status, 401);
  assert.equal((await unauthenticatedPart.json()).index, undefined, "unauthenticated responses must not echo an index");

  const uploadPart = async (index, byteSize) => {
    const body = new Uint8Array(byteSize).fill(index + 11);
    const response = await request("/api/interviews/recording/upload/part", {
      method: "PUT",
      headers: {
        ...candidateHeaders,
        "X-Recording-Part-Index": String(index),
        "X-Recording-Part-Bytes": String(byteSize),
        "X-Recording-Part-Sha256": sha256Hex(body),
        "Content-Type": "application/octet-stream",
      },
      body,
    }, env);
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.deepEqual(payload, { stored: true, duplicate: false, index });
  };
  await uploadPart(0, partSize);
  await uploadPart(1, 17);
  const duplicatePart = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...candidateHeaders,
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(partSize),
      "X-Recording-Part-Sha256": sha256Hex(new Uint8Array(partSize).fill(11)),
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(partSize).fill(11),
  }, env);
  const duplicatePartPayload = await duplicatePart.json();
  assert.equal(duplicatePart.status, 200, JSON.stringify(duplicatePartPayload));
  assert.deepEqual(duplicatePartPayload, { stored: true, duplicate: true, index: 0 });

  const resume = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { ...candidateHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(startPayload),
  }, env);
  const resumePayload = await resume.json();
  assert.equal(resume.status, 200, JSON.stringify(resumePayload));
  assert.deepEqual(resumePayload.uploadedParts, [0, 1]);
  assert.equal(resumePayload.byteSize, recordingByteSize);
  assert.equal(resumePayload.partSize, partSize);
  assert.equal(resumePayload.totalParts, totalParts);

  const finalize = await request("/api/interviews/recording/upload/complete", {
    method: "POST",
    headers: candidateHeaders,
  }, env);
  const finalizePayload = await finalize.json();
  assert.equal(finalize.status, 200, JSON.stringify(finalizePayload));
  assert.deepEqual(finalizePayload, { stored: true, byteSize: recordingByteSize, totalParts });

  const pendingCompletion = await request("/api/interviews/recorded/complete", {
    method: "POST",
    headers: { ...candidateHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: 1 }),
  }, env);
  const pendingCompletionPayload = await pendingCompletion.json();
  assert.equal(pendingCompletion.status, 409, JSON.stringify(pendingCompletionPayload));
  assert.equal(pendingCompletionPayload.stored, false);
  assert.equal(pendingCompletionPayload.transcriptionPending, true);
  assert.equal(pendingCompletionPayload.completedAnswerCount, 0);
  assert.deepEqual(pendingCompletionPayload.missingAnswerIndexes, [1]);

  const finalizeReplay = await request("/api/interviews/recording/upload/complete", {
    method: "POST",
    headers: candidateHeaders,
  }, env);
  assert.equal(finalizeReplay.status, 200, await finalizeReplay.clone().text());
  assert.deepEqual(await finalizeReplay.json(), { stored: true, alreadyStored: true });
  const storedReadback = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { ...candidateHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(startPayload),
  }, env);
  const storedReadbackPayload = await storedReadback.json();
  assert.equal(storedReadback.status, 200, JSON.stringify(storedReadbackPayload));
  assert.deepEqual(storedReadbackPayload, {
    stored: true,
    uploadVersion: 2,
    uploadedParts: [0, 1],
    uploadedPartReceipts: [
      { index: 0, sha256: sha256Hex(new Uint8Array(partSize).fill(11)) },
      { index: 1, sha256: sha256Hex(new Uint8Array(17).fill(12)) },
    ],
    contentType: "video/webm",
    byteSize: recordingByteSize,
    partSize,
    totalParts,
    audioCoverage: "both",
  });

  database.recordedAnswers.get(`${session.sessionId}:1`).next_retry_at = new Date(0).toISOString();
  const r2PutCountBeforeRetry = recordings.putCount;
  const capturedRetry = await captureConsoleWarnings(() => request("/api/interviews/recorded/answer", {
    method: "POST",
    headers: {
      ...candidateHeaders,
      "X-Recorded-Answer-Index": "1",
    },
  }, env));
  const retriedAnswer = capturedRetry.value;
  const retriedAnswerPayload = await retriedAnswer.json();
  assert.equal(retriedAnswer.status, 200, JSON.stringify(retriedAnswerPayload));
  assert.deepEqual(retriedAnswerPayload, {
    stored: true,
    transcribed: true,
    answerIndex: 1,
    alreadyCompleted: false,
  });
  assert.equal(recordings.putCount, r2PutCountBeforeRetry, "bodyless retry must not upload any replacement object");
  assert.equal(upstreamCalls, 2);

  const completion = await request("/api/interviews/recorded/complete", {
    method: "POST",
    headers: { ...candidateHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: 1 }),
  }, env);
  const completionPayload = await completion.json();
  assert.equal(completion.status, 200, JSON.stringify(completionPayload));
  assert.deepEqual(completionPayload, { stored: true, humanReviewRequired: true });
  const transcript = JSON.parse(database.sessions.get(session.sessionId).transcript_json);
  assert.equal(transcript.find((turn) => turn.speaker === "candidate").text, "録画確定後の再試行で復旧した実回答");

  // This is the exact race contract used by the production E2E when staff
  // recovery completes the session before the candidate's bodyless retry.
  const answerAfterCompletion = await request("/api/interviews/recorded/answer", {
    method: "POST",
    headers: {
      ...candidateHeaders,
      "X-Recorded-Answer-Index": "1",
    },
  }, env);
  assert.equal(answerAfterCompletion.status, 409);
  const completionReplay = await request("/api/interviews/recorded/complete", {
    method: "POST",
    headers: { ...candidateHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: 1 }),
  }, env);
  const completionReplayPayload = await completionReplay.json();
  assert.equal(completionReplay.status, 200, JSON.stringify(completionReplayPayload));
  assert.deepEqual(completionReplayPayload, {
    stored: true,
    humanReviewRequired: true,
    alreadyCompleted: true,
  });
});

test("recorded transcription retry diagnostics sanitize upstream, timeout, and transport failures", async (t) => {
  class CorruptRecordedAnswerR2 extends FakeR2 {
    constructor(corruption) {
      super();
      this.corruption = corruption;
    }

    async get(key, options) {
      const object = await super.get(key, options);
      if (!object || !key.includes("/recorded-answers/")) return object;
      const originalArrayBuffer = object.arrayBuffer;
      return {
        ...object,
        arrayBuffer: async () => {
          const original = new Uint8Array(await originalArrayBuffer());
          if (this.corruption === "size") {
            const oversized = new Uint8Array(original.byteLength + 1);
            oversized.set(original);
            return oversized.buffer;
          }
          const changed = Uint8Array.from(original);
          changed[0] ^= 0xff;
          return changed.buffer;
        },
      };
    }
  }

  const cases = [
    {
      name: "retryable upstream response",
      fetch: async () => Response.json({
        error: {
          code: "unsafe/code/test-key-never-returned",
          message: "diagnostic-secret-audio-body テスト 応募者",
        },
      }, {
        status: 503,
        headers: { "x-request-id": "unsafe/request/test-key-never-returned" },
      }),
      expected: { status: 503, code: "http_503", requestId: "unavailable" },
    },
    {
      name: "timeout",
      fetch: async () => {
        const error = new Error("test-key-never-returned diagnostic-secret-audio-body テスト 応募者");
        error.name = "AbortError";
        throw error;
      },
      expected: { status: 0, code: "transcription_timeout", requestId: "unavailable" },
    },
    {
      name: "transport error",
      fetch: async () => {
        throw new Error("test-key-never-returned diagnostic-secret-audio-body テスト 応募者");
      },
      expected: { status: 0, code: "transcription_transport_error", requestId: "unavailable" },
    },
    {
      name: "stored audio size mismatch",
      recordings: () => new CorruptRecordedAnswerR2("size"),
      fetch: async () => { throw new Error("upstream must not run"); },
      expected: { status: 0, code: "recorded_answer_audio_size_mismatch", requestId: "unavailable" },
    },
    {
      name: "stored audio digest mismatch",
      recordings: () => new CorruptRecordedAnswerR2("digest"),
      fetch: async () => { throw new Error("upstream must not run"); },
      expected: { status: 0, code: "recorded_answer_audio_digest_mismatch", requestId: "unavailable" },
    },
    {
      name: "OpenAI key unconfigured",
      withoutApiKey: true,
      fetch: async () => { throw new Error("upstream must not run"); },
      expected: { status: 0, code: "openai_api_key_unconfigured", requestId: "unavailable" },
    },
  ];

  for (const diagnosticCase of cases) {
    await t.test(diagnosticCase.name, async () => {
      const database = new FakeD1();
      const recordings = diagnosticCase.recordings?.() ?? new FakeR2();
      const env = {
        ...workerEnv,
        DB: database,
        RECORDINGS: recordings,
        ...(diagnosticCase.withoutApiKey ? {} : { OPENAI_API_KEY: "test-key-never-returned" }),
        OPENAI_API: { fetch: diagnosticCase.fetch },
      };
      const session = await createTestInterviewSession(env);
      await request("/api/interviews/recorded/start", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "X-Interview-Session": session.sessionId,
        },
      }, env);
      const audioText = `diagnostic-secret-audio-body-${diagnosticCase.name}`;
      const bytes = new TextEncoder().encode(audioText);
      const previousApiKey = process.env.OPENAI_API_KEY;
      if (diagnosticCase.withoutApiKey) delete process.env.OPENAI_API_KEY;
      let captured;
      try {
        captured = await captureConsoleWarnings(() => request("/api/interviews/recorded/answer", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            "X-Interview-Session": session.sessionId,
            "X-Recorded-Answer-Index": "1",
            "X-Recorded-Answer-Bytes": String(bytes.byteLength),
            "Content-Type": "audio/webm",
          },
          body: bytes,
        }, env));
      } finally {
        if (diagnosticCase.withoutApiKey) {
          if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
          else process.env.OPENAI_API_KEY = previousApiKey;
        }
      }
      assert.equal(captured.value.status, 202, await captured.value.clone().text());
      assert.equal(captured.warnings.length, 1);
      const [eventName, detail] = captured.warnings[0];
      assert.equal(eventName, "RECORDED_ANSWER_TRANSCRIPTION_RETRYABLE_FAILURE");
      assert.equal(detail.status, diagnosticCase.expected.status);
      assert.equal(detail.code, diagnosticCase.expected.code);
      assert.equal(detail.requestId, diagnosticCase.expected.requestId);
      assert.match(detail.sessionIdHash, /^[a-f0-9]{32}$/);
      assert.equal(detail.answerIndex, 1);
      assert.equal(detail.retryAfterSeconds, 15);
      assert.equal(detail.attempt, 1);
      assert.equal(database.recordedAnswers.get(`${session.sessionId}:1`).last_error_code, diagnosticCase.expected.code);
      const serialized = JSON.stringify(captured.warnings);
      for (const forbidden of [
        session.sessionId,
        session.accessToken,
        "test-key-never-returned",
        audioText,
        "diagnostic-secret-audio-body",
        "テスト 応募者",
        "unsafe/request",
      ]) {
        assert.equal(serialized.includes(forbidden), false, `diagnostic log leaked: ${forbidden}`);
      }
    });
  }

  await t.test("durable R2 audio object missing", async () => {
    const database = new FakeD1();
    const recordings = new FakeR2();
    let upstreamCalls = 0;
    const env = {
      ...workerEnv,
      DB: database,
      RECORDINGS: recordings,
      OPENAI_API_KEY: "test-key-never-returned",
      OPENAI_API: {
        fetch: async () => {
          upstreamCalls += 1;
          return Response.json(
            { error: { code: "rate_limit_exceeded" } },
            { status: 429, headers: { "Retry-After": "1" } },
          );
        },
      },
    };
    const session = await createTestInterviewSession(env);
    await request("/api/interviews/recorded/start", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "X-Interview-Session": session.sessionId,
      },
    }, env);
    const audioText = "audio-object-missing-secret-body";
    const bytes = new TextEncoder().encode(audioText);
    await captureConsoleWarnings(() => request("/api/interviews/recorded/answer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "X-Interview-Session": session.sessionId,
        "X-Recorded-Answer-Index": "1",
        "X-Recorded-Answer-Bytes": String(bytes.byteLength),
        "Content-Type": "audio/webm",
      },
      body: bytes,
    }, env));
    const row = database.recordedAnswers.get(`${session.sessionId}:1`);
    row.next_retry_at = new Date(0).toISOString();
    recordings.objects.delete(row.object_key);

    const captured = await captureConsoleWarnings(() => request("/api/interviews/recorded/answer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "X-Interview-Session": session.sessionId,
        "X-Recorded-Answer-Index": "1",
      },
      body: new Uint8Array(0),
    }, env));
    const payload = await captured.value.json();
    assert.equal(captured.value.status, 202, JSON.stringify(payload));
    assert.equal(payload.retryAfterSeconds, 30);
    assert.equal(upstreamCalls, 1, "a missing R2 object must not call OpenAI");
    assert.equal(captured.warnings.length, 1);
    const [eventName, detail] = captured.warnings[0];
    assert.equal(eventName, "RECORDED_ANSWER_TRANSCRIPTION_RETRYABLE_FAILURE");
    assert.deepEqual(detail, {
      status: 0,
      code: "audio_object_missing",
      requestId: "unavailable",
      sessionIdHash: detail.sessionIdHash,
      answerIndex: 1,
      retryAfterSeconds: 30,
      attempt: 2,
    });
    assert.match(detail.sessionIdHash, /^[a-f0-9]{32}$/);
    const serialized = JSON.stringify(captured.warnings);
    for (const forbidden of [session.sessionId, session.accessToken, row.object_key, audioText, "test-key-never-returned"]) {
      assert.equal(serialized.includes(forbidden), false, `missing-object log leaked: ${forbidden}`);
    }
  });
});

test("staff polling completes a durable pending transcription after the candidate closes the browser", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  let upstreamCalls = 0;
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
    OPENAI_API_KEY: "test-key-never-returned",
    OPENAI_API: {
      fetch: async () => {
        upstreamCalls += 1;
        if (upstreamCalls === 1) {
          return Response.json(
            { error: { code: "rate_limit_exceeded" } },
            { status: 429, headers: { "Retry-After": "2" } },
          );
        }
        return Response.json({ text: "候補者離脱後に復旧した実回答" });
      },
    },
  };
  const session = await createTestInterviewSession(env);
  await request("/api/interviews/recorded/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
    },
  }, env);
  const bytes = new TextEncoder().encode("standalone-recorded-answer-before-browser-close");
  const initial = await request("/api/interviews/recorded/answer", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "X-Recorded-Answer-Index": "1",
      "X-Recorded-Answer-Bytes": String(bytes.byteLength),
      "Content-Type": "audio/webm",
    },
    body: bytes,
  }, env);
  assert.equal(initial.status, 202);
  const storedSession = database.sessions.get(session.sessionId);
  await sealRecordedCompletion(env, session, 1);
  storedSession.recording_status = "stored";
  const pending = database.recordedAnswers.get(`${session.sessionId}:1`);
  pending.next_retry_at = new Date(0).toISOString();

  // No candidate request follows. An authenticated staff poll advances exactly
  // one R2-backed transcription and seals the interview from durable state.
  const recovered = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await recovered.json();
  assert.equal(recovered.status, 200, JSON.stringify(payload));
  assert.equal(payload.processed, true);
  assert.equal(payload.transcription.sessionId, session.sessionId);
  assert.equal(payload.transcription.answerIndex, 1);
  assert.equal(payload.transcription.state, "completed");
  assert.equal(payload.completion.sessionId, session.sessionId);
  assert.equal(payload.completion.state, "completed");
  assert.equal(database.sessions.get(session.sessionId).status, "completed");
  assert.equal(recordings.putCount, 1, "staff recovery must reuse the durable answer audio");
  assert.equal(upstreamCalls, 2);
  const transcript = JSON.parse(database.sessions.get(session.sessionId).transcript_json);
  assert.equal(transcript.find((turn) => turn.speaker === "candidate").text, "候補者離脱後に復旧した実回答");
});

test("staff polling completes one stale durable evaluation as human review without an OpenAI call", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "evaluation_processing";
  stored.updated_at = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
  database.evaluationClaims.set(session.sessionId, {
    session_id: session.sessionId,
    claim_id: "worker-that-died",
    started_at: stored.updated_at,
    created_at: stored.updated_at,
    updated_at: stored.updated_at,
  });
  stored.transcript_json = JSON.stringify([
    { id: "question-1", speaker: "interviewer", text: "経験を教えてください。", createdAt: "2026-07-29T02:00:00.000Z" },
    { id: "answer-1", speaker: "candidate", text: "接客経験があり、安全確認を徹底しました。", createdAt: "2026-07-29T02:00:10.000Z" },
  ]);

  const recovered = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await recovered.json();
  assert.equal(recovered.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.evaluation, { sessionId: session.sessionId, state: "completed" });
  assert.equal(payload.processed, true);
  assert.equal(stored.status, "completed");
  assert.equal(database.evaluationClaims.has(session.sessionId), false);
  const evaluation = JSON.parse(stored.evaluation_json);
  assert.equal(evaluation.recommendation, "human_review");
  assert.equal(evaluation.humanReviewRequired, true);
  assert.equal(evaluation.dimensions.every((dimension) => dimension.score === null), true);
});

test("staff polling completes a stale released evaluation_pending transcript after the candidate leaves", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "evaluation_pending";
  stored.updated_at = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
  stored.transcript_json = JSON.stringify([
    { id: "question-pending", speaker: "interviewer", text: "経験を教えてください。", createdAt: "2026-07-29T02:00:00.000Z" },
    { id: "answer-pending", speaker: "candidate", text: "接客経験を安全確認に生かしました。", createdAt: "2026-07-29T02:00:10.000Z" },
  ]);

  const recovered = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await recovered.json();
  assert.equal(recovered.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.evaluation, { sessionId: session.sessionId, state: "completed" });
  assert.equal(stored.status, "completed");
  assert.equal(database.evaluationClaims.has(session.sessionId), false);
  assert.equal(JSON.parse(stored.evaluation_json).recommendation, "human_review");
});

test("staff polling leaves a fresh released evaluation_pending transcript for the candidate retry", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "evaluation_pending";
  stored.updated_at = new Date(Date.now() - 9 * 60 * 1_000).toISOString();
  stored.transcript_json = JSON.stringify([
    { id: "answer-fresh-pending", speaker: "candidate", text: "候補者の再試行を待つ回答です。", createdAt: "2026-07-29T02:00:10.000Z" },
  ]);

  const response = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.evaluation, null);
  assert.equal(stored.status, "evaluation_pending");
  assert.equal(stored.evaluation_json, undefined);
});

test("staff evaluation recovery excludes a stale evaluation_pending transcript with a known candidate gap", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "evaluation_pending";
  stored.updated_at = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
  stored.transcript_json = JSON.stringify([
    { id: "answer-before-gap", speaker: "candidate", text: "途中まで保存された回答です。", createdAt: "2026-07-29T02:00:10.000Z" },
  ]);
  database.auditEvents.push({
    session_id: session.sessionId,
    event_type: "transcription_failed",
    detail_json: JSON.stringify({ code: "TRANSCRIPTION_FAILED" }),
    created_at: stored.updated_at,
  });

  const response = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.evaluation, null);
  assert.equal(stored.status, "evaluation_pending");
  assert.equal(stored.evaluation_json, undefined);
});

test("an oldest transcript with a known gap cannot starve the next valid stale evaluation", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const invalid = await createTestInterviewSession(env);
  const valid = await createTestInterviewSession(env);
  const invalidStored = database.sessions.get(invalid.sessionId);
  const validStored = database.sessions.get(valid.sessionId);
  invalidStored.status = "evaluation_pending";
  invalidStored.updated_at = new Date(Date.now() - 20 * 60 * 1_000).toISOString();
  invalidStored.transcript_json = JSON.stringify([{
    id: "oldest-partial-answer",
    speaker: "candidate",
    text: "途中までの回答です。",
    createdAt: invalidStored.updated_at,
  }]);
  database.auditEvents.push({
    session_id: invalid.sessionId,
    event_type: "transcription_failed",
    detail_json: JSON.stringify({ code: "TRANSCRIPTION_FAILED" }),
    created_at: invalidStored.updated_at,
  });
  validStored.status = "evaluation_pending";
  validStored.updated_at = new Date(Date.now() - 15 * 60 * 1_000).toISOString();
  validStored.transcript_json = JSON.stringify([{
    id: "next-valid-answer",
    speaker: "candidate",
    text: "最後まで保存された回答です。",
    createdAt: validStored.updated_at,
  }]);

  const response = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.evaluation, { sessionId: valid.sessionId, state: "completed" });
  assert.equal(invalidStored.status, "evaluation_pending");
  assert.equal(invalidStored.evaluation_json, undefined);
  assert.equal(validStored.status, "completed");
  assert.equal(JSON.parse(validStored.evaluation_json).recommendation, "human_review");
});

test("recorded-answer transcripts supersede an earlier realtime gap during evaluation recovery", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "evaluation_pending";
  stored.updated_at = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
  stored.transcript_json = JSON.stringify([
    { id: "recorded-transcribed-question-1", speaker: "interviewer", text: "経験を教えてください。", createdAt: stored.updated_at },
    { id: "recorded-transcribed-answer-1", speaker: "candidate", text: "録画回答で全回答を復旧しました。", createdAt: stored.updated_at },
  ]);
  database.auditEvents.push({
    session_id: session.sessionId,
    event_type: "transcription_failed",
    detail_json: JSON.stringify({ code: "TRANSCRIPTION_FAILED" }),
    created_at: stored.updated_at,
  });

  const response = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.evaluation, { sessionId: session.sessionId, state: "completed" });
  assert.equal(stored.status, "completed");
  assert.equal(JSON.parse(stored.evaluation_json).recommendation, "human_review");
});

test("staff polling completes a sealed voice transcript once its recording is stored", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "in_progress";
  stored.recording_status = "stored";
  stored.transcript_json = JSON.stringify([
    { id: "voice-answer-sealed", speaker: "candidate", text: "音声面接で確定済みの回答です。", createdAt: new Date().toISOString() },
  ]);
  database.auditEvents.push({
    session_id: session.sessionId,
    event_type: "voice_transcript_sealed",
    detail_json: "{}",
    created_at: new Date().toISOString(),
  });

  const response = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.evaluation, { sessionId: session.sessionId, state: "completed" });
  assert.equal(stored.status, "completed");
  assert.equal(JSON.parse(stored.evaluation_json).recommendation, "human_review");
});

test("staff polling never completes an ordinary in-progress interview without a voice seal", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "in_progress";
  stored.recording_status = "stored";
  stored.updated_at = new Date(0).toISOString();
  stored.transcript_json = JSON.stringify([
    { id: "ordinary-answer", speaker: "candidate", text: "まだ面接は進行中です。", createdAt: stored.updated_at },
  ]);

  const response = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.evaluation, null);
  assert.equal(stored.status, "in_progress");
  assert.equal(stored.evaluation_json, undefined);
});

test("an evaluation claim cannot replace a sealed voice transcript with different content", async () => {
  const database = new FakeD1();
  const openAI = {
    fetch: async () => {
      assert.fail("the sealed transcript fence must reject before the paid model call");
    },
  };
  const env = { ...workerEnv, DB: database, OPENAI_API_KEY: "test-key-never-returned", OPENAI_API: openAI };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "in_progress";
  stored.transcript_json = JSON.stringify([
    { id: "sealed-answer", speaker: "candidate", text: "封印済みの実回答です。", createdAt: "2026-07-29T02:00:10.000Z" },
  ]);
  database.auditEvents.push({
    session_id: session.sessionId,
    event_type: "voice_transcript_sealed",
    detail_json: "{}",
    created_at: new Date().toISOString(),
  });

  const response = await request("/api/evaluate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: session.sessionId,
      employment: stored.employment,
      preferredLocation: stored.preferred_location,
      transcript: [
        { id: "replacement-answer", speaker: "candidate", text: "別内容へ置換します。", createdAt: "2026-07-29T02:00:20.000Z" },
      ],
    }),
  }, env);
  assert.equal(response.status, 409);
  assert.equal(stored.status, "in_progress");
  assert.equal(JSON.parse(stored.transcript_json)[0].text, "封印済みの実回答です。");
  assert.equal(database.evaluationClaims.has(session.sessionId), false);
});

test("staff evaluation recovery leaves fresh and interviewer-only claims untouched", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const fresh = await createTestInterviewSession(env);
  const freshStored = database.sessions.get(fresh.sessionId);
  freshStored.status = "evaluation_processing";
  freshStored.updated_at = new Date(Date.now() - 9 * 60 * 1_000).toISOString();
  database.evaluationClaims.set(fresh.sessionId, {
    session_id: fresh.sessionId,
    claim_id: "live-worker",
    started_at: freshStored.updated_at,
    created_at: freshStored.updated_at,
    updated_at: freshStored.updated_at,
  });
  freshStored.transcript_json = JSON.stringify([
    { id: "answer-fresh", speaker: "candidate", text: "処理中の回答です。", createdAt: "2026-07-29T02:00:10.000Z" },
  ]);
  const interviewerOnly = await createTestInterviewSession(env);
  const interviewerStored = database.sessions.get(interviewerOnly.sessionId);
  interviewerStored.status = "evaluation_processing";
  interviewerStored.updated_at = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
  database.evaluationClaims.set(interviewerOnly.sessionId, {
    session_id: interviewerOnly.sessionId,
    claim_id: "old-worker-without-answer",
    started_at: interviewerStored.updated_at,
    created_at: interviewerStored.updated_at,
    updated_at: interviewerStored.updated_at,
  });
  interviewerStored.transcript_json = JSON.stringify([
    { id: "question-only", speaker: "interviewer", text: "経験を教えてください。", createdAt: "2026-07-29T02:00:00.000Z" },
  ]);

  const response = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.evaluation, null);
  assert.equal(freshStored.status, "evaluation_processing");
  assert.equal(database.evaluationClaims.get(fresh.sessionId).claim_id, "live-worker");
  assert.equal(interviewerStored.status, "evaluation_processing");
  assert.equal(database.evaluationClaims.get(interviewerOnly.sessionId).claim_id, "old-worker-without-answer");
  assert.equal(freshStored.evaluation_json, undefined);
  assert.equal(interviewerStored.evaluation_json, undefined);
});

test("concurrent staff polls complete a stale evaluation only once", async () => {
  const database = new FakeD1();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: new FakeR2(),
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "evaluation_processing";
  stored.updated_at = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
  database.evaluationClaims.set(session.sessionId, {
    session_id: session.sessionId,
    claim_id: "worker-that-died",
    started_at: stored.updated_at,
    created_at: stored.updated_at,
    updated_at: stored.updated_at,
  });
  stored.transcript_json = JSON.stringify([
    { id: "answer-1", speaker: "candidate", text: "保存済みの実回答です。", createdAt: "2026-07-29T02:00:10.000Z" },
  ]);
  const poll = () => request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);

  const payloads = await Promise.all((await Promise.all([poll(), poll()])).map((response) => response.json()));
  assert.equal(payloads.filter((payload) => payload.evaluation?.state === "completed").length, 1);
  assert.equal(payloads.filter((payload) => payload.evaluation === null).length, 1);
  assert.equal(stored.status, "completed");
  assert.equal(JSON.parse(stored.evaluation_json).recommendation, "human_review");
});

test("staff polling finalizes all uploaded recording parts after a sealed candidate browser closes", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
    OPENAI_API_KEY: "test-key-never-returned",
    OPENAI_API: { fetch: async () => Response.json({ text: "終了直前に保存済みの実回答" }) },
  };
  const session = await createTestInterviewSession(env);
  await request("/api/interviews/recorded/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
    },
  }, env);
  const answerBytes = new TextEncoder().encode("standalone-answer-before-recording-finalize-loss");
  const answer = await request("/api/interviews/recorded/answer", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "X-Recorded-Answer-Index": "1",
      "X-Recorded-Answer-Bytes": String(answerBytes.byteLength),
      "Content-Type": "audio/webm",
    },
    body: answerBytes,
  }, env);
  assert.equal(answer.status, 200);
  await sealRecordedCompletion(env, session, 1);

  const recordingBytes = new Uint8Array(1_024).fill(7);
  const startUpload = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      contentType: "video/webm",
      byteSize: recordingBytes.byteLength,
      partSize: 256 * 1024,
      totalParts: 1,
      audioCoverage: "both",
      uploadVersion: 2,
    }),
  }, env);
  assert.equal(startUpload.status, 200);
  const part = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(recordingBytes.byteLength),
      "X-Recording-Part-Sha256": sha256Hex(recordingBytes),
      "Content-Type": "application/octet-stream",
    },
    body: recordingBytes,
  }, env);
  assert.equal(part.status, 200);
  // Simulate the tab closing after its final part acknowledgement but before
  // /upload/complete. Only the authenticated staff poll runs from here.
  database.sessions.get(session.sessionId).updated_at = new Date(0).toISOString();
  const recovered = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await recovered.json();
  assert.equal(recovered.status, 200, JSON.stringify(payload));
  assert.equal(payload.recording.sessionId, session.sessionId);
  assert.equal(payload.recording.state, "stored");
  assert.equal(payload.completion.sessionId, session.sessionId);
  assert.equal(payload.completion.state, "completed");
  assert.equal(database.sessions.get(session.sessionId).recording_status, "stored");
  assert.equal(database.sessions.get(session.sessionId).status, "completed");
  assert.equal(database.artifacts.some((artifact) => artifact[1] === session.sessionId && artifact[2].includes("recording.manifest.json")), true);
});

test("scheduled recovery finalizes normal voice recording parts and evaluation without a staff tab", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "in_progress";
  const transcript = [
    { id: "voice-question-final", speaker: "interviewer", text: "最後に伝えたいことはありますか。", createdAt: "2026-08-12T10:00:00.000Z" },
    { id: "voice-answer-final", speaker: "candidate", text: "安全と誠実さを大切に勤務します。", createdAt: "2026-08-12T10:00:10.000Z" },
  ];
  const seal = await sealVoiceTranscript(env, session, transcript);
  assert.equal(seal.status, 200, await seal.clone().text());
  assert.equal(stored.status, "in_progress");

  const recordingBytes = new Uint8Array(1_024).fill(23);
  const commonHeaders = { Authorization: `Bearer ${session.accessToken}` };
  const start = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { ...commonHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      contentType: "video/webm",
      byteSize: recordingBytes.byteLength,
      partSize: 256 * 1024,
      totalParts: 1,
      audioCoverage: "both",
      uploadVersion: 2,
    }),
  }, env);
  assert.equal(start.status, 200);
  const part = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...commonHeaders,
      "X-Interview-Session": session.sessionId,
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(recordingBytes.byteLength),
      "X-Recording-Part-Sha256": sha256Hex(recordingBytes),
      "Content-Type": "application/octet-stream",
    },
    body: recordingBytes,
  }, env);
  assert.equal(part.status, 200);

  // Simulate the exact loss window: the final part was acknowledged, but the
  // candidate closed before /upload/complete. No candidate request follows.
  stored.updated_at = new Date(0).toISOString();
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => logs.push(args);
  try {
    await scheduleInterviewRecovery(env);
  } finally {
    console.info = originalInfo;
  }
  assert.equal(stored.recording_status, "stored");
  assert.equal(stored.status, "completed");
  assert.deepEqual(JSON.parse(stored.transcript_json), transcript);
  assert.equal(database.artifacts.some((artifact) =>
    artifact[1] === session.sessionId && artifact[2].includes("recording.manifest.json")), true);
  assert.equal(logs[0][1].states.recording, "advanced");
  assert.equal(logs[0][1].states.evaluation, "advanced");
});

test("staff voice recovery leaves an upload with any missing part non-stored", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "in_progress";
  const transcript = [{
    id: "voice-answer-before-part-loss",
    speaker: "candidate",
    text: "最後まで回答しました。",
    createdAt: "2026-08-12T10:00:10.000Z",
  }];
  assert.equal((await sealVoiceTranscript(env, session, transcript)).status, 200);

  const partSize = 256 * 1024;
  const start = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      contentType: "video/webm",
      byteSize: partSize + 17,
      partSize,
      totalParts: 2,
      audioCoverage: "both",
      uploadVersion: 2,
    }),
  }, env);
  assert.equal(start.status, 200);
  const firstPart = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(partSize),
      "X-Recording-Part-Sha256": sha256Hex(new Uint8Array(partSize).fill(31)),
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(partSize).fill(31),
  }, env);
  assert.equal(firstPart.status, 200);
  stored.updated_at = new Date(0).toISOString();

  const recovered = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const payload = await recovered.json();
  assert.equal(recovered.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.recording, { sessionId: session.sessionId, state: "incomplete" });
  assert.equal(payload.evaluation, null);
  assert.equal(stored.recording_status, "uploading");
  assert.ok(Date.parse(stored.updated_at) > Date.parse(new Date(0).toISOString()),
    "a missing part must back off without misclassifying the upload as failed");
  assert.equal(stored.status, "in_progress");
  assert.equal(database.artifacts.some((artifact) => artifact[1] === session.sessionId), false);
  assert.deepEqual(JSON.parse(stored.transcript_json), transcript);
});

test("an accepted recording part heartbeats D1 so active mobile upload is not reclaimed", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "in_progress";
  assert.equal((await sealVoiceTranscript(env, session, [{
    id: "active-upload-answer",
    speaker: "candidate",
    text: "録画を送信中です。",
    createdAt: "2026-08-12T10:00:10.000Z",
  }])).status, 200);
  const partSize = 256 * 1024;
  assert.equal((await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      contentType: "video/webm",
      byteSize: partSize + 19,
      partSize,
      totalParts: 2,
      audioCoverage: "both",
      uploadVersion: 2,
    }),
  }, env)).status, 200);
  stored.updated_at = new Date(0).toISOString();
  const bytes = new Uint8Array(partSize).fill(41);
  assert.equal((await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(bytes.byteLength),
      "X-Recording-Part-Sha256": sha256Hex(bytes),
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  }, env)).status, 200);
  const heartbeatAt = stored.updated_at;
  assert.ok(Date.parse(heartbeatAt) > Date.parse(new Date(0).toISOString()));

  const recovered = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).recording, null);
  assert.equal(stored.recording_status, "uploading");
  assert.equal(stored.updated_at, heartbeatAt);
});

test("ten oldest missing uploads cannot starve an eleventh sealed upload with all parts", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    INTERVIEW_STAFF_TOKEN: "staff-review-secret",
  };
  const missingSessions = [];
  for (let index = 0; index < 10; index += 1) {
    missingSessions.push(await createTestInterviewSession(env, "正社員", "越谷店", {
      candidateName: `復旧テスト${index}`,
      connectingAddress: `192.0.2.${index + 1}`,
    }));
  }
  const ready = await createTestInterviewSession(env, "正社員", "越谷店", {
    candidateName: "復旧テスト完了",
    connectingAddress: "192.0.2.99",
  });
  for (const [index, session] of [...missingSessions, ready].entries()) {
    const stored = database.sessions.get(session.sessionId);
    stored.status = "in_progress";
    assert.equal((await sealVoiceTranscript(env, session, [{
      id: `starvation-answer-${index}`,
      speaker: "candidate",
      text: `保存済み回答${index}`,
      createdAt: `2026-08-12T10:00:1${index}.000Z`,
    }])).status, 200);
    const seal = database.auditEvents.find((event) =>
      event.session_id === session.sessionId && event.event_type === "voice_transcript_sealed");
    seal.created_at = new Date(Date.UTC(2026, 7, 12, 10, 0, index)).toISOString();
    const partSize = 256 * 1024;
    const byteSize = session === ready ? partSize : partSize + 7;
    assert.equal((await request("/api/interviews/recording/upload/start", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        contentType: "video/webm",
        byteSize,
        partSize,
        totalParts: session === ready ? 1 : 2,
        audioCoverage: "both",
        uploadVersion: 2,
      }),
    }, env)).status, 200);
    const bytes = new Uint8Array(partSize).fill(50 + index);
    assert.equal((await request("/api/interviews/recording/upload/part", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "X-Interview-Session": session.sessionId,
        "X-Recording-Part-Index": "0",
        "X-Recording-Part-Bytes": String(bytes.byteLength),
        "X-Recording-Part-Sha256": sha256Hex(bytes),
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    }, env)).status, 200);
    stored.updated_at = new Date(0).toISOString();
  }

  const firstTick = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const firstPayload = await firstTick.json();
  assert.equal(firstTick.status, 200, JSON.stringify(firstPayload));
  assert.equal(firstPayload.recording.state, "incomplete");
  assert.equal(database.sessions.get(ready.sessionId).recording_status, "uploading");
  for (const session of missingSessions) {
    assert.equal(database.sessions.get(session.sessionId).recording_status, "uploading");
  }

  // Advance the simulated next tick. Fair ordering uses the old updated_at on
  // the never-attempted eleventh row before the ten rows just deferred.
  const readyStored = database.sessions.get(ready.sessionId);
  readyStored.updated_at = new Date(0).toISOString();
  const secondTick = await request("/api/staff/transcriptions/recover", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const secondPayload = await secondTick.json();
  assert.equal(secondTick.status, 200, JSON.stringify(secondPayload));
  assert.deepEqual(secondPayload.recording, { sessionId: ready.sessionId, state: "stored" });
  assert.equal(database.sessions.get(ready.sessionId).recording_status, "stored");
  assert.equal(database.artifacts.some((artifact) => artifact[1] === ready.sessionId), true);
});

test("completed recording recovery fairly stores the eleventh full upload and exposes it to Drive next tick", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const missingSessions = [];
  for (let index = 0; index < 10; index += 1) {
    missingSessions.push(await createTestInterviewSession(env, "正社員", "越谷店", {
      candidateName: `完了済み録画復旧${index}`,
      connectingAddress: `198.51.100.${index + 1}`,
    }));
  }
  const ready = await createTestInterviewSession(env, "正社員", "越谷店", {
    candidateName: "完了済み録画復旧完了",
    connectingAddress: "198.51.100.99",
  });
  const recent = await createTestInterviewSession(env, "正社員", "越谷店", {
    candidateName: "完了直後のアクティブ録画",
    connectingAddress: "198.51.100.100",
  });

  for (const [index, session] of [...missingSessions, ready, recent].entries()) {
    const stored = database.sessions.get(session.sessionId);
    stored.status = "completed";
    stored.completed_at = session === recent
      ? new Date().toISOString()
      : "2026-08-12T09:00:00.000Z";
    stored.transcript_json = JSON.stringify([{
      id: `completed-recovery-answer-${index}`,
      speaker: "candidate",
      text: `完了済み復旧用回答${index}`,
      createdAt: "2026-08-12T08:59:00.000Z",
    }]);
    stored.evaluation_json = JSON.stringify({
      recommendation: "human_review",
      summary: "採用担当者による確認が必要です。",
      dimensions: [],
      strengths: [],
      concerns: [],
      contradictions: [],
      missingTopics: [],
      conditions: [],
      transcriptProvenance: "candidate_device_unverified",
      evidenceValidationWarnings: [],
      humanReviewRequired: true,
    });
    const partSize = 256 * 1024;
    const full = session === ready || session === recent;
    assert.equal((await request("/api/interviews/recording/upload/start", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        contentType: "video/webm",
        byteSize: full ? partSize : partSize + 13,
        partSize,
        totalParts: full ? 1 : 2,
        audioCoverage: "both",
        uploadVersion: 2,
      }),
    }, env)).status, 200);
    const bytes = new Uint8Array(partSize).fill(70 + index);
    assert.equal((await request("/api/interviews/recording/upload/part", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "X-Interview-Session": session.sessionId,
        "X-Recording-Part-Index": "0",
        "X-Recording-Part-Bytes": String(bytes.byteLength),
        "X-Recording-Part-Sha256": sha256Hex(bytes),
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    }, env)).status, 200);
    // Ten incomplete rows sort ahead of the full eleventh row on the first
    // bounded scan. All are old enough for both the active-upload and completed
    // grace-period fences.
    stored.updated_at = new Date(index * 1_000).toISOString();
  }

  const tickLogs = [];
  const originalInfo = console.info;
  console.info = (...args) => tickLogs.push(args);
  try {
    await scheduleInterviewRecovery(env);
    assert.equal(tickLogs.at(-1)[1].states.recording, "attention");
    assert.equal(database.sessions.get(ready.sessionId).recording_status, "uploading");
    for (const session of missingSessions) {
      assert.equal(database.sessions.get(session.sessionId).recording_status, "uploading",
        "a missing part must remain resumable, not be mislabeled failed");
    }

    await scheduleInterviewRecovery(env);
    assert.equal(tickLogs.at(-1)[1].states.recording, "advanced");
    assert.equal(database.sessions.get(ready.sessionId).recording_status, "stored");
    assert.equal(database.artifacts.some((artifact) => artifact[1] === ready.sessionId), true);

    await scheduleInterviewRecovery(env);
    assert.equal(tickLogs.at(-1)[1].states.drive, "attention",
      "the next tick must select the newly stored completed interview for Drive");
    assert.equal(database.sessions.get(recent.sessionId).recording_status, "uploading",
      "the completed-at grace period must protect a just-finished active upload");
  } finally {
    console.info = originalInfo;
  }
});

test("recording parts compare R2 actual size and never trust only the declared metadata", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const session = await createTestInterviewSession(env);
  database.sessions.get(session.sessionId).status = "in_progress";
  const declaredBytes = 256 * 1024;
  const start = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      contentType: "video/webm",
      byteSize: declaredBytes,
      partSize: declaredBytes,
      totalParts: 1,
      audioCoverage: "both",
      uploadVersion: 2,
    }),
  }, env);
  assert.equal(start.status, 200);

  const truncated = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(declaredBytes),
      "X-Recording-Part-Sha256": sha256Hex(new Uint8Array([1])),
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array([1]),
  }, env);
  assert.equal(truncated.status, 400);
  assert.equal(
    recordings.objects.has(`interviews/${session.sessionId}/recording-parts/part-000`),
    false,
    "a short request body must be rejected before creating its immutable R2 key",
  );

  const completeBody = new Uint8Array(declaredBytes).fill(2);
  const recoveredPart = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(declaredBytes),
      "X-Recording-Part-Sha256": sha256Hex(completeBody),
      "Content-Type": "application/octet-stream",
    },
    body: completeBody,
  }, env);
  assert.equal(recoveredPart.status, 200, await recoveredPart.clone().text());

  const resume = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      contentType: "video/webm",
      byteSize: declaredBytes,
      partSize: declaredBytes,
      totalParts: 1,
      audioCoverage: "both",
      uploadVersion: 2,
    }),
  }, env);
  assert.equal(resume.status, 200);
  assert.deepEqual((await resume.json()).uploadedParts, [0], "the exact retry must be acknowledged after the short body is rejected");

  const complete = await request("/api/interviews/recording/upload/complete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
    },
  }, env);
  assert.equal(complete.status, 200, await complete.clone().text());
  assert.equal(database.sessions.get(session.sessionId).recording_status, "stored");
  assert.equal(database.artifacts.some((artifact) => artifact[1] === session.sessionId), true);
});

test("a pre-deploy tab that starts uploading after deployment can finish as Version 1", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const session = await createTestInterviewSession(env);
  database.sessions.get(session.sessionId).status = "in_progress";
  const recordingBytes = new Uint8Array(1_024).fill(91);
  const commonHeaders = {
    Authorization: `Bearer ${session.accessToken}`,
    "X-Interview-Session": session.sessionId,
  };
  const start = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { ...commonHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      contentType: "video/webm",
      byteSize: recordingBytes.byteLength,
      partSize: 256 * 1024,
      totalParts: 1,
      audioCoverage: "both",
    }),
  }, env);
  assert.equal(start.status, 200);

  // The old client has no uploadVersion field. Even when this start request
  // reaches the new server after a long interview, it must create Version 1 so
  // the legacy client can send its locally held parts without SHA headers.
  const stateKey = `interviews/${session.sessionId}/recording-parts/upload.json`;
  const stateObject = recordings.objects.get(stateKey);
  const state = JSON.parse(new TextDecoder().decode(stateObject.body));
  assert.equal(state.version, 1);

  const part = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...commonHeaders,
      "Content-Type": "application/octet-stream",
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(recordingBytes.byteLength),
    },
    body: recordingBytes,
  }, env);
  assert.equal(part.status, 200, await part.clone().text());
  assert.deepEqual(await part.json(), { stored: true, duplicate: false, index: 0 });
  const partKey = `interviews/${session.sessionId}/recording-parts/part-000`;
  const storedPart = recordings.objects.get(partKey);
  const expectedDigest = sha256Hex(recordingBytes);
  assert.equal(storedPart.options.customMetadata.sha256, expectedDigest);
  assert.equal(storedPart.options.sha256, expectedDigest, "the server must checksum an old-tab upload even without a digest header");

  const conflictingRetry = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...commonHeaders,
      "Content-Type": "application/octet-stream",
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(recordingBytes.byteLength),
    },
    body: new Uint8Array(recordingBytes.byteLength).fill(92),
  }, env);
  assert.equal(conflictingRetry.status, 409, "omitting the version and digest must not downgrade same-size content checks");

  const exactRetry = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...commonHeaders,
      "Content-Type": "application/octet-stream",
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(recordingBytes.byteLength),
    },
    body: recordingBytes,
  }, env);
  assert.equal(exactRetry.status, 200, await exactRetry.clone().text());
  assert.deepEqual(await exactRetry.json(), { stored: true, duplicate: true, index: 0 });
  const complete = await request("/api/interviews/recording/upload/complete", {
    method: "POST",
    headers: commonHeaders,
  }, env);
  assert.equal(complete.status, 200, await complete.clone().text());
  assert.equal(database.sessions.get(session.sessionId).recording_status, "stored");
});

test("concurrent old and new upload starts cannot overwrite each other's protocol state", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const session = await createTestInterviewSession(env);
  database.sessions.get(session.sessionId).status = "in_progress";
  const stateKey = `interviews/${session.sessionId}/recording-parts/upload.json`;
  const originalPut = recordings.put.bind(recordings);
  let firstStatePutReached;
  let releaseFirstStatePut;
  const reached = new Promise((resolve) => { firstStatePutReached = resolve; });
  const release = new Promise((resolve) => { releaseFirstStatePut = resolve; });
  let blockFirstStatePut = true;
  recordings.put = async (key, body, options) => {
    if (key === stateKey && blockFirstStatePut) {
      blockFirstStatePut = false;
      firstStatePutReached();
      await release;
    }
    return await originalPut(key, body, options);
  };
  const common = {
    sessionId: session.sessionId,
    contentType: "video/webm",
    byteSize: 1_024,
    partSize: 256 * 1024,
    totalParts: 1,
    audioCoverage: "both",
  };
  const headers = { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" };
  const newClient = request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...common, uploadVersion: 2 }),
  }, env);
  await reached;
  const oldClient = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers,
    body: JSON.stringify(common),
  }, env);
  releaseFirstStatePut();
  const newClientResponse = await newClient;
  assert.equal(oldClient.status, 200, await oldClient.clone().text());
  assert.equal(newClientResponse.status, 409, await newClientResponse.clone().text());
  const persisted = JSON.parse(new TextDecoder().decode(recordings.objects.get(stateKey).body));
  assert.equal(persisted.version, 1, "the create-only winner must remain immutable");
});

test("a checksum-less pre-rollout Version 1 part is re-acknowledged only for the exact stored bytes", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const session = await createTestInterviewSession(env);
  const storedSession = database.sessions.get(session.sessionId);
  storedSession.status = "in_progress";
  const originalBytes = new Uint8Array(1_024).fill(71);
  const stateKey = `interviews/${session.sessionId}/recording-parts/upload.json`;
  const partKey = `interviews/${session.sessionId}/recording-parts/part-000`;
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    "X-Interview-Session": session.sessionId,
  };
  const shape = {
    sessionId: session.sessionId,
    contentType: "video/webm",
    byteSize: originalBytes.byteLength,
    partSize: 256 * 1024,
    totalParts: 1,
    audioCoverage: "both",
  };
  const initialStart = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(shape),
  }, env);
  assert.equal(initialStart.status, 200);
  assert.equal(JSON.parse(new TextDecoder().decode(recordings.objects.get(stateKey).body)).version, 1);

  // Reproduce an object accepted before checksum metadata was introduced.
  await recordings.put(partKey, originalBytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: {
      sessionId: session.sessionId,
      byteSize: String(originalBytes.byteLength),
      retentionUntil: storedSession.retention_until,
    },
  });
  const resume = await request("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(shape),
  }, env);
  assert.equal(resume.status, 200);
  assert.deepEqual((await resume.json()).uploadedParts, [], "an unverified legacy part must be replayed, not skipped");

  const conflicting = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/octet-stream",
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(originalBytes.byteLength),
    },
    body: new Uint8Array(originalBytes.byteLength).fill(72),
  }, env);
  assert.equal(conflicting.status, 409, "same-size replacement bytes cannot inherit the old receipt");
  assert.deepEqual(recordings.objects.get(partKey).body, originalBytes, "the legacy object must remain immutable");

  const exact = await request("/api/interviews/recording/upload/part", {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/octet-stream",
      "X-Recording-Part-Index": "0",
      "X-Recording-Part-Bytes": String(originalBytes.byteLength),
    },
    body: originalBytes,
  }, env);
  assert.equal(exact.status, 200, await exact.clone().text());
  assert.deepEqual(await exact.json(), { stored: true, duplicate: true, index: 0 });
  const complete = await request("/api/interviews/recording/upload/complete", {
    method: "POST",
    headers,
  }, env);
  assert.equal(complete.status, 200, await complete.clone().text());
  assert.equal(storedSession.recording_status, "stored");
});

test("a completed non-recorded interview cannot forge the recorded completion replay receipt", async () => {
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database, RECORDINGS: new FakeR2() };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "completed";
  stored.recording_status = "stored";
  stored.transcript_json = JSON.stringify([{
    id: "voice-answer-1",
    speaker: "candidate",
    text: "通常音声面接の回答です。",
    createdAt: new Date().toISOString(),
  }]);
  const replay = await request("/api/interviews/recorded/complete", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: 1 }),
  }, env);
  assert.equal(replay.status, 409, await replay.clone().text());
  assert.equal((await replay.json()).stored, undefined);
});

test("recorded answer rejects cross-origin, oversize, and conflicting replacement audio", async () => {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = {
    ...workerEnv,
    DB: database,
    RECORDINGS: recordings,
    OPENAI_API_KEY: "test-key-never-returned",
    OPENAI_API: {
      fetch: async () => Response.json(
        { error: { code: "invalid_api_key" } },
        { status: 401 },
      ),
    },
  };
  const session = await createTestInterviewSession(env);
  await request("/api/interviews/recorded/start", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
    },
  }, env);
  const authHeaders = {
    Authorization: `Bearer ${session.accessToken}`,
    "X-Interview-Session": session.sessionId,
    "X-Recorded-Answer-Index": "1",
  };
  const crossOrigin = await request("/api/interviews/recorded/answer", {
    method: "POST",
    headers: { ...authHeaders, Origin: "https://attacker.example" },
  }, env);
  assert.equal(crossOrigin.status, 403);

  const oversized = await request("/api/interviews/recorded/answer", {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "audio/webm",
      "X-Recorded-Answer-Bytes": String(10 * 1024 * 1024 + 1),
    },
    body: new Uint8Array([1]),
  }, env);
  assert.equal(oversized.status, 413);

  const original = new TextEncoder().encode("original-answer-audio");
  const undeclaredUpload = await request("/api/interviews/recorded/answer", {
    method: "POST",
    headers: authHeaders,
    body: original,
  }, env);
  assert.equal(undeclaredUpload.status, 409, "audio bytes without the upload declaration are only a retry");
  assert.equal(database.recordedAnswers.has(`${session.sessionId}:1`), false);
  assert.equal(recordings.putCount, 0, "an undeclared body must never register or replace answer audio");

  const accepted = await request("/api/interviews/recorded/answer", {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "audio/webm",
      "X-Recorded-Answer-Bytes": String(original.byteLength),
    },
    body: original,
  }, env);
  assert.equal(accepted.status, 202);
  assert.equal(database.recordedAnswers.get(`${session.sessionId}:1`).status, "pending", "service authentication failure is not invalid candidate audio");
  assert.equal(database.recordedAnswers.get(`${session.sessionId}:1`).last_error_code, "invalid_api_key");
  const replacement = new TextEncoder().encode("different-answer-audio");
  const conflict = await request("/api/interviews/recorded/answer", {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "audio/webm",
      "X-Recorded-Answer-Bytes": String(replacement.byteLength),
    },
    body: replacement,
  }, env);
  assert.equal(conflict.status, 409);
  assert.equal(recordings.putCount, 1, "conflicting audio must not overwrite the accepted R2 object");
});

test("realtime endpoint mints a short-lived token with the interview safety settings", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const session = await createTestInterviewSession(env);
  const originalFetch = globalThis.fetch;
  let capturedBody;
  let capturedAuthorization;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/realtime/client_secrets");
      capturedBody = JSON.parse(init.body);
      capturedAuthorization = init.headers.Authorization;
      return Response.json({
        value: "ek_test_ephemeral",
        expires_at: 9999999999,
        session: { model: "gpt-realtime-2.1" },
      });
    };

    const response = await request("/api/realtime/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
      }),
    }, env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.value, "ek_test_ephemeral");
    assert.equal(payload.model, "gpt-realtime-2.1");
    assert.equal(capturedAuthorization, "Bearer test-key-never-returned");
    assert.equal(capturedBody.session.audio.input.turn_detection.type, "semantic_vad");
    assert.equal(capturedBody.session.audio.input.turn_detection.eagerness, "low");
    assert.equal(capturedBody.session.audio.input.turn_detection.create_response, false);
    assert.equal(capturedBody.session.audio.input.turn_detection.interrupt_response, false);
    assert.equal(capturedBody.session.max_output_tokens, 1400);
    assert.match(capturedBody.session.instructions, /まず、今のお仕事や学校について、簡単に教えてください。/);
    assert.match(capturedBody.session.instructions, /自己紹介や詳しい経歴を一度に求めず/);
    assert.match(capturedBody.session.instructions, /退職・転職を考えた理由/);
    assert.match(capturedBody.session.instructions, /なぜそれをやろうと思ったのですか/);
    assert.match(capturedBody.session.instructions, /決め手は何でしたか/);
    assert.match(capturedBody.session.instructions, /私の理解が合っているか/);
    assert.match(capturedBody.session.instructions, /長い回答は/);
    assert.match(capturedBody.session.instructions, /ドッグトレーナー、ペット業界の中でも東京DOGS/);
    assert.match(capturedBody.session.instructions, /清掃、安全管理、飼い主対応、記録、報告/);
    assert.match(capturedBody.session.instructions, /既存資料の「違和感」は自動不採用に使わない/);
    assert.match(capturedBody.session.instructions, /笑顔の有無/);
    assert.match(capturedBody.session.instructions, /傾聴、理解確認/);
    assert.match(capturedBody.session.instructions, /犬を通して、人々を幸せに/);
    assert.match(capturedBody.session.instructions, /仕事選びの基準は、まず本人の言葉で三つ/);
    assert.match(capturedBody.session.instructions, /希望店舗以外への配属や他店舗ヘルプが実際に発生する可能性/);
    assert.match(capturedBody.session.instructions, /普通自動車免許、送迎、当直/);
    assert.match(capturedBody.session.instructions, /通常数日〜1週間、長い場合は10日程度/);
    assert.match(capturedBody.session.instructions, /既存資料の「両親の反応」「家族構成」「家族間の仲」「住まい」は質問しない/);
    assert.doesNotMatch(capturedBody.session.instructions, /笠間|山本|松尾/);
    assert.equal(capturedBody.session.tools[0].name, "complete_interview");
    assert.deepEqual(
      capturedBody.session.tools[0].parameters.properties.topics_covered.items.enum,
      Array.from({ length: 15 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`),
    );
    assert.doesNotMatch(JSON.stringify(payload), /test-key-never-returned/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("realtime endpoint distinguishes missing quota from temporary congestion", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const session = await createTestInterviewSession(env);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(
      { error: { type: "insufficient_quota", code: "insufficient_quota" } },
      { status: 429 },
    );
    const response = await request("/api/realtime/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
      }),
    }, env);
    const payload = await response.json();
    assert.equal(response.status, 429);
    assert.match(payload.error, /オンライン一次面接の接続設定が完了していません/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one interview token cannot create unbounded paid realtime connections", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const session = await createTestInterviewSession(env);
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  try {
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return Response.json({
        value: "ek_test_ephemeral",
        expires_at: 9999999999,
        session: { model: "gpt-realtime-2.1" },
      });
    };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await request("/api/realtime/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          sessionId: session.sessionId,
          employment: "正社員",
          location: "越谷店",
        }),
      }, env);
      assert.equal(response.status, 200);
    }
    const blocked = await request("/api/realtime/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
      }),
    }, env);
    assert.equal(blocked.status, 429);
    assert.equal(upstreamCalls, 12);
    assert.equal(database.auditEvents.filter((event) =>
      event.event_type === "realtime_connection_reserved").length, 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("realtime token endpoint never bypasses interview authentication when storage is unavailable", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const originalFetch = globalThis.fetch;
  let upstreamCalled = false;
  try {
    globalThis.fetch = async () => {
      upstreamCalled = true;
      return Response.json({ value: "must-not-be-issued" });
    };
    const response = await request("/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "TD-TEST-ABC123",
        employment: "正社員",
        location: "越谷店",
      }),
    });
    assert.equal(response.status, 401);
    assert.equal(upstreamCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-origin realtime call authorizes the exact new interview session and proxies SDP", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  const session = await sessionResponse.json();
  const originalFetch = globalThis.fetch;
  let capturedSession;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/realtime/calls");
      assert.equal(init.headers.Authorization, "Bearer test-key-never-returned");
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("sdp"), "v=0\r\no=test-offer\r\n");
      capturedSession = JSON.parse(init.body.get("session"));
      return new Response("v=0\r\no=test-answer\r\n", {
        status: 200,
        headers: { "Content-Type": "application/sdp" },
      });
    };
    const response = await request("/api/realtime/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/sdp",
        "X-Interview-Session": session.sessionId,
      },
      body: "v=0\r\no=test-offer\r\n",
    }, env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/sdp");
    assert.equal(await response.text(), "v=0\r\no=test-answer\r\n");
    assert.equal(capturedSession.model, "gpt-realtime-2.1");
    assert.equal(capturedSession.audio.input.turn_detection.type, "semantic_vad");

    const rejected = await request("/api/realtime/call", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-session-token",
        "Content-Type": "application/sdp",
        "X-Interview-Session": session.sessionId,
      },
      body: "v=0\r\no=test-offer\r\n",
    }, env);
    assert.equal(rejected.status, 401);
    assert.match(await rejected.text(), /TD-CONN-AUTH/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("different candidates can hold isolated realtime calls at the same time", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const createCandidate = (candidateName, location) => request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.70" },
    body: JSON.stringify({ candidateName, employment: "正社員", location, consent: true }),
  }, env);
  const [firstSessionResponse, secondSessionResponse] = await Promise.all([
    createCandidate("並行試験 一郎", "越谷店"),
    createCandidate("並行試験 二郎", "所沢店"),
  ]);
  assert.equal(firstSessionResponse.status, 201);
  assert.equal(secondSessionResponse.status, 201);
  const [firstSession, secondSession] = await Promise.all([
    firstSessionResponse.json(),
    secondSessionResponse.json(),
  ]);
  assert.notEqual(firstSession.sessionId, secondSession.sessionId);
  assert.notEqual(firstSession.accessToken, secondSession.accessToken);

  const originalFetch = globalThis.fetch;
  const upstreamSessions = [];
  let releaseBothCalls;
  const bothCallsArrived = new Promise((resolve) => { releaseBothCalls = resolve; });
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/realtime/calls");
      upstreamSessions.push(JSON.parse(init.body.get("session")));
      if (upstreamSessions.length === 2) releaseBothCalls();
      await bothCallsArrived;
      return new Response("v=0\r\no=parallel-answer\r\n", {
        status: 200,
        headers: { "Content-Type": "application/sdp" },
      });
    };
    const call = (session) => request("/api/realtime/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/sdp",
        "X-Interview-Session": session.sessionId,
      },
      body: "v=0\r\no=parallel-offer\r\n",
    }, env);
    const [firstCall, secondCall] = await Promise.all([call(firstSession), call(secondSession)]);
    assert.equal(firstCall.status, 200);
    assert.equal(secondCall.status, 200);
    assert.equal(upstreamSessions.length, 2);
    assert.equal(database.sessions.get(firstSession.sessionId).status, "in_progress");
    assert.equal(database.sessions.get(secondSession.sessionId).status, "in_progress");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const dimensionNames = [
  "理念・志望動機",
  "素直さ・改善行動",
  "責任感・誠実性",
  "接客・対話力",
  "学習意欲・継続力",
  "犬と人への安全配慮",
  "勤務条件の適合性",
];

const candidateTurns = dimensionNames.map((name, index) => ({
  id: `candidate-${index + 1}`,
  speaker: "candidate",
  createdAt: new Date(2026, 6, 29, 9, index).toISOString(),
  text: `${name}について、私は状況を確認し、周囲へ報告してから具体的に行動しました。その結果を振り返り、次回の改善策まで決めて継続しました。`,
}));

function modelEvaluation({ invalidEvidence = false } = {}) {
  return {
    recommendation: "job_related_evidence_complete",
    summary: "職務に関連する具体的な経験を確認できました。",
    dimensions: dimensionNames.map((name, index) => ({
      name,
      score: 4,
      confidence: "medium",
      rationale: "具体的な行動と改善を説明しています。",
      evidence: [{
        quote: invalidEvidence && index === 0
          ? "文字起こしに存在しない引用"
          : candidateTurns[index].text.slice(0, 42),
        turnId: candidateTurns[index].id,
        relevance: "本人の行動を示す回答です。",
      }],
    })),
    strengths: ["改善行動を具体的に説明した"],
    concerns: [],
    contradictions: [],
    missingTopics: [],
    conditions: ["勤務条件は採用担当者が最終確認する"],
  };
}

async function runEvaluationApi(invalidEvidence, transform = (value) => value) {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  const session = await sessionResponse.json();
  database.sessions.get(session.sessionId).status = "in_progress";
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(init.body);
      assert.equal(body.store, false);
      assert.equal(body.model, "gpt-5.6-sol");
      assert.equal(body.text.format.strict, true);
      assert.match(body.instructions, /総合評価は過去応募者との順位比較ではなく/);
      assert.match(body.instructions, /部活経験の有無そのものは評価しない/);
      return Response.json({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify(transform(modelEvaluation({ invalidEvidence }))),
          }],
        }],
      });
    };
    const response = await request("/api/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
        transcript: candidateTurns,
      }),
    }, env);
    return { response, database, env, session };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("candidate evaluation endpoint stores a verified result without disclosing it", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  process.env.INTERVIEW_STAFF_TOKEN = "staff-review-secret";
  const { response, env, session } = await runEvaluationApi(false);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.stored, true);
  assert.equal(payload.humanReviewRequired, true);
  assert.equal(payload.automaticEvaluationDeferred, false);
  assert.equal("evaluation" in payload, false);

  const unauthorized = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {}, env);
  assert.equal(unauthorized.status, 401);
  const staffResponse = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const staffPayload = await staffResponse.json();
  assert.equal(staffResponse.status, 200);
  assert.equal(staffPayload.review.evaluation.recommendation, "job_related_evidence_complete");
  assert.equal(staffPayload.review.evaluation.evidenceValidationWarnings.length, 0);
  assert.equal(staffPayload.review.evaluation.transcriptProvenance, "candidate_device_unverified");
  assert.equal(staffPayload.review.evaluation.dimensions.every((item) => item.evidence[0].verified), true);
  assert.equal(staffPayload.review.reviewPolicy, "authorized_staff");
  assert.equal(staffPayload.review.sourceTranscriptVerified, true);
  assert.equal("authorizedReviewers" in staffPayload.review, false);

  const videoScores = [
    { name: "接客時の傾聴・姿勢・態度", score: 4, note: "相手の話を遮らず理解を確認した" },
    { name: "接客ロールプレイの進行", score: 4, note: "挨拶、要望確認、説明の順で進行した" },
    { name: "安全説明の具体性", score: 5, note: "犬と人の距離を取り、独断せず相談すると説明した" },
    { name: "相手への配慮と分かりやすさ", score: 4, note: "飼い主を責めず、専門用語を言い換えて説明した" },
  ];
  const saveReview = await request("/api/staff/review", {
    method: "POST",
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.sessionId, scores: videoScores, overallNote: "人による確認" }),
  }, env);
  assert.equal(saveReview.status, 200);
  const refreshed = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当A"),
    },
  }, env);
  const refreshedPayload = await refreshed.json();
  assert.equal(refreshedPayload.review.humanReviews[0].reviewerName, "採用担当A");
  assert.equal(refreshedPayload.review.humanReviews[0].videoScores.length, 4);
});

test("candidate evaluation rejects an interviewer-only transcript before any OpenAI call", async () => {
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database, RECORDINGS: new FakeR2() };
  const session = await createTestInterviewSession(env);
  database.sessions.get(session.sessionId).status = "in_progress";
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      throw new Error("interviewer-only transcript must not reach OpenAI");
    };
    const response = await request("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
        transcript: [{
          id: "question-only",
          speaker: "interviewer",
          text: "自己紹介をお願いします。",
          createdAt: "2026-07-29T02:00:00.000Z",
        }],
      }),
    }, env);
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls, 0);
    assert.equal(database.sessions.get(session.sessionId).status, "in_progress");
    assert.equal(database.sessions.get(session.sessionId).evaluation_json, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completed evaluation replay returns its durable receipt without another model call", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database, RECORDINGS: new FakeR2() };
  const session = await createTestInterviewSession(env);
  const stored = database.sessions.get(session.sessionId);
  stored.status = "completed";
  stored.completed_at = "2026-07-29T03:00:00.000Z";
  stored.transcript_json = JSON.stringify(candidateTurns);
  stored.evaluation_json = JSON.stringify(modelEvaluation());
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      throw new Error("completed replay must not call the model");
    };
    const replay = await request("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
        transcript: candidateTurns,
      }),
    }, env);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { stored: true, alreadyStored: true });
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("staff-only evaluation drops invented evidence and forces human review", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  process.env.INTERVIEW_STAFF_TOKEN = "staff-review-secret";
  const { response, env, session } = await runEvaluationApi(true);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal("evaluation" in payload, false);
  const staffResponse = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer staff-review-secret",
      "X-Interview-Reviewer": encodeURIComponent("採用担当B"),
    },
  }, env);
  const staffPayload = await staffResponse.json();
  assert.equal(staffPayload.review.evaluation.recommendation, "human_review");
  assert.equal(staffPayload.review.evaluation.dimensions[0].score, null);
  assert.equal(staffPayload.review.evaluation.dimensions[0].evidence.length, 0);
  assert.ok(staffPayload.review.evaluation.evidenceValidationWarnings.length >= 1);
});

test("evaluation prose naming a prohibited attribute or blaming the equipment is flagged, not rewritten", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  process.env.INTERVIEW_STAFF_TOKEN = "staff-review-secret";
  const { response, env, session } = await runEvaluationApi(false, (evaluation) => ({
    ...evaluation,
    summary: "国籍と家族構成の話題が出ましたが、職務経験は確認できました。",
    concerns: ["回線が不安定でカメラ映像が乱れたため、印象を確認しづらかった。"],
  }));
  assert.equal(response.status, 200);

  const staffResponse = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: { Authorization: "Bearer staff-review-secret", "X-Interview-Reviewer": encodeURIComponent("採用担当B") },
  }, env);
  const evaluation = (await staffResponse.json()).review.evaluation;
  const warnings = evaluation.evidenceValidationWarnings.join("\n");
  assert.match(warnings, /職務と無関係な属性/);
  assert.match(warnings, /国籍/);
  assert.match(warnings, /家族構成/);
  assert.match(warnings, /機器・通信・外見/);
  assert.match(warnings, /回線/);
  assert.match(warnings, /カメラ/);
  // A flagged evaluation is never auto-decided: it is routed to human review.
  assert.equal(evaluation.recommendation, "human_review");
  assert.equal(evaluation.humanReviewRequired, true);
  // Detection only. Rewriting or dropping the sentence would hide the very text a
  // recruiter has to re-read, and would risk deleting a legitimate one on a false match.
  assert.equal(evaluation.summary, "国籍と家族構成の話題が出ましたが、職務経験は確認できました。");
  assert.equal(evaluation.concerns[0], "回線が不安定でカメラ映像が乱れたため、印象を確認しづらかった。");
});

test("concurrent evaluation submissions for the same session never both report success", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateName: "テスト 応募者", employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  const session = await sessionResponse.json();
  database.sessions.get(session.sessionId).status = "in_progress";
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  try {
    globalThis.fetch = async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(modelEvaluation({ invalidEvidence: false })) }],
        }],
      });
    };
    const submit = () => request("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
        transcript: candidateTurns,
      }),
    }, env);
    const [first, second] = await Promise.all([submit(), submit()]);
    // Exactly one submission must be treated as authoritative; the other must be
    // rejected instead of silently no-oping while still claiming success.
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(callCount, 1, "the duplicate must be rejected before a second paid model call");
    assert.equal(database.sessions.get(session.sessionId).status, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unavailable evaluation service persists a human-review fallback without retrying", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database, RECORDINGS: new FakeR2() };
  const session = await createTestInterviewSession(env);
  database.sessions.get(session.sessionId).status = "in_progress";
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  try {
    globalThis.fetch = async () => {
      callCount += 1;
      return Response.json(
        { error: { code: "rate_limit_exceeded", message: "upstream-private-detail" } },
        { status: 429 },
      );
    };
    const submit = () => request("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
        transcript: candidateTurns,
      }),
    }, env);

    const deferred = await submit();
    const payload = await deferred.json();
    assert.equal(deferred.status, 200);
    assert.deepEqual(payload, {
      stored: true,
      humanReviewRequired: true,
      automaticEvaluationDeferred: true,
    });
    assert.equal(JSON.stringify(payload).includes("upstream-private-detail"), false);
    assert.equal(callCount, 1);

    const stored = database.sessions.get(session.sessionId);
    assert.equal(stored.status, "completed");
    const evaluation = JSON.parse(stored.evaluation_json);
    assert.equal(evaluation.recommendation, "human_review");
    assert.equal(evaluation.humanReviewRequired, true);
    assert.equal(evaluation.dimensions.every((dimension) => dimension.score === null), true);

    const replay = await submit();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { stored: true, alreadyStored: true });
    assert.equal(callCount, 1, "the durable fallback receipt must prevent another paid model call");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a malformed evaluation response is stored as a human-review fallback", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database, RECORDINGS: new FakeR2() };
  const session = await createTestInterviewSession(env);
  database.sessions.get(session.sessionId).status = "in_progress";
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "not-json" }],
      }],
    });
    const response = await request("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
        transcript: candidateTurns,
      }),
    }, env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      stored: true,
      humanReviewRequired: true,
      automaticEvaluationDeferred: true,
    });
    const stored = database.sessions.get(session.sessionId);
    assert.equal(stored.status, "completed");
    assert.equal(JSON.parse(stored.evaluation_json).recommendation, "human_review");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a permanent Google Drive refresh-token failure is surfaced instead of retried forever", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  let tokenCalls = 0;
  try {
    globalThis.fetch = async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        tokenCalls += 1;
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      throw new Error("Drive must not be contacted without a refreshed token");
    };
    const response = await requestAdminSync(session.sessionId, env);
    const payload = await response.json();
    assert.equal(response.status, 502, JSON.stringify(payload));
    assert.equal(tokenCalls, 1, "invalid_grant must never enter the transient retry loop");
    assert.equal(database.externalSyncs.get(session.sessionId).status, "failed");
    assert.equal(
      database.externalSyncs.get(session.sessionId).error_code,
      "GOOGLE_DRIVE_TOKEN_REFRESH_RECONNECT_REQUIRED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const DRIVE_ROOT_FOLDER_ID = "10z2FVOAv_MXGlfgxfsO-VgC_41v3Ui3T";

function driveSyncEnv(database) {
  return {
    ...workerEnv,
    DB: database,
    INTERVIEW_ADMIN_TOKEN: "interview-admin-secret",
    GOOGLE_DRIVE_CLIENT_ID: "google-client-id",
    GOOGLE_DRIVE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_DRIVE_REFRESH_TOKEN: "google-refresh-token",
    GOOGLE_DRIVE_ROOT_FOLDER_ID: DRIVE_ROOT_FOLDER_ID,
    GOOGLE_DRIVE_EXPECTED_ROOT_NAME: "オンライン一次面接_自動格納",
  };
}

async function seedCompletedInterview(env, database) {
  const session = await createTestInterviewSession(env, "正社員", "越谷店");
  const stored = database.sessions.get(session.sessionId);
  stored.status = "completed";
  // These claim-fencing tests do not exercise a recording upload. Model them as
  // the supported text interview path so Drive readiness is unrelated to the
  // concurrency behavior under test.
  stored.recording_status = "not_applicable";
  stored.completed_at = "2026-07-29T03:00:00.000Z";
  stored.transcript_json = JSON.stringify([
    { id: "turn-1", speaker: "candidate", text: "接客経験があります。", createdAt: "2026-07-29T02:50:10.000Z" },
  ]);
  stored.evaluation_json = JSON.stringify({
    recommendation: "human_review",
    summary: "採用担当者による確認が必要です。",
    dimensions: [],
    strengths: [],
    concerns: [],
    contradictions: [],
    missingTopics: [],
    conditions: [],
    evidenceValidationWarnings: [],
    humanReviewRequired: true,
  });
  return session;
}

function requestAdminSync(sessionId, env) {
  return request("/api/admin/google-drive/sync", {
    method: "POST",
    headers: { Authorization: "Bearer interview-admin-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }, env);
}

test("Drive archive waits for a camera interview recording instead of completing without video", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  database.sessions.get(session.sessionId).recording_status = "uploading";
  let driveCalls = 0;
  try {
    globalThis.fetch = async () => {
      driveCalls += 1;
      throw new Error("Drive must not be touched before the recording is durable");
    };
    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 409);
    assert.equal(driveCalls, 0);
    assert.equal(
      database.externalSyncs.get(session.sessionId).error_code,
      "INTERVIEW_RECORDING_NOT_READY_FOR_DRIVE_SYNC",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Drive archive rejects an interviewer-only transcript before any Drive request", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  database.sessions.get(session.sessionId).transcript_json = JSON.stringify([
    {
      id: "interviewer-only-1",
      speaker: "interviewer",
      text: "自己紹介をお願いします。",
      createdAt: "2026-07-29T02:50:00.000Z",
    },
  ]);
  let driveCalls = 0;
  try {
    globalThis.fetch = async () => {
      driveCalls += 1;
      throw new Error("Drive must not be touched without a candidate utterance");
    };
    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 409);
    assert.equal(driveCalls, 0);
    assert.equal(
      database.externalSyncs.get(session.sessionId).error_code,
      "INTERVIEW_TRANSCRIPT_NOT_READY_FOR_DRIVE_SYNC",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Drive archive rejects a partial realtime transcript after a candidate turn was lost", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  database.auditEvents.push({
    session_id: session.sessionId,
    event_type: "transcription_failed",
    detail_json: JSON.stringify({ code: "TRANSCRIPTION_FAILED" }),
    created_at: "2026-07-29T02:55:00.000Z",
  });
  let driveCalls = 0;
  try {
    globalThis.fetch = async () => {
      driveCalls += 1;
      throw new Error("Drive must not be touched with a known missing candidate turn");
    };
    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 409);
    assert.equal(driveCalls, 0);
    assert.equal(
      database.externalSyncs.get(session.sessionId).error_code,
      "INTERVIEW_TRANSCRIPT_NOT_READY_FOR_DRIVE_SYNC",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completed recorded-answer transcripts supersede an earlier realtime transcription failure", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  database.sessions.get(session.sessionId).transcript_json = JSON.stringify([
    {
      id: "recorded-transcribed-answer-1",
      speaker: "candidate",
      text: "接客経験があり、安全確認を大切にしています。",
      createdAt: "2026-07-29T02:50:10.000Z",
    },
  ]);
  database.auditEvents.push({
    session_id: session.sessionId,
    event_type: "transcription_failed",
    detail_json: JSON.stringify({ code: "TRANSCRIPTION_FAILED" }),
    created_at: "2026-07-29T02:49:00.000Z",
  });
  database.externalSyncs.set(session.sessionId, {
    provider: "google_drive",
    status: "completed",
    requested_at: "2026-07-29T02:00:00.000Z",
    started_at: "2026-07-29T02:00:01.000Z",
    completed_at: "2026-07-29T02:01:00.000Z",
    folder_id: "recorded-recovery-folder",
    folder_url: "https://drive.google.com/drive/folders/recorded-recovery-folder",
    manifest_json: JSON.stringify({
      files: { transcript: { id: "actual-transcript", name: "transcript.txt", size: 80 } },
      recordingIncluded: false,
      transcriptAvailable: true,
      transcriptKind: "actual_transcript",
    }),
    error_code: null,
    updated_at: "2026-07-29T02:01:00.000Z",
  });
  let driveCalls = 0;
  try {
    globalThis.fetch = async () => {
      driveCalls += 1;
      throw new Error("verified completed receipt must be an exact D1 readback");
    };
    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result.transcriptKind, "actual_transcript");
    assert.equal(driveCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a completed receipt cannot verify a recorded-fallback placeholder transcript", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  database.sessions.get(session.sessionId).transcript_json = JSON.stringify([
    {
      id: "recorded-fallback-answer-1",
      speaker: "candidate",
      text: "自己紹介をお願いします。の回答を録画で受領しました。",
      createdAt: "2026-07-29T02:50:10.000Z",
    },
  ]);
  database.externalSyncs.set(session.sessionId, {
    provider: "google_drive",
    status: "completed",
    requested_at: "2026-07-29T02:00:00.000Z",
    started_at: "2026-07-29T02:00:01.000Z",
    completed_at: "2026-07-29T02:01:00.000Z",
    folder_id: "legacy-placeholder-folder",
    folder_url: "https://drive.google.com/drive/folders/legacy-placeholder-folder",
    manifest_json: JSON.stringify({
      files: { transcript: { id: "legacy-placeholder", name: "placeholder.txt", size: 80 } },
      recordingIncluded: false,
      transcriptAvailable: true,
      transcriptKind: "unknown",
    }),
    error_code: null,
    updated_at: "2026-07-29T02:01:00.000Z",
  });
  let driveCalls = 0;
  try {
    globalThis.fetch = async () => {
      driveCalls += 1;
      throw new Error("Drive must not be touched with a placeholder transcript");
    };
    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 409);
    assert.equal(driveCalls, 0);
    const receipt = database.externalSyncs.get(session.sessionId);
    assert.equal(receipt.status, "completed", "the invalid historical receipt remains visible for repair/audit");
    assert.equal(JSON.parse(receipt.manifest_json).transcriptKind, "unknown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a Google Drive archive still reporting progress is never restarted underneath itself", async () => {
  // Two workers archiving the same interview both create the candidate folder and
  // both upload each artifact, so Drive ends up with duplicates and the read-back
  // check rejects the archive. Reclaiming the claim is therefore only allowed once
  // the owner has gone silent for the whole stale window, not merely once it has
  // been running that long.
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1_000).toISOString();
  database.externalSyncs.set(session.sessionId, {
    provider: "google_drive",
    status: "running",
    requested_at: thirtyMinutesAgo,
    started_at: thirtyMinutesAgo,
    completed_at: null,
    folder_id: null,
    folder_url: null,
    manifest_json: null,
    error_code: null,
    // The owning worker reported progress a moment ago: it is slow, not dead.
    updated_at: new Date().toISOString(),
  });

  let driveCalls = 0;
  try {
    globalThis.fetch = async () => {
      driveCalls += 1;
      throw new Error("a second worker must never reach Google Drive");
    };
    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json().then((payload) => ({ synced: payload.synced, phase: payload.result?.phase })), {
      synced: false,
      phase: "initializing",
    });
    assert.equal(driveCalls, 0, "the live archive must not be duplicated by a second worker");
    const sync = database.externalSyncs.get(session.sessionId);
    assert.equal(sync.status, "running");
    assert.equal(sync.started_at, thirtyMinutesAgo, "the live claim must stay with its owner");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a Google Drive archive that stopped reporting progress is reclaimed", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1_000).toISOString();
  database.externalSyncs.set(session.sessionId, {
    provider: "google_drive",
    status: "running",
    requested_at: thirtyMinutesAgo,
    started_at: thirtyMinutesAgo,
    completed_at: null,
    folder_id: null,
    folder_url: null,
    manifest_json: null,
    error_code: null,
    // No heartbeat for the whole stale window: the worker is gone.
    updated_at: thirtyMinutesAgo,
  });

  try {
    globalThis.fetch = async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      // Stop the reclaimed run at the approved-root check so the test asserts the
      // reclaim itself rather than a full archive.
      return Response.json({
        id: DRIVE_ROOT_FOLDER_ID,
        name: "別のフォルダ",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
        capabilities: { canAddChildren: true },
      });
    };
    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 502);
    const sync = database.externalSyncs.get(session.sessionId);
    assert.equal(sync.status, "failed", "the abandoned claim must be taken over and settled");
    assert.notEqual(sync.started_at, thirtyMinutesAgo);
    assert.equal(sync.error_code, "GOOGLE_DRIVE_ROOT_MISMATCH");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a Google Drive worker that loses its claim stops before duplicating candidate files", async () => {
  const originalFetch = globalThis.fetch;
  const database = new FakeD1();
  const env = driveSyncEnv(database);
  const session = await seedCompletedInterview(env, database);
  const uploadedNames = [];
  let nextFile = 0;
  let reclaimed = false;

  try {
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "temporary-google-access-token", expires_in: 3600 });
      }
      if (href.includes(`/drive/v3/files/${DRIVE_ROOT_FOLDER_ID}?`)) {
        return Response.json({
          id: DRIVE_ROOT_FOLDER_ID,
          name: "オンライン一次面接_自動格納",
          mimeType: "application/vnd.google-apps.folder",
          trashed: false,
          capabilities: { canAddChildren: true },
        });
      }
      if (href.startsWith("https://www.googleapis.com/drive/v3/files?") && init.method !== "POST") {
        return Response.json({ files: [] });
      }
      if (href.startsWith("https://www.googleapis.com/drive/v3/files?") && init.method === "POST") {
        const metadata = JSON.parse(String(init.body));
        const id = `folder-${++nextFile}`;
        return Response.json({
          id,
          name: metadata.name,
          mimeType: metadata.mimeType,
          parents: metadata.parents,
          appProperties: metadata.appProperties,
          webViewLink: `https://drive.google.com/drive/folders/${id}`,
        });
      }
      if (href.includes("uploadType=multipart")) {
        const metadata = JSON.parse(await init.body.get("metadata").text());
        uploadedNames.push(metadata.name);
        if (!reclaimed) {
          // Another worker takes the claim while this upload is in flight.
          reclaimed = true;
          database.externalSyncs.get(session.sessionId).started_at = "2099-01-01T00:00:00.000Z";
        }
        return Response.json({ id: `file-${++nextFile}`, name: metadata.name, size: "10" });
      }
      throw new Error(`Unexpected Drive request: ${href}`);
    };

    const response = await requestAdminSync(session.sessionId, env);
    assert.equal(response.status, 502);
    assert.deepEqual(
      uploadedNames,
      [`${session.sessionId}_文字起こし.txt`],
      "the worker must stop at its next progress check instead of re-uploading every artifact",
    );
    const sync = database.externalSyncs.get(session.sessionId);
    // The losing worker's failure write is fenced on its own claim, so it must not
    // mark the archive that the new owner is now running as failed.
    assert.equal(sync.started_at, "2099-01-01T00:00:00.000Z");
    assert.notEqual(sync.status, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
