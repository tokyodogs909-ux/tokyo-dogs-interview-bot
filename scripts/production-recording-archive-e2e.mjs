import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const baseUrl = (process.env.INTERVIEW_E2E_BASE_URL ?? "").replace(/\/$/, "");
const recordingPath = process.env.INTERVIEW_E2E_RECORDING_PATH ?? "";
const answerAudioPath = process.env.INTERVIEW_E2E_ANSWER_AUDIO_PATH ?? "";
const answerCount = Number(process.env.INTERVIEW_E2E_ANSWER_COUNT ?? "1");
const partSize = 4 * 1024 * 1024;
const minimumRecordingFixtureBytes = 70_000_000;
const minimumRecordingFixtureDurationSeconds = 60;
const recordingAudioCoverage = "unverified";
const maxServerRetryAfterSeconds = 300;
const answerRetryWallClockMs = 10 * 60 * 1_000;
const archiveWallClockMs = 15 * 60 * 1_000;
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
const recordingPartSha256s = Array.from({ length: totalParts }, (_, index) => {
  const start = index * partSize;
  return createHash("sha256")
    .update(recording.subarray(start, Math.min(recording.byteLength, start + partSize)))
    .digest("hex");
});
if (recording.byteLength < minimumRecordingFixtureBytes) {
  throw new Error(`The recording fixture must be at least ${minimumRecordingFixtureBytes} bytes`);
}
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

function probeMedia(path, requirements, minimumDurationSeconds = 0.5) {
  const probe = spawnSync(
    process.env.INTERVIEW_E2E_FFPROBE_PATH ?? "ffprobe",
    ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name", "-of", "json", path],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (probe.status !== 0) throw new Error(`Media fixture is not readable by ffprobe: ${path}`);
  const info = JSON.parse(probe.stdout || "{}");
  const durationSeconds = Number(info?.format?.duration);
  const formatNames = String(info?.format?.format_name ?? "").split(",");
  const streams = Array.isArray(info?.streams) ? info.streams : [];
  const hasRequiredStream = (type, codecs) => streams.some((stream) =>
    stream?.codec_type === type && codecs.includes(stream?.codec_name));
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < minimumDurationSeconds ||
    !formatNames.includes(requirements.format) ||
    !hasRequiredStream(requirements.video.type, requirements.video.codecs) ||
    !hasRequiredStream(requirements.audio.type, requirements.audio.codecs)
  ) {
    throw new Error(`Media fixture does not meet the strict WebM codec contract: ${path}`);
  }
  return durationSeconds;
}

const recordingDurationSeconds = probeMedia(
  recordingPath,
  {
    format: "webm",
    video: { type: "video", codecs: ["vp8", "vp9", "av1"] },
    audio: { type: "audio", codecs: ["opus", "vorbis"] },
  },
  minimumRecordingFixtureDurationSeconds,
);
const answerAudioDurationSeconds = (() => {
  const probe = spawnSync(
    process.env.INTERVIEW_E2E_FFPROBE_PATH ?? "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", answerAudioPath],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (probe.status !== 0) throw new Error(`Media fixture is not readable by ffprobe: ${answerAudioPath}`);
  const info = JSON.parse(probe.stdout || "{}");
  const durationSeconds = Number(info?.format?.duration);
  const hasAudio = Array.isArray(info?.streams) && info.streams.some((stream) => stream?.codec_type === "audio");
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0.5 || !hasAudio) {
    throw new Error(`Media fixture is not decodable with the required audio stream: ${answerAudioPath}`);
  }
  return durationSeconds;
})();

function add(step, response, detail = {}) {
  results.push({ step, status: response.status, ok: response.ok, ...detail });
}

async function json(response) {
  return await response.json().catch(() => ({}));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterReceipt(response, body) {
  const rawHeader = response.headers.get("Retry-After")?.trim() ?? "";
  const retryAfterSeconds = body.retryAfterSeconds;
  if (
    !Number.isInteger(retryAfterSeconds) ||
    retryAfterSeconds <= 0 ||
    rawHeader !== String(retryAfterSeconds)
  ) return null;
  return {
    retryAfterSeconds,
    // Preserve and verify the raw server receipt above. Only the local sleep is
    // capped, so an unexpected huge value cannot make this finite E2E hang.
    retrySleepSeconds: Math.min(maxServerRetryAfterSeconds, retryAfterSeconds),
  };
}

function hasExactIndexes(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => Number.isInteger(value) && value === expected[index]);
}

function hasExactPartReceipts(actual, expectedIndexes) {
  return Array.isArray(actual) &&
    actual.length === expectedIndexes.length &&
    actual.every((receipt, offset) =>
      receipt?.index === expectedIndexes[offset] &&
      receipt.sha256 === recordingPartSha256s[expectedIndexes[offset]]
    );
}

function verifiedUploadReadback(body, expectedUploadedParts, expectedStored) {
  return body.stored === expectedStored &&
    body.uploadVersion === 2 &&
    hasExactIndexes(body.uploadedParts, expectedUploadedParts) &&
    hasExactPartReceipts(body.uploadedPartReceipts, expectedUploadedParts) &&
    body.contentType === "video/webm" &&
    body.byteSize === recording.byteLength &&
    body.partSize === partSize &&
    body.totalParts === totalParts &&
    body.audioCoverage === recordingAudioCoverage;
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
      audioCoverage: recordingAudioCoverage,
      uploadVersion: 2,
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
      "X-Recording-Part-Sha256": recordingPartSha256s[index],
    },
    body: part,
  });
  return { response, body: await json(response) };
}

function verifiedAnswerReceipt(body, answerIndex) {
  return body.stored === true && body.transcribed === true && body.answerIndex === answerIndex;
}

function verifiedPendingAnswer(body, answerIndex) {
  return body.stored === true && body.transcribed === false &&
    body.pending === true && body.answerIndex === answerIndex;
}

async function uploadAnswerOnce(answerIndex) {
  const requestStartedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/interviews/recorded/answer`, {
    method: "POST",
    headers: {
      ...authorizedHeaders,
      "X-Recorded-Answer-Index": String(answerIndex),
      "Content-Type": answerContentType,
      "X-Recorded-Answer-Bytes": String(answerAudio.byteLength),
    },
    body: answerAudio,
  });
  const body = await json(response);
  const retryReceipt = response.status === 202
    ? retryAfterReceipt(response, body)
    : null;
  add("recorded_answer_transcription", response, {
    answerIndex,
    phase: "initial_upload",
    includesAudio: true,
    elapsedMs: Date.now() - requestStartedAt,
    stored: body.stored === true,
    transcribed: body.transcribed === true,
    pending: body.pending === true,
    ...(retryReceipt === null ? {} : retryReceipt),
  });

  if (response.status === 200) {
    if (!verifiedAnswerReceipt(body, answerIndex)) {
      stop("Recorded answer did not return a verified transcription receipt", {
        answerIndex,
        phase: "initial_upload",
        status: response.status,
      });
    }
    return null;
  }
  if (response.status !== 202 || !verifiedPendingAnswer(body, answerIndex)) {
    stop("Recorded answer initial upload failed", {
      answerIndex,
      status: response.status,
      error: body.error,
    });
  }
  if (retryReceipt === null) {
    stop("Recorded answer initial response had an invalid Retry-After receipt", { answerIndex });
  }
  return {
    answerIndex,
    retryNotBefore: Date.now() + retryReceipt.retrySleepSeconds * 1_000,
  };
}

async function recordedCompletionRequest() {
  const response = await fetch(`${baseUrl}/api/interviews/recorded/complete`, {
    method: "POST",
    headers: { ...authorizedHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId, questionCount: answerCount }),
  });
  return { response, body: await json(response) };
}

async function verifyConcurrentRecordedCompletion(answerIndex) {
  const replay = await recordedCompletionRequest();
  add("recorded_fallback_concurrent_completion", replay.response, {
    answerIndex,
    stored: replay.body.stored === true,
    humanReviewRequired: replay.body.humanReviewRequired === true,
    alreadyCompleted: replay.body.alreadyCompleted === true,
  });
  if (
    replay.response.status !== 200 ||
    replay.body.stored !== true ||
    replay.body.humanReviewRequired !== true ||
    replay.body.alreadyCompleted !== true
  ) {
    stop("Recorded answer returned 409 without an exact completed-session receipt", {
      answerIndex,
      completionStatus: replay.response.status,
      recordingDurablyStored: true,
    });
  }
  return { completedElsewhere: true };
}

async function finishPendingAnswer(pendingAnswer, retryDeadlineAt) {
  let retryNotBefore = pendingAnswer.retryNotBefore;
  let retryAttempt = 0;
  while (true) {
    const waitMs = Math.max(0, retryNotBefore - Date.now());
    if (Date.now() + waitMs > retryDeadlineAt) {
      stop("Recorded answer transcription did not finish within the wall-clock deadline", {
        answerIndex: pendingAnswer.answerIndex,
        retries: retryAttempt,
        recordingDurablyStored: true,
      });
    }
    if (waitMs > 0) await wait(waitMs);
    retryAttempt += 1;
    const requestStartedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/interviews/recorded/answer`, {
      method: "POST",
      headers: {
        ...authorizedHeaders,
        "X-Recorded-Answer-Index": String(pendingAnswer.answerIndex),
      },
    });
    const body = await json(response);
    const retryReceipt = response.status === 202
      ? retryAfterReceipt(response, body)
      : null;
    add("recorded_answer_transcription", response, {
      answerIndex: pendingAnswer.answerIndex,
      phase: "bodyless_retry",
      retryAttempt,
      includesAudio: false,
      elapsedMs: Date.now() - requestStartedAt,
      stored: body.stored === true,
      transcribed: body.transcribed === true,
      pending: body.pending === true,
      ...(retryReceipt === null ? {} : retryReceipt),
    });

    if (response.status === 200) {
      if (!verifiedAnswerReceipt(body, pendingAnswer.answerIndex)) {
        stop("Recorded answer retry did not return a verified transcription receipt", {
          answerIndex: pendingAnswer.answerIndex,
          retryAttempt,
          status: response.status,
        });
      }
      return { completedElsewhere: false };
    }
    if (response.status === 409) {
      // An authenticated staff recovery may have completed the session between
      // our durable recording receipt and this candidate retry. A generic 409 is
      // never success: require the completion endpoint's exact idempotent receipt.
      return await verifyConcurrentRecordedCompletion(pendingAnswer.answerIndex);
    }
    if (response.status !== 202 || !verifiedPendingAnswer(body, pendingAnswer.answerIndex)) {
      stop("Recorded answer bodyless retry failed", {
        answerIndex: pendingAnswer.answerIndex,
        retryAttempt,
        status: response.status,
        error: body.error,
      });
    }
    if (retryReceipt === null) {
      stop("Recorded answer retry response had an invalid Retry-After receipt", {
        answerIndex: pendingAnswer.answerIndex,
        retryAttempt,
      });
    }
    retryNotBefore = Date.now() + retryReceipt.retrySleepSeconds * 1_000;
    if (retryNotBefore > retryDeadlineAt) {
      stop("Recorded answer transcription did not finish within the wall-clock deadline", {
        answerIndex: pendingAnswer.answerIndex,
        retries: retryAttempt,
        recordingDurablyStored: true,
      });
    }
  }
}

// Match the browser's fail-closed order. First durably register every answer
// audio object exactly once. A retryable transcription response must not block
// the seal or the much larger recording upload; otherwise an upstream speech
// outage would discard the only complete video before recovery can run.
const pendingAnswers = [];
for (let answerIndex = 1; answerIndex <= answerCount; answerIndex += 1) {
  const pending = await uploadAnswerOnce(answerIndex);
  if (pending) pendingAnswers.push(pending);
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
add("resumable_start", initial.response, {
  totalParts,
  bytes: recording.byteLength,
  stored: initial.body.stored === true,
  uploadedParts: initial.body.uploadedParts,
});
if (!initial.response.ok || !verifiedUploadReadback(initial.body, [], false)) {
  stop("Resumable upload start receipt mismatch", { error: initial.body.error });
}

const pauseAfter = Math.max(2, Math.floor(totalParts / 2));
for (let index = 0; index < pauseAfter; index += 1) {
  const uploaded = await uploadPart(index);
  add("recording_part_fresh", uploaded.response, {
    index,
    stored: uploaded.body.stored === true,
    duplicate: uploaded.body.duplicate === true,
  });
  if (
    !uploaded.response.ok ||
    uploaded.body.stored !== true ||
    uploaded.body.duplicate !== false ||
    uploaded.body.index !== index
  ) stop("Initial part upload receipt mismatch", { index, error: uploaded.body.error });
}
const duplicate = await uploadPart(0);
add("duplicate_part_is_idempotent", duplicate.response, {
  index: duplicate.body.index,
  stored: duplicate.body.stored === true,
  duplicate: duplicate.body.duplicate === true,
});
if (
  !duplicate.response.ok ||
  duplicate.body.stored !== true ||
  duplicate.body.duplicate !== true ||
  duplicate.body.index !== 0
) stop("Duplicate part was not idempotent", { error: duplicate.body.error });

const resumed = await startUpload();
const expectedResumedParts = Array.from({ length: pauseAfter }, (_, index) => index);
add("resume_readback", resumed.response, { uploadedParts: resumed.body.uploadedParts });
if (!resumed.response.ok || !verifiedUploadReadback(resumed.body, expectedResumedParts, false)) {
  stop("Resume readback mismatch", { expected: expectedResumedParts, actual: resumed.body.uploadedParts });
}
for (let index = pauseAfter; index < totalParts; index += 1) {
  const uploaded = await uploadPart(index);
  add("recording_part_fresh", uploaded.response, {
    index,
    stored: uploaded.body.stored === true,
    duplicate: uploaded.body.duplicate === true,
  });
  if (
    !uploaded.response.ok ||
    uploaded.body.stored !== true ||
    uploaded.body.duplicate !== false ||
    uploaded.body.index !== index
  ) stop("Resumed part upload receipt mismatch", { index, error: uploaded.body.error });
}

const finalizeStartedAt = Date.now();
const finalize = await fetch(`${baseUrl}/api/interviews/recording/upload/complete`, {
  method: "POST",
  headers: authorizedHeaders,
});
const finalized = await json(finalize);
add("recording_finalize", finalize, {
  elapsedMs: Date.now() - finalizeStartedAt,
  stored: finalized.stored === true,
  alreadyStored: finalized.alreadyStored === true,
  byteSize: finalized.byteSize,
  totalParts: finalized.totalParts,
});
const freshFinalizeReceipt = finalize.status === 200 &&
  finalized.stored === true &&
  finalized.alreadyStored !== true &&
  finalized.byteSize === recording.byteLength &&
  finalized.totalParts === totalParts;
const concurrentFinalizeReceipt = finalize.status === 200 &&
  finalized.stored === true &&
  finalized.alreadyStored === true;
if (!freshFinalizeReceipt && !concurrentFinalizeReceipt) {
  stop("Recording finalize receipt mismatch", { status: finalize.status, error: finalized.error });
}

// If staff recovery won the finalize race, /upload/complete intentionally has
// only an idempotent D1 receipt. Re-read the deterministic upload state and every
// part metadata entry to prove the exact recording is durable in either branch.
const expectedAllParts = Array.from({ length: totalParts }, (_, index) => index);
const finalizedReadback = await startUpload();
add("recording_finalize_readback", finalizedReadback.response, {
  stored: finalizedReadback.body.stored === true,
  byteSize: finalizedReadback.body.byteSize,
  totalParts: finalizedReadback.body.totalParts,
  uploadedParts: finalizedReadback.body.uploadedParts,
});
if (
  !finalizedReadback.response.ok ||
  !verifiedUploadReadback(finalizedReadback.body, expectedAllParts, true)
) {
  stop("Finalized recording readback did not match every uploaded part", {
    actual: finalizedReadback.body.uploadedParts,
  });
}

let completionObservedElsewhere = false;
let pendingRetryQueue = [...pendingAnswers];
// When transcription is still pending, prove that the completion endpoint is
// fail-closed only after the full recording is durable. Staff recovery can make
// progress concurrently, so a 409 must describe the exact remaining subset; a
// 200 is accepted only as the completed-session idempotency receipt.
if (pendingAnswers.length > 0) {
  const expectedMissingAnswerIndexes = pendingAnswers.map((answer) => answer.answerIndex);
  const pendingProbe = await recordedCompletionRequest();
  const pendingComplete = pendingProbe.response;
  const pendingCompletion = pendingProbe.body;
  add("recorded_fallback_pending_probe", pendingComplete, {
    stored: pendingCompletion.stored === true,
    transcriptionPending: pendingCompletion.transcriptionPending === true,
    completedAnswerCount: pendingCompletion.completedAnswerCount,
    missingAnswerIndexes: pendingCompletion.missingAnswerIndexes,
    recordingDurablyStored: true,
  });
  const actualMissingAnswerIndexes = Array.isArray(pendingCompletion.missingAnswerIndexes)
    ? pendingCompletion.missingAnswerIndexes
    : [];
  const expectedPendingSet = new Set(expectedMissingAnswerIndexes);
  const exactRemainingSubset = actualMissingAnswerIndexes.length > 0 &&
    actualMissingAnswerIndexes.every((value, index) =>
      Number.isInteger(value) &&
      expectedPendingSet.has(value) &&
      (index === 0 || actualMissingAnswerIndexes[index - 1] < value));
  const exactPendingReceipt = pendingComplete.status === 409 &&
    pendingCompletion.stored === false &&
    pendingCompletion.transcriptionPending === true &&
    pendingCompletion.completedAnswerCount === answerCount - actualMissingAnswerIndexes.length &&
    exactRemainingSubset;
  const exactCompletedReceipt = pendingComplete.status === 200 &&
    pendingCompletion.stored === true &&
    pendingCompletion.humanReviewRequired === true &&
    pendingCompletion.alreadyCompleted === true;
  if (!exactPendingReceipt && !exactCompletedReceipt) {
    stop("Recorded completion did not return the exact pending-transcription receipt", {
      status: pendingComplete.status,
      expectedMissingAnswerIndexes,
      actualMissingAnswerIndexes,
    });
  }
  if (exactCompletedReceipt) {
    completionObservedElsewhere = true;
    pendingRetryQueue = [];
  } else {
    const remaining = new Set(actualMissingAnswerIndexes);
    pendingRetryQueue = pendingAnswers.filter((answer) => remaining.has(answer.answerIndex));
  }
}

const finalizeReplay = await fetch(`${baseUrl}/api/interviews/recording/upload/complete`, {
  method: "POST",
  headers: authorizedHeaders,
});
const replayed = await json(finalizeReplay);
add("recording_finalize_idempotent", finalizeReplay, { alreadyStored: replayed.alreadyStored === true });
if (!finalizeReplay.ok || replayed.stored !== true || replayed.alreadyStored !== true) stop("Recording finalize replay failed", { error: replayed.error });

// Only after the full recording has a durable, idempotent R2 receipt do we poll
// pending transcriptions. Bodyless retries can reuse the registered answer audio
// and can never replace it with different bytes.
const transcriptionRetryDeadlineAt = Date.now() + answerRetryWallClockMs;
for (const pendingAnswer of pendingRetryQueue) {
  const retryResult = await finishPendingAnswer(pendingAnswer, transcriptionRetryDeadlineAt);
  if (retryResult.completedElsewhere) {
    completionObservedElsewhere = true;
    break;
  }
}

const completion = await recordedCompletionRequest();
const complete = completion.response;
const completed = completion.body;
add("recorded_fallback_complete", complete, { stored: completed.stored === true });
if (
  complete.status !== 200 ||
  completed.stored !== true ||
  completed.humanReviewRequired !== true ||
  (completionObservedElsewhere && completed.alreadyCompleted !== true)
) stop("Recorded fallback completion failed", { error: completed.error });

const completeReplay = await fetch(`${baseUrl}/api/interviews/recorded/complete`, {
  method: "POST",
  headers: { ...authorizedHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: session.sessionId, questionCount: answerCount }),
});
const completedReplay = await json(completeReplay);
add("recorded_fallback_complete_idempotent", completeReplay, {
  stored: completedReplay.stored === true,
  humanReviewRequired: completedReplay.humanReviewRequired === true,
  alreadyCompleted: completedReplay.alreadyCompleted === true,
});
if (
  completeReplay.status !== 200 ||
  completedReplay.stored !== true ||
  completedReplay.humanReviewRequired !== true ||
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
let archiveProgressAttempts = 0;
let archiveRequestCount = 0;
while (Date.now() - archiveStartedAt < archiveWallClockMs) {
  archiveRequestCount += 1;
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
    attempt: archiveRequestCount,
    elapsedMs: Date.now() - stepStartedAt,
    stored: step.stored === true,
    recordingIncluded: step.recordingIncluded === true,
    pending: step.pending === true,
    phase: isStored ? "completed" : (typeof step.phase === "string" ? step.phase : null),
    committedOffset,
    totalBytes,
  });

  if (!archive.ok) {
    stop("Foreground archive step failed", { attempt: archiveRequestCount, status: archive.status, error: step.error });
  }
  if (step.stored === true) {
    if (step.recordingIncluded !== true) {
      stop("Foreground archive completed without the recording", { attempt: archiveRequestCount });
    }
    archived = step;
    break;
  }
  if (step.pending !== true || typeof step.phase !== "string") {
    stop("Foreground archive returned neither a stored receipt nor a pending step", { attempt: archiveRequestCount });
  }
  if (
    !Number.isInteger(committedOffset) ||
    committedOffset < previousCommittedOffset ||
    committedOffset > recording.byteLength
  ) {
    stop("Foreground archive committed offset was invalid or regressed", {
      attempt: archiveRequestCount,
      previousCommittedOffset,
      committedOffset,
    });
  }
  if (totalBytes !== 0 && totalBytes !== recording.byteLength) {
    stop("Foreground archive total byte count did not match the uploaded recording", {
      attempt: archiveRequestCount,
      expected: recording.byteLength,
      actual: totalBytes,
    });
  }
  const waitOnlyPhase = ["busy", "initializing", "retrying"].includes(step.phase);
  if (!waitOnlyPhase) archiveProgressAttempts += 1;
  previousCommittedOffset = committedOffset;
  if (archiveProgressAttempts >= maxArchiveAttempts) {
    stop("Foreground archive did not finish within the finite step budget", {
      attempts: archiveProgressAttempts,
      requests: archiveRequestCount,
      committedOffset,
    });
  }
  const retryAfterMs = Number(step.retryAfterMs ?? 250);
  await wait(Number.isFinite(retryAfterMs) ? Math.min(5_000, Math.max(0, retryAfterMs)) : 250);
}
if (!archived && Date.now() - archiveStartedAt >= archiveWallClockMs) {
  stop("Foreground archive did not finish within the wall-clock deadline", {
    requests: archiveRequestCount,
    committedOffset: previousCommittedOffset,
  });
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
  recordingDurationSeconds,
  recordingAudioCoverage,
  totalParts,
  recordingPartSha256s,
  answerCount,
  answerAudioBytes: answerAudio.byteLength,
  answerAudioSha256,
  answerContentType,
  answerAudioDurationSeconds,
  archiveElapsedMs,
  elapsedMs: Date.now() - startedAt,
  results,
  driveReadbackRequired: true,
}, null, 2)}\n`);
