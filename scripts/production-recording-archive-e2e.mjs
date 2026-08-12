import { readFile } from "node:fs/promises";

const baseUrl = (process.env.INTERVIEW_E2E_BASE_URL ?? "").replace(/\/$/, "");
const recordingPath = process.env.INTERVIEW_E2E_RECORDING_PATH ?? "";
const partSize = 4 * 1024 * 1024;
if (!/^https:\/\//.test(baseUrl)) throw new Error("INTERVIEW_E2E_BASE_URL must be an https URL");
if (!recordingPath) throw new Error("INTERVIEW_E2E_RECORDING_PATH is required");

const startedAt = Date.now();
const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const candidateName = `社内大容量格納試験 ${runId}`;
const origin = new URL(baseUrl).origin;
const results = [];
const recording = await readFile(recordingPath);
const totalParts = Math.ceil(recording.byteLength / partSize);
if (totalParts < 10) throw new Error("The recording fixture must contain at least 10 upload parts");

function add(step, response, detail = {}) {
  results.push({ step, status: response.status, ok: response.ok, ...detail });
}

async function json(response) {
  return await response.json().catch(() => ({}));
}

function stop(message, detail = {}) {
  process.stdout.write(`${JSON.stringify({ testData: "synthetic-large-archive", candidateName, results, failure: { message, ...detail } }, null, 2)}\n`);
  throw new Error(message);
}

const commonHeaders = { Origin: origin };
const sessionResponse = await fetch(`${baseUrl}/api/interviews/session`, {
  method: "POST",
  headers: { ...commonHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({
    candidateName,
    employment: "正社員",
    location: "社内試験店舗（実応募ではありません）",
    consent: true,
    interviewMode: "camera",
  }),
});
const session = await json(sessionResponse);
add("candidate_session", sessionResponse, { sessionId: session.sessionId });
if (!sessionResponse.ok || !session.sessionId || !session.accessToken) stop("Candidate session failed", { error: session.error });

const authorizedHeaders = {
  ...commonHeaders,
  Authorization: `Bearer ${session.accessToken}`,
  "X-Interview-Session": session.sessionId,
};
const recordedStart = await fetch(`${baseUrl}/api/interviews/recorded/start`, {
  method: "POST",
  headers: authorizedHeaders,
});
add("recorded_fallback_start", recordedStart);
if (!recordedStart.ok) stop("Recorded fallback start failed", { body: await json(recordedStart) });

async function startUpload() {
  const response = await fetch(`${baseUrl}/api/interviews/recording/upload/start`, {
    method: "POST",
    headers: { ...authorizedHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      contentType: "video/webm",
      byteSize: recording.byteLength,
      partSize,
      totalParts,
      audioCoverage: "both",
    }),
  });
  return { response, body: await json(response) };
}

async function uploadPart(index) {
  const start = index * partSize;
  const part = recording.subarray(start, Math.min(recording.byteLength, start + partSize));
  const response = await fetch(`${baseUrl}/api/interviews/recording/upload/part`, {
    method: "PUT",
    headers: {
      ...authorizedHeaders,
      "Content-Type": "application/octet-stream",
      "X-Recording-Part-Index": String(index),
      "X-Recording-Part-Bytes": String(part.byteLength),
    },
    body: part,
  });
  return { response, body: await json(response) };
}

const initial = await startUpload();
add("resumable_start", initial.response, { totalParts, bytes: recording.byteLength });
if (!initial.response.ok || !Array.isArray(initial.body.uploadedParts)) stop("Resumable upload start failed", { error: initial.body.error });

const pauseAfter = Math.max(2, Math.floor(totalParts / 2));
for (let index = 0; index < pauseAfter; index += 1) {
  const uploaded = await uploadPart(index);
  if (!uploaded.response.ok) stop("Initial part upload failed", { index, error: uploaded.body.error });
}
const duplicate = await uploadPart(0);
add("duplicate_part_is_idempotent", duplicate.response, { duplicate: duplicate.body.duplicate === true });
if (!duplicate.response.ok || duplicate.body.duplicate !== true) stop("Duplicate part was not idempotent", { error: duplicate.body.error });

const resumed = await startUpload();
add("resume_readback", resumed.response, { uploadedParts: resumed.body.uploadedParts?.length ?? -1 });
if (!resumed.response.ok || resumed.body.uploadedParts?.length !== pauseAfter) {
  stop("Resume readback mismatch", { expected: pauseAfter, actual: resumed.body.uploadedParts });
}
for (let index = pauseAfter; index < totalParts; index += 1) {
  const uploaded = await uploadPart(index);
  if (!uploaded.response.ok) stop("Resumed part upload failed", { index, error: uploaded.body.error });
}

const finalizeStartedAt = Date.now();
const finalize = await fetch(`${baseUrl}/api/interviews/recording/upload/complete`, {
  method: "POST",
  headers: authorizedHeaders,
});
const finalized = await json(finalize);
add("recording_finalize", finalize, { elapsedMs: Date.now() - finalizeStartedAt, totalParts: finalized.totalParts });
if (!finalize.ok || finalized.stored !== true || finalized.totalParts !== totalParts) stop("Recording finalize failed", { error: finalized.error });

const finalizeReplay = await fetch(`${baseUrl}/api/interviews/recording/upload/complete`, {
  method: "POST",
  headers: authorizedHeaders,
});
const replayed = await json(finalizeReplay);
add("recording_finalize_idempotent", finalizeReplay, { alreadyStored: replayed.alreadyStored === true });
if (!finalizeReplay.ok || replayed.stored !== true || replayed.alreadyStored !== true) stop("Recording finalize replay failed", { error: replayed.error });

const complete = await fetch(`${baseUrl}/api/interviews/recorded/complete`, {
  method: "POST",
  headers: { ...commonHeaders, Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: session.sessionId, questionCount: 15 }),
});
const completed = await json(complete);
add("recorded_fallback_complete", complete, { stored: completed.stored === true });
if (!complete.ok || completed.stored !== true) stop("Recorded fallback completion failed", { error: completed.error });

const archiveStartedAt = Date.now();
const archive = await fetch(`${baseUrl}/api/interviews/archive`, {
  method: "POST",
  headers: { ...commonHeaders, Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: session.sessionId }),
});
const archived = await json(archive);
const archiveElapsedMs = Date.now() - archiveStartedAt;
add("foreground_drive_archive", archive, {
  elapsedMs: archiveElapsedMs,
  stored: archived.stored === true,
  recordingIncluded: archived.recordingIncluded === true,
});
if (!archive.ok || archived.stored !== true || archived.recordingIncluded !== true) stop("Foreground archive failed", { error: archived.error });

process.stdout.write(`${JSON.stringify({
  testData: "synthetic-large-archive",
  candidateName,
  sessionId: session.sessionId,
  recordingBytes: recording.byteLength,
  totalParts,
  archiveElapsedMs,
  elapsedMs: Date.now() - startedAt,
  results,
  driveReadbackRequired: true,
}, null, 2)}\n`);
