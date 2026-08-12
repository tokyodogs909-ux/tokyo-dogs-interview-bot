import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const baseUrl = (process.env.INTERVIEW_E2E_BASE_URL ?? "").replace(/\/$/, "");
const recordingPath = process.env.INTERVIEW_E2E_RECORDING_PATH ?? "";
const answerAudioPath = process.env.INTERVIEW_E2E_ANSWER_AUDIO_PATH ?? "";
const answerCount = Number(process.env.INTERVIEW_E2E_ANSWER_COUNT ?? "1");
const partSize = 4 * 1024 * 1024;
const maxAnswerAttempts = 8;
const maxAnswerRetrySeconds = 15;
if (!/^https:\/\//.test(baseUrl)) throw new Error("INTERVIEW_E2E_BASE_URL must be an https URL");
if (!recordingPath) throw new Error("INTERVIEW_E2E_RECORDING_PATH is required");
if (!answerAudioPath) throw new Error("INTERVIEW_E2E_ANSWER_AUDIO_PATH is required");
if (!Number.isInteger(answerCount) || answerCount < 1 || answerCount > 15) {
  throw new Error("INTERVIEW_E2E_ANSWER_COUNT must be an integer from 1 to 15");
}

const startedAt = Date.now();
const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const candidateName = `社内大容量格納試験 ${runId}`;
const origin = new URL(baseUrl).origin;
const results = [];
const recording = await readFile(recordingPath);
const answerAudio = await readFile(answerAudioPath);
const recordingSha256 = createHash("sha256").update(recording).digest("hex");
const recordingMd5 = createHash("md5").update(recording).digest("hex");
const answerAudioSha256 = createHash("sha256").update(answerAudio).digest("hex");
const totalParts = Math.ceil(recording.byteLength / partSize);
if (totalParts < 10) throw new Error("The recording fixture must contain at least 10 upload parts");
if (answerAudio.byteLength < 8 || answerAudio.byteLength > 10 * 1024 * 1024) {
  throw new Error("The answer audio fixture must be between 8 bytes and 10 MiB");
}

function answerAudioContentType(bytes) {
  const isWebm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (isWebm) return "audio/webm";
  const isMp4 = String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp";
  if (isMp4) return "audio/mp4";
  throw new Error("INTERVIEW_E2E_ANSWER_AUDIO_PATH must point to a standalone WebM or MP4 audio file");
}

const answerContentType = answerAudioContentType(answerAudio);

function add(step, response, detail = {}) {
  results.push({ step, status: response.status, ok: response.ok, ...detail });
}

async function json(response) {
  return await response.json().catch(() => ({}));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedRetryAfterSeconds(response) {
  const value = response.headers.get("Retry-After")?.trim() ?? "";
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) && numeric >= 0
    ? numeric
    : (Date.parse(value) - Date.now()) / 1_000;
  if (!value || !Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.min(maxAnswerRetrySeconds, Math.max(0.25, parsed));
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

async function uploadAndTranscribeAnswer(answerIndex) {
  for (let attempt = 1; attempt <= maxAnswerAttempts; attempt += 1) {
    const includesAudio = attempt === 1;
    const requestStartedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/interviews/recorded/answer`, {
      method: "POST",
      headers: {
        ...authorizedHeaders,
        "X-Recorded-Answer-Index": String(answerIndex),
        ...(includesAudio ? {
          "Content-Type": answerContentType,
          "X-Recorded-Answer-Bytes": String(answerAudio.byteLength),
        } : {}),
      },
      ...(includesAudio ? { body: answerAudio } : {}),
    });
    const body = await json(response);
    const retryAfterSeconds = response.status === 202
      ? boundedRetryAfterSeconds(response)
      : null;
    add("recorded_answer_transcription", response, {
      answerIndex,
      attempt,
      includesAudio,
      elapsedMs: Date.now() - requestStartedAt,
      stored: body.stored === true,
      transcribed: body.transcribed === true,
      pending: body.pending === true,
      ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
    });

    if (response.status === 200) {
      if (body.stored !== true || body.transcribed !== true || body.answerIndex !== answerIndex) {
        stop("Recorded answer did not return a verified transcription receipt", {
          answerIndex,
          attempt,
          status: response.status,
        });
      }
      return;
    }
    if (response.status !== 202 || body.stored !== true || body.pending !== true) {
      stop("Recorded answer transcription failed", {
        answerIndex,
        attempt,
        status: response.status,
        error: body.error,
      });
    }
    if (retryAfterSeconds === null) {
      stop("Recorded answer retry response omitted a valid Retry-After header", { answerIndex, attempt });
    }
    if (attempt === maxAnswerAttempts) {
      stop("Recorded answer transcription did not finish within the finite retry budget", {
        answerIndex,
        attempts: maxAnswerAttempts,
      });
    }
    await wait(retryAfterSeconds * 1_000);
  }
}

// Match the browser's fail-closed order. The expected answer count is sealed
// before the large recording is finalized, so server recovery can distinguish
// an intentionally finished interview from an early or truncated upload.
for (let answerIndex = 1; answerIndex <= answerCount; answerIndex += 1) {
  await uploadAndTranscribeAnswer(answerIndex);
}

const seal = await fetch(`${baseUrl}/api/interviews/recorded/seal`, {
  method: "POST",
  headers: { ...authorizedHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: session.sessionId, expectedAnswerCount: answerCount }),
});
const sealed = await json(seal);
add("recorded_completion_seal", seal, {
  sealed: sealed.sealed === true,
  expectedAnswerCount: sealed.expectedAnswerCount,
});
if (seal.status !== 200 || sealed.sealed !== true || sealed.expectedAnswerCount !== answerCount) {
  stop("Recorded completion count seal failed", { status: seal.status, error: sealed.error });
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
  headers: { ...authorizedHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: session.sessionId, questionCount: answerCount }),
});
const completed = await json(complete);
add("recorded_fallback_complete", complete, { stored: completed.stored === true });
if (complete.status !== 200 || completed.stored !== true) stop("Recorded fallback completion failed", { error: completed.error });

const completeReplay = await fetch(`${baseUrl}/api/interviews/recorded/complete`, {
  method: "POST",
  headers: { ...authorizedHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: session.sessionId, questionCount: answerCount }),
});
const completedReplay = await json(completeReplay);
add("recorded_fallback_complete_idempotent", completeReplay, {
  stored: completedReplay.stored === true,
  alreadyCompleted: completedReplay.alreadyCompleted === true,
});
if (
  completeReplay.status !== 200 ||
  completedReplay.stored !== true ||
  completedReplay.alreadyCompleted !== true
) {
  stop("Recorded fallback completion replay failed", {
    status: completeReplay.status,
    error: completedReplay.error,
  });
}

const archiveStartedAt = Date.now();
const maxArchiveAttempts = totalParts + 20;
let archived = null;
let previousCommittedOffset = 0;
for (let attempt = 1; attempt <= maxArchiveAttempts; attempt += 1) {
  const stepStartedAt = Date.now();
  const archive = await fetch(`${baseUrl}/api/interviews/archive`, {
    method: "POST",
    headers: { ...authorizedHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId }),
  });
  const step = await json(archive);
  const isStored = step.stored === true;
  const committedOffset = isStored ? recording.byteLength : Number(step.committedOffset ?? 0);
  const totalBytes = isStored ? recording.byteLength : Number(step.totalBytes ?? 0);
  add("foreground_drive_archive_step", archive, {
    attempt,
    elapsedMs: Date.now() - stepStartedAt,
    stored: step.stored === true,
    recordingIncluded: step.recordingIncluded === true,
    pending: step.pending === true,
    phase: isStored ? "completed" : (typeof step.phase === "string" ? step.phase : null),
    committedOffset,
    totalBytes,
  });

  if (!archive.ok) {
    stop("Foreground archive step failed", { attempt, status: archive.status, error: step.error });
  }
  if (step.stored === true) {
    if (step.recordingIncluded !== true) {
      stop("Foreground archive completed without the recording", { attempt });
    }
    archived = step;
    break;
  }
  if (step.pending !== true || typeof step.phase !== "string") {
    stop("Foreground archive returned neither a stored receipt nor a pending step", { attempt });
  }
  if (
    !Number.isInteger(committedOffset) ||
    committedOffset < previousCommittedOffset ||
    committedOffset > recording.byteLength
  ) {
    stop("Foreground archive committed offset was invalid or regressed", {
      attempt,
      previousCommittedOffset,
      committedOffset,
    });
  }
  if (totalBytes !== 0 && totalBytes !== recording.byteLength) {
    stop("Foreground archive total byte count did not match the uploaded recording", {
      attempt,
      expected: recording.byteLength,
      actual: totalBytes,
    });
  }
  previousCommittedOffset = committedOffset;
  if (attempt === maxArchiveAttempts) {
    stop("Foreground archive did not finish within the finite step budget", {
      attempts: maxArchiveAttempts,
      committedOffset,
    });
  }
  const retryAfterMs = Number(step.retryAfterMs ?? 250);
  await wait(Number.isFinite(retryAfterMs) ? Math.min(5_000, Math.max(0, retryAfterMs)) : 250);
}
const archiveElapsedMs = Date.now() - archiveStartedAt;
if (
  !archived ||
  archived.stored !== true ||
  archived.recordingIncluded !== true ||
  archived.transcriptAvailable !== true ||
  archived.transcriptKind !== "actual_transcript"
) {
  stop("Foreground archive did not produce a verified receipt");
}

process.stdout.write(`${JSON.stringify({
  testData: "synthetic-large-archive",
  candidateName,
  sessionId: session.sessionId,
  recordingBytes: recording.byteLength,
  recordingSha256,
  recordingMd5,
  totalParts,
  answerCount,
  answerAudioBytes: answerAudio.byteLength,
  answerAudioSha256,
  answerContentType,
  archiveElapsedMs,
  elapsedMs: Date.now() - startedAt,
  results,
  driveReadbackRequired: true,
}, null, 2)}\n`);
