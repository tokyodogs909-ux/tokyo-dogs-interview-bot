import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const source = await readFile(
  new URL("../scripts/production-voice-recording-archive-e2e.mjs", import.meta.url),
  "utf8",
);

function orderedPositions(haystack, statements) {
  const positions = statements.map((statement) => {
    const position = haystack.indexOf(statement);
    assert.notEqual(position, -1, `missing voice E2E statement: ${statement}`);
    return position;
  });
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
}

test("production voice E2E seals an actual transcript before the resumable recording and Drive archive", () => {
  assert.match(source, /minimumRecordingFixtureBytes = 70_000_000/);
  assert.match(source, /recording\.byteLength < minimumRecordingFixtureBytes/);
  assert.match(source, /minimumRecordingFixtureDurationSeconds = 60/);
  assert.match(source, /mediaDurationSeconds < minimumRecordingFixtureDurationSeconds/);
  assert.match(source, /spawnSync\(/);
  assert.match(source, /"ffprobe"/);
  assert.match(source, /const hasDecodableVideo/);
  assert.match(source, /const hasDecodableAudio/);
  assert.match(source, /mediaFormatNames\.includes\("webm"\)/);
  assert.match(source, /createHash\("sha256"\)\.update\(recording\)/);
  assert.match(source, /createHash\("md5"\)\.update\(recording\)/);
  assert.match(source, /const partSize = 4 \* 1024 \* 1024/);
  assert.match(source, /const recordingPartSha256s = Array\.from/);
  assert.match(source, /uploadVersion: 2/);
  assert.match(source, /const recordingAudioCoverage = "unverified"/);
  assert.match(source, /audioCoverage: recordingAudioCoverage/);
  assert.match(source, /"X-Recording-Part-Sha256": recordingPartSha256s\[index\]/);

  assert.match(source, /"synthetic-voice-q1",\s*"interviewer"/);
  assert.match(source, /"synthetic-voice-a1",\s*"candidate"/);
  assert.match(source, /社内試験用の合成回答です/);
  assert.match(source, /\/api\/realtime\/call/);
  assert.match(source, /"Content-Type": "application\/sdp"/);
  assert.doesNotMatch(source, /\/api\/interviews\/voice\/start/);
  assert.match(source, /\/api\/interviews\/voice\/transcript\/seal/);
  assert.match(source, /body: JSON\.stringify\(\{ sessionId, transcript, transcriptionComplete: true \}\)/);
  assert.doesNotMatch(source, /\/api\/interviews\/recorded\//);
  assert.doesNotMatch(source, /INTERVIEW_E2E_ANSWER_AUDIO_PATH/);

  const mainFlow = source.slice(source.indexOf("const sessionResponse = await fetch"));
  orderedPositions(mainFlow, [
    "const sessionResponse = await fetch",
    "const realtimeCallResponse = await fetch",
    "const firstSeal = await sealVoiceTranscript()",
    "const replaySeal = await sealVoiceTranscript()",
    "const initial = await startUpload()",
    "const duplicatePart = await uploadPart(0)",
    "const resumed = await startUpload()",
    "const finalize = await finalizeUpload()",
    "const finalizedReadback = await startUpload()",
    "const finalizeReplay = await finalizeUpload()",
    "let evaluationReceipt = null",
    "const evaluationReplay = await requestEvaluation()",
    "const archiveStartedAt = Date.now()",
    "const archiveReplay = await archiveStep()",
  ]);

  const firstUploadLoop = source.slice(
    source.indexOf("for (let index = 0; index < pauseAfter"),
    source.indexOf("const duplicatePart = await uploadPart(0)"),
  );
  assert.match(firstUploadLoop, /const uploaded = await uploadPart\(index\)/);
  assert.match(firstUploadLoop, /uploaded\.body\.stored !== true/);
  assert.match(firstUploadLoop, /uploaded\.body\.duplicate !== false/);
  assert.match(firstUploadLoop, /uploaded\.body\.index !== index/);

  const resumedUploadLoop = source.slice(
    source.indexOf("for (let index = pauseAfter; index < totalParts"),
    source.indexOf("async function finalizeUpload"),
  );
  assert.match(resumedUploadLoop, /const uploaded = await uploadPart\(index\)/);
  assert.match(source, /verifiedUploadReadback\(resumed\.body, expectedResumedParts, false\)/);
  assert.match(source, /verifiedUploadReadback\(finalizedReadback\.body, expectedAllParts, true\)/);
});

test("production voice E2E accepts explicit human review fallback and requires exact idempotent receipts", () => {
  assert.match(source, /firstSeal\.body\.alreadySealed === true/);
  assert.match(source, /replaySeal\.body\.alreadySealed !== true/);
  assert.match(source, /duplicatePart\.body\.duplicate !== true/);
  assert.match(source, /finalizeReplay\.body\.alreadyStored !== true/);

  assert.match(source, /evaluated\.body\.humanReviewRequired === true/);
  assert.match(source, /evaluated\.body\.automaticEvaluationDeferred === true/);
  assert.match(source, /evaluated\.body\.alreadyStored === true/);
  assert.match(source, /evaluated\.response\.status !== 409/);
  assert.match(source, /maxEvaluationWaitAttempts = 60/);
  assert.match(source, /evaluationReplay\.body\.alreadyStored !== true/);

  assert.match(source, /archived\.recordingIncluded !== true/);
  assert.match(source, /archived\.transcriptAvailable !== true/);
  assert.match(source, /archived\.transcriptKind !== "actual_transcript"/);
  assert.match(source, /archiveReplay\.body\.recordingIncluded !== true/);
  assert.match(source, /archiveReplay\.body\.transcriptAvailable !== true/);
  assert.match(source, /archiveReplay\.body\.transcriptKind !== "actual_transcript"/);
  assert.match(source, /committedOffset < previousCommittedOffset/);
  assert.match(source, /totalBytes !== 0 && totalBytes !== recording\.byteLength/);
});

test("production voice E2E emits only readback keys and recording digests, never credentials or transcript text", () => {
  const failureOutput = source.slice(
    source.indexOf("function stop"),
    source.indexOf("// The same server-side WebRTC call route"),
  );
  assert.match(failureOutput, /sessionId/);
  assert.doesNotMatch(failureOutput, /accessToken/);
  assert.doesNotMatch(failureOutput, /candidateName/);
  assert.doesNotMatch(failureOutput, /\btranscript\b/);

  const successOutput = source.slice(source.lastIndexOf("process.stdout.write"));
  assert.match(successOutput, /sessionId/);
  assert.match(successOutput, /recordingSha256/);
  assert.match(successOutput, /recordingMd5/);
  assert.match(successOutput, /recordingBytes/);
  assert.match(successOutput, /mediaDurationSeconds/);
  assert.match(successOutput, /recordingAudioCoverage/);
  assert.match(successOutput, /driveReadbackRequired: true/);
  assert.doesNotMatch(successOutput, /accessToken/);
  assert.doesNotMatch(successOutput, /candidateName/);
  assert.doesNotMatch(successOutput, /\btranscript\s*[,}]/);
});

test("production voice E2E dynamically completes the 70 MB fail-closed sequence against exact mock receipts", { timeout: 120_000 }, async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "td-voice-e2e-"));
  try {
    const fixturePath = join(temporaryDirectory, "synthetic-large.webm");
    // Encode 60 real seconds of changing VP8 frames and Opus audio. Do not pad
    // a one-second clip with a sparse attachment: that would exercise bytes but
    // falsely advertise a long, playable recording fixture.
    const generated = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "60",
      "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8",
      "-b:v", "15M", "-minrate", "15M", "-maxrate", "15M", "-bufsize", "30M",
      "-c:a", "libopus", "-b:a", "96k",
      "-f", "webm", fixturePath,
    ], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);

    const preloadPath = join(temporaryDirectory, "mock-fetch.mjs");
    await writeFile(preloadPath, String.raw`
import { createHash } from "node:crypto";

const state = {
  sealCalls: 0,
  started: false,
  uploadShape: null,
  uploadedParts: new Set(),
  partDigests: new Map(),
  recordingStored: false,
  finalizeCalls: 0,
  evaluationCalls: 0,
  archiveCalls: 0,
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body, status = 200, contentType = "text/plain") {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

function requestBody(init) {
  return typeof init.body === "string" ? JSON.parse(init.body) : {};
}

globalThis.fetch = async (input, init = {}) => {
  const path = new URL(String(input)).pathname;
  const headers = new Headers(init.headers);

  if (path === "/api/interviews/session") {
    const body = requestBody(init);
    if (body.interviewMode !== "camera" || body.consent !== true || !String(body.candidateName).startsWith("社内音声経路大容量格納試験")) {
      return response({ ok: false }, 400);
    }
    return response({ sessionId: "TD-VOICE-E2E-123456", accessToken: "super-secret-token-should-not-leak" });
  }

  if (path === "/api/realtime/call") {
    if (
      init.method !== "POST" ||
      !headers.get("Content-Type")?.startsWith("application/sdp") ||
      !String(init.body).startsWith("v=0")
    ) return textResponse("invalid", 400);
    state.started = true;
    return textResponse("v=0\r\ns=mock-realtime-answer\r\n", 200, "application/sdp");
  }

  if (path === "/api/interviews/voice/transcript/seal") {
    if (!state.started) return response({ sealed: false }, 409);
    const body = requestBody(init);
    const roles = Array.isArray(body.transcript) ? body.transcript.map((turn) => turn.speaker) : [];
    if (body.transcriptionComplete !== true || !roles.includes("interviewer") || !roles.includes("candidate")) {
      return response({ sealed: false }, 400);
    }
    state.sealCalls += 1;
    return response({
      sealed: true,
      alreadySealed: state.sealCalls > 1,
      turnCount: body.transcript.length,
    });
  }

  if (path === "/api/interviews/recording/upload/start") {
    if (state.sealCalls !== 2) return response({ stored: false }, 409);
    const body = requestBody(init);
    if (!state.uploadShape) state.uploadShape = body;
    if (
      body.byteSize !== state.uploadShape.byteSize ||
      body.partSize !== state.uploadShape.partSize ||
      body.totalParts !== state.uploadShape.totalParts ||
      body.contentType !== "video/webm" ||
      body.audioCoverage !== "unverified" ||
      body.uploadVersion !== 2
    ) return response({ stored: false }, 409);
    return response({
      stored: state.recordingStored,
      uploadVersion: 2,
      uploadedParts: [...state.uploadedParts].sort((left, right) => left - right),
      uploadedPartReceipts: [...state.uploadedParts]
        .sort((left, right) => left - right)
        .map((index) => ({ index, sha256: state.partDigests.get(index) })),
      contentType: "video/webm",
      byteSize: body.byteSize,
      partSize: body.partSize,
      totalParts: body.totalParts,
      audioCoverage: "unverified",
    });
  }

  if (path === "/api/interviews/recording/upload/part") {
    if (!state.uploadShape) return response({ stored: false }, 409);
    const index = Number(headers.get("X-Recording-Part-Index"));
    const declaredBytes = Number(headers.get("X-Recording-Part-Bytes"));
    const bytes = Buffer.from(init.body);
    const expectedBytes = Math.min(
      state.uploadShape.partSize,
      state.uploadShape.byteSize - index * state.uploadShape.partSize,
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (
      !Number.isInteger(index) ||
      declaredBytes !== expectedBytes ||
      bytes.byteLength !== expectedBytes ||
      headers.get("X-Recording-Part-Sha256") !== digest
    ) return response({ stored: false }, 400);
    const duplicate = state.uploadedParts.has(index);
    state.uploadedParts.add(index);
    state.partDigests.set(index, digest);
    return response({ stored: true, duplicate, index });
  }

  if (path === "/api/interviews/recording/upload/complete") {
    if (!state.uploadShape || state.uploadedParts.size !== state.uploadShape.totalParts) {
      return response({ stored: false }, 409);
    }
    state.finalizeCalls += 1;
    if (state.recordingStored) return response({ stored: true, alreadyStored: true });
    state.recordingStored = true;
    return response({
      stored: true,
      byteSize: state.uploadShape.byteSize,
      totalParts: state.uploadShape.totalParts,
    });
  }

  if (path === "/api/evaluate") {
    if (!state.recordingStored) return response({ stored: false }, 409);
    const body = requestBody(init);
    if (!Array.isArray(body.transcript) || !body.transcript.some((turn) => turn.speaker === "candidate")) {
      return response({ stored: false }, 400);
    }
    state.evaluationCalls += 1;
    if (state.evaluationCalls === 1) {
      return response({ stored: true, humanReviewRequired: true, automaticEvaluationDeferred: true });
    }
    return response({ stored: true, alreadyStored: true });
  }

  if (path === "/api/interviews/archive") {
    if (state.evaluationCalls < 2) return response({ stored: false }, 409);
    state.archiveCalls += 1;
    if (state.archiveCalls === 1) {
      return response({
        stored: false,
        recordingIncluded: true,
        pending: true,
        phase: "initializing",
        committedOffset: 0,
        totalBytes: 0,
        retryAfterMs: 0,
      });
    }
    if (state.archiveCalls === 2) {
      return response({
        stored: false,
        recordingIncluded: true,
        pending: true,
        phase: "uploading",
        committedOffset: state.uploadShape.partSize,
        totalBytes: state.uploadShape.byteSize,
        retryAfterMs: 0,
      });
    }
    return response({
      stored: true,
      recordingIncluded: true,
      transcriptAvailable: true,
      transcriptKind: "actual_transcript",
    });
  }

  return response({ ok: false }, 404);
};
`, "utf8");

    const scriptPath = fileURLToPath(
      new URL("../scripts/production-voice-recording-archive-e2e.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [
      "--import",
      pathToFileURL(preloadPath).href,
      scriptPath,
    ], {
      env: {
        ...process.env,
        INTERVIEW_E2E_BASE_URL: "https://production.example.test",
        INTERVIEW_E2E_RECORDING_PATH: fixturePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 0, stderr || stdout);

    const receipt = JSON.parse(stdout);
    assert.equal(receipt.testData, "synthetic-large-voice-archive");
    assert.equal(receipt.sessionId, "TD-VOICE-E2E-123456");
    assert.ok(receipt.recordingBytes >= 70_000_000);
    assert.ok(receipt.mediaDurationSeconds >= 60);
    assert.equal(receipt.recordingAudioCoverage, "unverified");
    assert.equal(receipt.totalParts, Math.ceil(receipt.recordingBytes / (4 * 1024 * 1024)));
    assert.match(receipt.recordingSha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.recordingMd5, /^[a-f0-9]{32}$/);
    assert.equal(receipt.transcriptTurnCount, 4);
    assert.equal(receipt.candidateTurnCount, 2);
    assert.equal(receipt.automaticEvaluationDeferred, true);
    assert.deepEqual(receipt.driveArchiveReceipt, {
      stored: true,
      recordingIncluded: true,
      transcriptAvailable: true,
      transcriptKind: "actual_transcript",
    });
    assert.equal(receipt.driveReadbackRequired, true);
    assert.doesNotMatch(stdout, /super-secret-token-should-not-leak/);
    assert.doesNotMatch(stdout, /社内試験用の合成回答です/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
