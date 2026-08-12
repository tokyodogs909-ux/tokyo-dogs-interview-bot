import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../scripts/production-recording-archive-e2e.mjs", import.meta.url),
  "utf8",
);

test("production recording E2E stores the full recording before bodyless transcription retries", () => {
  const initialUpload = source.slice(
    source.indexOf("async function uploadAnswerOnce"),
    source.indexOf("async function recordedCompletionRequest"),
  );
  assert.match(initialUpload, /"X-Recorded-Answer-Bytes": String\(answerAudio\.byteLength\)/);
  assert.match(initialUpload, /body: answerAudio/);
  assert.equal(initialUpload.match(/\/api\/interviews\/recorded\/answer/g)?.length, 1);

  const bodylessRetry = source.slice(
    source.indexOf("async function finishPendingAnswer"),
    source.indexOf("const pendingAnswers = \[\]"),
  );
  assert.match(bodylessRetry, /while \(true\)/);
  assert.match(bodylessRetry, /retryDeadlineAt/);
  assert.doesNotMatch(bodylessRetry, /"X-Recorded-Answer-Bytes"/);
  assert.doesNotMatch(bodylessRetry, /body: answerAudio/);
  assert.match(bodylessRetry, /response\.status === 409/);
  assert.match(bodylessRetry, /verifyConcurrentRecordedCompletion/);

  const mainFlow = source.slice(source.indexOf("const pendingAnswers = [];"));
  const orderedStatements = [
    "await uploadAnswerOnce(answerIndex)",
    "const seal = await fetch",
    "const initial = await startUpload()",
    "const uploaded = await uploadPart(index)",
    "const resumed = await startUpload()",
    "const finalize = await fetch",
    "const finalizedReadback = await startUpload()",
    "const pendingProbe = await recordedCompletionRequest()",
    "const finalizeReplay = await fetch",
    "await finishPendingAnswer(pendingAnswer, transcriptionRetryDeadlineAt)",
    "const completion = await recordedCompletionRequest()",
    "const archiveStartedAt = Date.now()",
  ];
  const positions = orderedStatements.map((statement) => {
    const position = mainFlow.indexOf(statement);
    assert.notEqual(position, -1, `missing E2E statement: ${statement}`);
    return position;
  });
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));

  assert.match(source, /minimumRecordingFixtureBytes = 70_000_000/);
  assert.match(source, /minimumRecordingFixtureDurationSeconds = 60/);
  assert.match(source, /const recordingAudioCoverage = "unverified"/);
  assert.match(source, /uploadVersion: 2/);
  assert.match(source, /spawnSync\(/);
  assert.match(source, /"ffprobe"/);
  assert.match(source, /probeMedia\([\s\S]*recordingPath,[\s\S]*\["video", "audio"\],[\s\S]*minimumRecordingFixtureDurationSeconds/);
  assert.match(source, /probeMedia\(answerAudioPath, \["audio"\]\)/);
  assert.match(source, /recording\.byteLength < minimumRecordingFixtureBytes/);
  assert.match(source, /recordingPartSha256s = Array\.from/);
  assert.match(source, /"X-Recording-Part-Sha256": recordingPartSha256s\[index\]/);
  assert.match(source, /recordingPartSha256s,/);
  assert.match(source, /phase: "initial_upload"/);
  assert.match(source, /phase: "bodyless_retry"/);
  assert.match(source, /maxServerRetryAfterSeconds = 300/);
  assert.match(source, /answerRetryWallClockMs = 10 \* 60 \* 1_000/);
  assert.doesNotMatch(source, /maxAnswerRetryAttempts/);
  assert.match(source, /Number\.isInteger\(retryAfterSeconds\)/);
  assert.match(source, /rawHeader !== String\(retryAfterSeconds\)/);
  assert.match(source, /retrySleepSeconds: Math\.min\(maxServerRetryAfterSeconds, retryAfterSeconds\)/);
  assert.match(source, /uploaded\.body\.stored !== true/);
  assert.match(source, /uploaded\.body\.duplicate !== false/);
  assert.match(source, /uploaded\.body\.index !== index/);
  assert.match(source, /verifiedUploadReadback\(resumed\.body, expectedResumedParts, false\)/);
  assert.match(source, /finalized\.byteSize === recording\.byteLength/);
  assert.match(source, /verifiedUploadReadback\(finalizedReadback\.body, expectedAllParts, true\)/);
  assert.match(source, /pendingComplete\.status === 409/);
  assert.match(source, /pendingCompletion\.stored === false/);
  assert.match(source, /pendingCompletion\.transcriptionPending === true/);
  assert.match(source, /replay\.body\.alreadyCompleted !== true/);
  assert.match(source, /completed\.humanReviewRequired !== true/);
  assert.match(source, /archived\.transcriptKind !== "actual_transcript"/);
});
