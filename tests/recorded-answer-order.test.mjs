import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isExactRecordedCompletionReplay,
  splitRecordedAnswerUpload,
} from "../lib/recorded-answer-upload.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("a delayed final-answer registration blocks sealing, but pending STT does not block recording upload", async () => {
  const registrationReceipt = deferred();
  const transcription = deferred();
  const events = [];
  const tasks = splitRecordedAnswerUpload({
    register: () => registrationReceipt.promise,
    afterRegistration: () => { events.push("registered"); },
    complete: async () => {
      events.push("stt-started");
      await transcription.promise;
      events.push("stt-completed");
    },
  });

  const finalization = (async () => {
    await tasks.registration;
    events.push("sealed");
    events.push("recording-uploaded");
    await tasks.completion;
    events.push("interview-completed");
  })();

  await flushPromises();
  assert.deepEqual(events, [], "seal must not overtake a delayed initial D1/R2 receipt");

  registrationReceipt.resolve({ state: "pending" });
  await flushPromises();
  assert.ok(events.includes("registered"));
  assert.ok(events.includes("sealed"));
  assert.ok(events.includes("recording-uploaded"));
  assert.ok(events.includes("stt-started"));
  assert.equal(events.includes("interview-completed"), false);
  assert.ok(
    events.indexOf("registered") < events.indexOf("sealed"),
    "the exact answer receipt must precede the answer-count seal",
  );
  assert.ok(
    events.indexOf("recording-uploaded") < events.indexOf("interview-completed") ||
      !events.includes("interview-completed"),
    "recording upload may proceed while STT is pending",
  );

  transcription.resolve();
  await finalization;
  assert.ok(events.indexOf("stt-completed") < events.indexOf("interview-completed"));
});

test("a rejected registration rejects both milestones and never starts STT", async () => {
  const failure = new Error("registration failed");
  let completionStarted = false;
  const tasks = splitRecordedAnswerUpload({
    register: async () => { throw failure; },
    afterRegistration: () => assert.fail("a failed POST cannot be receipted"),
    complete: async () => { completionStarted = true; },
  });

  await assert.rejects(tasks.registration, failure);
  await assert.rejects(tasks.completion, failure);
  assert.equal(completionStarted, false);
});

test("only the exact authenticated completed-session replay can resolve an answer 409", () => {
  const exact = {
    stored: true,
    humanReviewRequired: true,
    alreadyCompleted: true,
  };
  assert.equal(isExactRecordedCompletionReplay(200, exact), true);
  assert.equal(isExactRecordedCompletionReplay(409, exact), false, "the answer 409 itself is never success");
  assert.equal(isExactRecordedCompletionReplay(200, { ...exact, alreadyCompleted: false }), false);
  assert.equal(isExactRecordedCompletionReplay(200, { ...exact, error: "unexpected" }), false);
  assert.equal(isExactRecordedCompletionReplay(200, null), false);
});

test("recorded fallback source keeps registration, STT completion, and retry bodies separated", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(source, /recordedAnswerRegistrationPromisesRef/);
  assert.match(source, /recordedAnswerCompletionPromisesRef/);
  assert.match(source, /recordedAnswerCredentialsRef/);
  assert.match(source, /data\?\.stored === true && data\.answerIndex === answerIndex/);
  assert.match(source, /response\.status === 409[\s\S]*RECORDED_ANSWER_SESSION_STATE_CONFLICT/);

  const bodylessRetry = source.slice(
    source.indexOf("async function retryRecordedAnswerTranscription("),
    source.indexOf("function recordedAnswerCredentials("),
  );
  assert.match(bodylessRetry, /X-Recorded-Answer-Index/);
  assert.doesNotMatch(bodylessRetry, /X-Recorded-Answer-Bytes|body:/);

  const registrationRetry = source.slice(
    source.indexOf("function resendRecordedAnswerRegistration("),
    source.indexOf("function finishRecordedAnswerCapture("),
  );
  assert.match(registrationRetry, /recordedAnswerBlobsRef/);
  assert.match(registrationRetry, /uploadRecordedAnswer\(answerIndex, blob, credentials\)/);

  const seal = source.slice(
    source.indexOf("async function sealRecordedFallbackCompletion("),
    source.indexOf("async function sealVoiceTranscriptCompletion("),
  );
  assert.ok(
    seal.indexOf("await ensureRecordedAnswerRegistrations") <
      seal.indexOf('fetch("/api/interviews/recorded/seal"'),
    "all exact answer registrations must finish before sealing",
  );

  const completion = source.slice(
    source.indexOf("async function completeInterview(reason: string)"),
    source.indexOf("function handleRealtimeEvent(event: RealtimeEvent)"),
  );
  assert.ok(
    completion.indexOf("await sealRecordedFallbackCompletion();") <
      completion.indexOf("await uploadRecording(recordingBlob);"),
    "registration-gated sealing must precede the full recording upload",
  );
  assert.ok(
    completion.indexOf("await uploadRecording(recordingBlob);") <
      completion.indexOf("await storeInterviewFinalization();"),
    "STT-dependent finalization must happen after the full recording is durable",
  );

  const fallbackCompletion = source.slice(
    source.indexOf("async function completeRecordedFallback("),
    source.indexOf("async function sealRecordedFallbackCompletion("),
  );
  assert.ok(
    fallbackCompletion.indexOf("await awaitRecordedAnswerTranscriptions") <
      fallbackCompletion.indexOf('fetch("/api/interviews/recorded/complete"'),
    "the final interview completion endpoint must wait for every STT result",
  );

  const concurrentCompletion = source.slice(
    source.indexOf("async function verifyConcurrentRecordedFallbackCompletion("),
    source.indexOf("async function awaitRecordedAnswerTranscriptions("),
  );
  assert.match(concurrentCompletion, /exactRecordedAnswerCredentials\(answerIndexes\)/);
  assert.match(concurrentCompletion, /questionCount: answerIndexes\.length/);
  assert.match(concurrentCompletion, /isExactRecordedCompletionReplay\(response\.status, data\)/);
  assert.match(concurrentCompletion, /recordedAnswerTranscribedRef\.current\.add\(answerIndex\)/);

  const transcriptionWait = source.slice(
    source.indexOf("async function awaitRecordedAnswerTranscriptions("),
    source.indexOf("async function completeRecordedFallback("),
  );
  assert.match(transcriptionWait, /Promise\.allSettled\(completions\)/);
  assert.match(transcriptionWait, /RECORDED_ANSWER_SESSION_STATE_CONFLICT/);
  assert.match(transcriptionWait, /await verifyConcurrentRecordedFallbackCompletion\(answerIndexes\)/);
});
