import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const baseUrl = (process.env.INTERVIEW_E2E_BASE_URL ?? "").replace(/\/$/, "");
const recordingPath = process.env.INTERVIEW_E2E_RECORDING_PATH ?? "";
const partSize = 4 * 1024 * 1024;
const minimumRecordingFixtureBytes = 70_000_000;
const minimumRecordingFixtureDurationSeconds = 60;
// A media container cannot prove whether its single mixed audio track contains
// both the candidate and the remote interviewer. Keep this receipt honest; the
// browser MediaRecorder path has separate coverage logic for live interviews.
const recordingAudioCoverage = "unverified";
const maxEvaluationWaitAttempts = 60;
const archiveWallClockMs = 15 * 60 * 1_000;

if (!/^https:\/\//.test(baseUrl)) {
  throw new Error("INTERVIEW_E2E_BASE_URL must be an https URL");
}
if (!recordingPath) throw new Error("INTERVIEW_E2E_RECORDING_PATH is required");

const startedAt = Date.now();
const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const candidateName = `社内音声経路大容量格納試験 ${runId}`;
const employment = "正社員";
const location = "社内試験店舗（実応募ではありません）";
const origin = new URL(baseUrl).origin;
const recording = await readFile(recordingPath);
const recordingSha256 = createHash("sha256").update(recording).digest("hex");
const recordingMd5 = createHash("md5").update(recording).digest("hex");
const totalParts = Math.ceil(recording.byteLength / partSize);
const recordingPartSha256s = Array.from({ length: totalParts }, (_, index) => {
  const start = index * partSize;
  return createHash("sha256")
    .update(recording.subarray(start, Math.min(recording.byteLength, start + partSize)))
    .digest("hex");
});
const results = [];
let sessionId = null;

if (recording.byteLength < minimumRecordingFixtureBytes) {
  throw new Error(`The recording fixture must be at least ${minimumRecordingFixtureBytes} bytes`);
}
if (totalParts < 10) throw new Error("The recording fixture must contain at least 10 upload parts");
const mediaProbe = spawnSync(
  process.env.INTERVIEW_E2E_FFPROBE_PATH ?? "ffprobe",
  ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name", "-of", "json", recordingPath],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
);
if (mediaProbe.status !== 0) throw new Error("The recording fixture is not readable by ffprobe");
const mediaInfo = JSON.parse(mediaProbe.stdout || "{}");
const mediaDurationSeconds = Number(mediaInfo?.format?.duration);
const mediaFormatNames = String(mediaInfo?.format?.format_name ?? "").split(",");
const mediaStreams = Array.isArray(mediaInfo?.streams) ? mediaInfo.streams : [];
const hasDecodableVideo = mediaStreams.some((stream) =>
  stream?.codec_type === "video" && ["vp8", "vp9", "av1"].includes(stream?.codec_name)
);
const hasDecodableAudio = mediaStreams.some((stream) =>
  stream?.codec_type === "audio" && ["opus", "vorbis"].includes(stream?.codec_name)
);
if (
  !Number.isFinite(mediaDurationSeconds) ||
  mediaDurationSeconds < minimumRecordingFixtureDurationSeconds ||
  !mediaFormatNames.includes("webm") ||
  !hasDecodableVideo ||
  !hasDecodableAudio
) {
  throw new Error("The recording fixture must be a 60-second-or-longer decodable WebM with VP8/VP9/AV1 video and Opus/Vorbis audio");
}

function syntheticTurn(id, speaker, text, secondsAfterStart) {
  return {
    id,
    speaker,
    text,
    createdAt: new Date(startedAt + secondsAfterStart * 1_000).toISOString(),
  };
}

// This is an explicit, non-applicant transcript from the realtime voice path.
// It intentionally bypasses recorded-answer STT so the durable voice seal and
// large recording archive can still be proved while upstream STT is rate-limited.
const transcript = [
  syntheticTurn(
    "synthetic-voice-q1",
    "interviewer",
    "これは社内試験です。応募理由と、仕事で大切にしていることを教えてください。",
    0,
  ),
  syntheticTurn(
    "synthetic-voice-a1",
    "candidate",
    "社内試験用の合成回答です。犬と飼い主様の安全を優先し、確認事項を記録してチームへ共有することを大切にします。",
    8,
  ),
  syntheticTurn(
    "synthetic-voice-q2",
    "interviewer",
    "忙しい時間帯に複数の依頼が重なった場合、どのように対応しますか。",
    16,
  ),
  syntheticTurn(
    "synthetic-voice-a2",
    "candidate",
    "社内試験用の合成回答です。安全、期限、お客様への影響で優先順位を決め、現在地と応援が必要な内容を短く共有します。",
    24,
  ),
];
const candidateTurnCount = transcript.filter((turn) => turn.speaker === "candidate").length;

function add(step, response, detail = {}) {
  results.push({ step, status: response.status, ok: response.ok, ...detail });
}

async function safeJson(response) {
  return await response.json().catch(() => ({}));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function stop(code, detail = {}) {
  process.stdout.write(`${JSON.stringify({
    testData: "synthetic-large-voice-archive",
    sessionId,
    results,
    failure: { code, ...detail },
  }, null, 2)}\n`);
  throw new Error(code);
}

// The same server-side WebRTC call route used by the browser must succeed
// before this test may seal a synthetic transcript. This offer establishes the
// authenticated OpenAI Realtime boundary without printing the SDP answer or a
// candidate token.
const syntheticOffer = [
  "v=0",
  "o=- 1785629300 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1",
  "a=msid-semantic: WMS synthetic",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=sendrecv",
  "a=rtcp-mux",
  "a=ice-ufrag:syntheticProbe",
  "a=ice-pwd:syntheticProbePassword123456",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00",
  "a=setup:actpass",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=ssrc:1001 cname:synthetic",
  "a=msid:synthetic audio",
  "a=ssrc:1001 msid:synthetic audio",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=mid:1",
  "a=sctp-port:5000",
  "a=ice-ufrag:syntheticProbe",
  "a=ice-pwd:syntheticProbePassword123456",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00",
  "a=setup:actpass",
  "",
].join("\r\n");

const commonHeaders = { Origin: origin };
const sessionResponse = await fetch(`${baseUrl}/api/interviews/session`, {
  method: "POST",
  headers: { ...commonHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({
    candidateName,
    employment,
    location,
    consent: true,
    interviewMode: "camera",
  }),
});
const session = await safeJson(sessionResponse);
sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
add("candidate_session", sessionResponse, { sessionId });
if (!sessionResponse.ok || !sessionId || typeof session.accessToken !== "string") {
  stop("CANDIDATE_SESSION_FAILED", { responseStatus: sessionResponse.status });
}

const authorizedHeaders = {
  ...commonHeaders,
  Authorization: `Bearer ${session.accessToken}`,
  "X-Interview-Session": sessionId,
};

const realtimeCallResponse = await fetch(`${baseUrl}/api/realtime/call`, {
  method: "POST",
  headers: { ...authorizedHeaders, "Content-Type": "application/sdp" },
  body: syntheticOffer,
});
const realtimeAnswer = await realtimeCallResponse.text();
add("realtime_webrtc_call", realtimeCallResponse, {
  sdpAnswerReceived: realtimeCallResponse.ok && realtimeAnswer.startsWith("v=0"),
  answerBytes: realtimeAnswer.length,
});
if (
  realtimeCallResponse.status !== 200 ||
  !realtimeAnswer.startsWith("v=0")
) {
  stop("REALTIME_WEBRTC_CALL_FAILED", { responseStatus: realtimeCallResponse.status });
}

async function sealVoiceTranscript() {
  const response = await fetch(`${baseUrl}/api/interviews/voice/transcript/seal`, {
    method: "POST",
    headers: { ...authorizedHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, transcript, transcriptionComplete: true }),
  });
  return { response, body: await safeJson(response) };
}

const firstSeal = await sealVoiceTranscript();
add("voice_transcript_seal", firstSeal.response, {
  sealed: firstSeal.body.sealed === true,
  alreadySealed: firstSeal.body.alreadySealed === true,
  turnCount: firstSeal.body.turnCount,
});
if (
  firstSeal.response.status !== 200 ||
  firstSeal.body.sealed !== true ||
  firstSeal.body.alreadySealed === true ||
  firstSeal.body.turnCount !== transcript.length
) {
  stop("VOICE_TRANSCRIPT_SEAL_FAILED", { responseStatus: firstSeal.response.status });
}

const replaySeal = await sealVoiceTranscript();
add("voice_transcript_seal_idempotent", replaySeal.response, {
  sealed: replaySeal.body.sealed === true,
  alreadySealed: replaySeal.body.alreadySealed === true,
  turnCount: replaySeal.body.turnCount,
});
if (
  replaySeal.response.status !== 200 ||
  replaySeal.body.sealed !== true ||
  replaySeal.body.alreadySealed !== true ||
  replaySeal.body.turnCount !== transcript.length
) {
  stop("VOICE_TRANSCRIPT_SEAL_REPLAY_FAILED", { responseStatus: replaySeal.response.status });
}

async function startUpload() {
  const response = await fetch(`${baseUrl}/api/interviews/recording/upload/start`, {
    method: "POST",
    headers: { ...authorizedHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      contentType: "video/webm",
      byteSize: recording.byteLength,
      partSize,
      totalParts,
      audioCoverage: recordingAudioCoverage,
      uploadVersion: 2,
    }),
  });
  return { response, body: await safeJson(response) };
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
  return { response, body: await safeJson(response), expectedBytes: part.byteLength };
}

const initial = await startUpload();
add("resumable_start", initial.response, {
  totalParts,
  recordingBytes: recording.byteLength,
  stored: initial.body.stored === true,
  uploadedParts: initial.body.uploadedParts,
});
if (!initial.response.ok || !verifiedUploadReadback(initial.body, [], false)) {
  stop("RESUMABLE_START_RECEIPT_MISMATCH", { responseStatus: initial.response.status });
}

const pauseAfter = Math.max(2, Math.floor(totalParts / 2));
for (let index = 0; index < pauseAfter; index += 1) {
  const uploaded = await uploadPart(index);
  add("recording_part_fresh", uploaded.response, {
    index,
    expectedBytes: uploaded.expectedBytes,
    stored: uploaded.body.stored === true,
    duplicate: uploaded.body.duplicate === true,
  });
  if (
    !uploaded.response.ok ||
    uploaded.body.stored !== true ||
    uploaded.body.duplicate !== false ||
    uploaded.body.index !== index
  ) {
    stop("RECORDING_PART_RECEIPT_MISMATCH", { index, responseStatus: uploaded.response.status });
  }
}

const duplicatePart = await uploadPart(0);
add("recording_part_idempotent", duplicatePart.response, {
  index: duplicatePart.body.index,
  stored: duplicatePart.body.stored === true,
  duplicate: duplicatePart.body.duplicate === true,
});
if (
  !duplicatePart.response.ok ||
  duplicatePart.body.stored !== true ||
  duplicatePart.body.duplicate !== true ||
  duplicatePart.body.index !== 0
) {
  stop("RECORDING_PART_REPLAY_FAILED", { responseStatus: duplicatePart.response.status });
}

const resumed = await startUpload();
const expectedResumedParts = Array.from({ length: pauseAfter }, (_, index) => index);
add("resumable_resume_readback", resumed.response, {
  stored: resumed.body.stored === true,
  uploadedParts: resumed.body.uploadedParts,
});
if (!resumed.response.ok || !verifiedUploadReadback(resumed.body, expectedResumedParts, false)) {
  stop("RESUMABLE_READBACK_MISMATCH", { responseStatus: resumed.response.status });
}

for (let index = pauseAfter; index < totalParts; index += 1) {
  const uploaded = await uploadPart(index);
  add("recording_part_fresh", uploaded.response, {
    index,
    expectedBytes: uploaded.expectedBytes,
    stored: uploaded.body.stored === true,
    duplicate: uploaded.body.duplicate === true,
  });
  if (
    !uploaded.response.ok ||
    uploaded.body.stored !== true ||
    uploaded.body.duplicate !== false ||
    uploaded.body.index !== index
  ) {
    stop("RECORDING_PART_RECEIPT_MISMATCH", { index, responseStatus: uploaded.response.status });
  }
}

async function finalizeUpload() {
  const response = await fetch(`${baseUrl}/api/interviews/recording/upload/complete`, {
    method: "POST",
    headers: authorizedHeaders,
  });
  return { response, body: await safeJson(response) };
}

const finalizeStartedAt = Date.now();
const finalize = await finalizeUpload();
add("recording_finalize", finalize.response, {
  elapsedMs: Date.now() - finalizeStartedAt,
  stored: finalize.body.stored === true,
  alreadyStored: finalize.body.alreadyStored === true,
  byteSize: finalize.body.byteSize,
  totalParts: finalize.body.totalParts,
});
const freshFinalizeReceipt = finalize.response.status === 200 &&
  finalize.body.stored === true &&
  finalize.body.alreadyStored !== true &&
  finalize.body.byteSize === recording.byteLength &&
  finalize.body.totalParts === totalParts;
const concurrentFinalizeReceipt = finalize.response.status === 200 &&
  finalize.body.stored === true &&
  finalize.body.alreadyStored === true;
if (!freshFinalizeReceipt && !concurrentFinalizeReceipt) {
  stop("RECORDING_FINALIZE_RECEIPT_MISMATCH", { responseStatus: finalize.response.status });
}

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
  stop("RECORDING_FINAL_READBACK_MISMATCH", { responseStatus: finalizedReadback.response.status });
}

const finalizeReplay = await finalizeUpload();
add("recording_finalize_idempotent", finalizeReplay.response, {
  stored: finalizeReplay.body.stored === true,
  alreadyStored: finalizeReplay.body.alreadyStored === true,
});
if (
  finalizeReplay.response.status !== 200 ||
  finalizeReplay.body.stored !== true ||
  finalizeReplay.body.alreadyStored !== true
) {
  stop("RECORDING_FINALIZE_REPLAY_FAILED", { responseStatus: finalizeReplay.response.status });
}

async function requestEvaluation() {
  const response = await fetch(`${baseUrl}/api/evaluate`, {
    method: "POST",
    headers: { ...authorizedHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, employment, location, transcript }),
  });
  return { response, body: await safeJson(response) };
}

let evaluationReceipt = null;
for (let attempt = 1; attempt <= maxEvaluationWaitAttempts; attempt += 1) {
  const evaluated = await requestEvaluation();
  add("evaluation", evaluated.response, {
    attempt,
    stored: evaluated.body.stored === true,
    humanReviewRequired: evaluated.body.humanReviewRequired === true,
    automaticEvaluationDeferred: evaluated.body.automaticEvaluationDeferred === true,
    alreadyStored: evaluated.body.alreadyStored === true,
  });
  const freshEvaluationReceipt = evaluated.response.status === 200 &&
    evaluated.body.stored === true &&
    evaluated.body.humanReviewRequired === true &&
    // Voice-path production proof requires the automatic evaluator itself to
    // have completed. A service-unavailable fallback is safe for candidates but
    // is not a passing release gate for this formal E2E.
    evaluated.body.automaticEvaluationDeferred === false;
  if (freshEvaluationReceipt) {
    evaluationReceipt = evaluated.body;
    break;
  }
  if (evaluated.response.status === 200 && evaluated.body.alreadyStored === true) {
    // A replay receipt does not expose durable automatic-vs-fallback
    // provenance. Treat it as unprovable, never as a green formal E2E.
    stop("EVALUATION_PROVENANCE_UNPROVABLE", { attempt });
  }
  if (evaluated.response.status !== 409 || attempt === maxEvaluationWaitAttempts) {
    stop("EVALUATION_FAILED", { attempt, responseStatus: evaluated.response.status });
  }
  await wait(1_000);
}
if (!evaluationReceipt) stop("EVALUATION_RECEIPT_MISSING");

const evaluationReplay = await requestEvaluation();
add("evaluation_idempotent", evaluationReplay.response, {
  stored: evaluationReplay.body.stored === true,
  alreadyStored: evaluationReplay.body.alreadyStored === true,
});
if (
  evaluationReplay.response.status !== 200 ||
  evaluationReplay.body.stored !== true ||
  evaluationReplay.body.alreadyStored !== true
) {
  stop("EVALUATION_REPLAY_FAILED", { responseStatus: evaluationReplay.response.status });
}

async function archiveStep() {
  const response = await fetch(`${baseUrl}/api/interviews/archive`, {
    method: "POST",
    headers: { ...authorizedHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  return { response, body: await safeJson(response) };
}

const archiveStartedAt = Date.now();
const maxArchiveAttempts = totalParts + 24;
let archived = null;
let previousCommittedOffset = 0;
let archiveProgressAttempts = 0;
let archiveRequestCount = 0;
while (Date.now() - archiveStartedAt < archiveWallClockMs) {
  archiveRequestCount += 1;
  const stepStartedAt = Date.now();
  const archive = await archiveStep();
  const step = archive.body;
  const stored = step.stored === true;
  const committedOffset = stored ? recording.byteLength : Number(step.committedOffset ?? 0);
  const totalBytes = stored ? recording.byteLength : Number(step.totalBytes ?? 0);
  add("foreground_drive_archive_step", archive.response, {
    attempt: archiveRequestCount,
    elapsedMs: Date.now() - stepStartedAt,
    stored,
    recordingIncluded: step.recordingIncluded === true,
    transcriptAvailable: step.transcriptAvailable === true,
    transcriptKind: typeof step.transcriptKind === "string" ? step.transcriptKind : null,
    pending: step.pending === true,
    phase: stored ? "completed" : (typeof step.phase === "string" ? step.phase : null),
    committedOffset,
    totalBytes,
  });
  if (!archive.response.ok) {
    stop("DRIVE_ARCHIVE_STEP_FAILED", { attempt: archiveRequestCount, responseStatus: archive.response.status });
  }
  if (stored) {
    archived = step;
    break;
  }
  if (step.pending !== true || typeof step.phase !== "string") {
    stop("DRIVE_ARCHIVE_STEP_RECEIPT_MISSING", { attempt: archiveRequestCount });
  }
  if (
    !Number.isInteger(committedOffset) ||
    committedOffset < previousCommittedOffset ||
    committedOffset > recording.byteLength
  ) {
    stop("DRIVE_ARCHIVE_OFFSET_INVALID", { attempt: archiveRequestCount, previousCommittedOffset, committedOffset });
  }
  if (totalBytes !== 0 && totalBytes !== recording.byteLength) {
    stop("DRIVE_ARCHIVE_TOTAL_BYTES_MISMATCH", {
      attempt: archiveRequestCount,
      expectedBytes: recording.byteLength,
      actualBytes: totalBytes,
    });
  }
  const waitOnlyPhase = ["busy", "initializing", "retrying"].includes(step.phase);
  if (!waitOnlyPhase) archiveProgressAttempts += 1;
  previousCommittedOffset = committedOffset;
  if (archiveProgressAttempts >= maxArchiveAttempts) {
    stop("DRIVE_ARCHIVE_STEP_BUDGET_EXHAUSTED", {
      attempts: archiveProgressAttempts,
      requests: archiveRequestCount,
      committedOffset,
    });
  }
  const retryAfterMs = Number(step.retryAfterMs ?? 250);
  await wait(Number.isFinite(retryAfterMs) ? Math.min(5_000, Math.max(0, retryAfterMs)) : 250);
}
if (!archived && Date.now() - archiveStartedAt >= archiveWallClockMs) {
  stop("DRIVE_ARCHIVE_WALL_CLOCK_EXHAUSTED", { requests: archiveRequestCount, committedOffset: previousCommittedOffset });
}

if (
  !archived ||
  archived.stored !== true ||
  archived.recordingIncluded !== true ||
  archived.transcriptAvailable !== true ||
  archived.transcriptKind !== "actual_transcript"
) {
  stop("DRIVE_ARCHIVE_FINAL_RECEIPT_MISMATCH");
}

const archiveReplay = await archiveStep();
add("foreground_drive_archive_idempotent", archiveReplay.response, {
  stored: archiveReplay.body.stored === true,
  recordingIncluded: archiveReplay.body.recordingIncluded === true,
  transcriptAvailable: archiveReplay.body.transcriptAvailable === true,
  transcriptKind: typeof archiveReplay.body.transcriptKind === "string"
    ? archiveReplay.body.transcriptKind
    : null,
});
if (
  archiveReplay.response.status !== 200 ||
  archiveReplay.body.stored !== true ||
  archiveReplay.body.recordingIncluded !== true ||
  archiveReplay.body.transcriptAvailable !== true ||
  archiveReplay.body.transcriptKind !== "actual_transcript"
) {
  stop("DRIVE_ARCHIVE_REPLAY_FAILED", { responseStatus: archiveReplay.response.status });
}

process.stdout.write(`${JSON.stringify({
  testData: "synthetic-large-voice-archive",
  sessionId,
  recordingBytes: recording.byteLength,
  recordingSha256,
  recordingMd5,
  mediaDurationSeconds,
  recordingAudioCoverage,
  partSize,
  totalParts,
  transcriptTurnCount: transcript.length,
  candidateTurnCount,
  evaluationHumanReviewRequired: evaluationReceipt.humanReviewRequired === true,
  automaticEvaluationDeferred: evaluationReceipt.automaticEvaluationDeferred === true,
  driveArchiveReceipt: {
    stored: archived.stored === true,
    recordingIncluded: archived.recordingIncluded === true,
    transcriptAvailable: archived.transcriptAvailable === true,
    transcriptKind: archived.transcriptKind,
  },
  archiveElapsedMs: Date.now() - archiveStartedAt,
  elapsedMs: Date.now() - startedAt,
  results,
  driveReadbackRequired: true,
}, null, 2)}\n`);
