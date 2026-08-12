import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  INTERVIEW_MAX_SECONDS,
  INTERVIEW_WARNING_SECONDS,
  mayDispatchTimedResponse,
  nextInterviewTimeAction,
  recordedFallbackQuietState,
} from "../lib/interview-time-control.js";

test("the interview warns at 24 minutes and requests a controlled close at 27 minutes", () => {
  assert.equal(INTERVIEW_WARNING_SECONDS, 1_440);
  assert.equal(INTERVIEW_MAX_SECONDS, 1_620);
  assert.equal(nextInterviewTimeAction({ elapsedSeconds: 1_439, warningDelivered: false, maximumRequested: false }), null);
  assert.equal(nextInterviewTimeAction({ elapsedSeconds: 1_440, warningDelivered: false, maximumRequested: false }), "warning");
  assert.equal(nextInterviewTimeAction({ elapsedSeconds: 1_619, warningDelivered: true, maximumRequested: false }), null);
  assert.equal(nextInterviewTimeAction({ elapsedSeconds: 1_620, warningDelivered: true, maximumRequested: false }), "complete");
  assert.equal(nextInterviewTimeAction({ elapsedSeconds: 2_000, warningDelivered: true, maximumRequested: true }), null);
});

test("timed interviewer audio never starts while the candidate or interviewer is speaking", () => {
  assert.equal(mayDispatchTimedResponse({ candidateSpeaking: false, awaitingResponse: false, timedResponseInFlight: false, ending: false }), true);
  assert.equal(mayDispatchTimedResponse({ candidateSpeaking: true, awaitingResponse: false, timedResponseInFlight: false, ending: false }), false);
  assert.equal(mayDispatchTimedResponse({ candidateSpeaking: false, awaitingResponse: true, timedResponseInFlight: false, ending: false }), false);
  assert.equal(mayDispatchTimedResponse({ candidateSpeaking: false, awaitingResponse: false, timedResponseInFlight: true, ending: false }), false);
  assert.equal(mayDispatchTimedResponse({ candidateSpeaking: false, awaitingResponse: false, timedResponseInFlight: false, ending: true }), false);
});

test("recorded fallback waits for 3.2 seconds of microphone silence before closing", () => {
  let state = recordedFallbackQuietState({ microphoneLevel: 0, quietSince: null, now: 1_000 });
  assert.deepEqual(state, { quietSince: 1_000, ready: false });
  state = recordedFallbackQuietState({ microphoneLevel: 0, quietSince: state.quietSince, now: 4_199 });
  assert.equal(state.ready, false);
  state = recordedFallbackQuietState({ microphoneLevel: 0, quietSince: state.quietSince, now: 4_200 });
  assert.equal(state.ready, true);
  assert.deepEqual(recordedFallbackQuietState({ microphoneLevel: 4, quietSince: 1_000, now: 8_000 }), { quietSince: null, ready: false });
});

test("the candidate and staff pages wire the time limit and completion monitor", async () => {
  const candidatePage = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const staffPage = await readFile(new URL("../app/staff/page.tsx", import.meta.url), "utf8");
  assert.match(candidatePage, /nextInterviewTimeAction\(/);
  assert.match(candidatePage, /suppressNextQuestion: timedActionPending/);
  assert.match(candidatePage, /recordedFallbackQuietState\(/);
  assert.match(candidatePage, /max_duration_reached/);
  assert.match(staffPage, /setInterval\(\(\) => void pollInterviewListRef\.current\(\), 15_000\)/);
  assert.match(staffPage, /new Notification\("TOKYO DOGS｜オンライン一次面接完了"/);
  assert.match(staffPage, /searchParams\.set\("poll", "1"\)/);
  assert.match(staffPage, /\/api\/staff\/interviews\$\{searchParams\.size/);
});
