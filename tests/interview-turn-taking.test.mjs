import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  initialTurnTakingState,
  isNewInterviewRecord,
  isExpectedResponseCancelError,
  reduceTurnTaking,
  replayTurnTaking,
  selectRecordingMimeType,
  supportedRecordingMimeTypes,
} from "../lib/interview-turn-taking.js";

// The three device classes the candidate portal must support. Each entry models
// only what the browser actually differs on: how it identifies itself and which
// MediaRecorder containers it can produce.
const DEVICE_PROFILES = [
  {
    name: "iPhone Safari",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    embeddedBrowser: false,
    // iOS Safari records MP4 only; every WebM probe returns false.
    supportedRecordingTypes: ["video/mp4;codecs=h264,aac", "video/mp4", "audio/mp4"],
    expectedVideoContainer: "video/mp4;codecs=h264,aac",
    expectedAudioContainer: "audio/mp4",
  },
  {
    name: "Android Chrome",
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    embeddedBrowser: false,
    supportedRecordingTypes: ["video/webm;codecs=vp8,opus", "video/webm", "audio/webm;codecs=opus", "audio/webm"],
    expectedVideoContainer: "video/webm;codecs=vp8,opus",
    expectedAudioContainer: "audio/webm;codecs=opus",
  },
  {
    name: "PC Chrome",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    embeddedBrowser: false,
    supportedRecordingTypes: ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4", "audio/webm;codecs=opus", "audio/webm"],
    expectedVideoContainer: "video/webm;codecs=vp8,opus",
    expectedAudioContainer: "audio/webm;codecs=opus",
  },
  {
    name: "LINE in-app browser (iOS)",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/13.15.0",
    embeddedBrowser: true,
    supportedRecordingTypes: [],
    expectedVideoContainer: null,
    expectedAudioContainer: null,
  },
];

function isTypeSupportedFor(profile) {
  return (mimeType) => profile.supportedRecordingTypes.includes(mimeType);
}

const TURN_EVENTS = [
  "candidate_speech_started",
  "candidate_speech_stopped",
  "response_created",
  "assistant_output",
  "response_done",
  "response_cancel_rejected",
  "response_failed",
];

test("each supported device selects a recording container it can actually produce", async () => {
  for (const profile of DEVICE_PROFILES) {
    const isSupported = isTypeSupportedFor(profile);
    assert.equal(
      selectRecordingMimeType(true, isSupported),
      profile.expectedVideoContainer,
      `${profile.name}: unexpected video container`,
    );
    assert.equal(
      selectRecordingMimeType(false, isSupported),
      profile.expectedAudioContainer,
      `${profile.name}: unexpected audio container`,
    );
    // Every returned candidate must be one the device claims to support, and the
    // fallback order must be preserved so a rejected constructor can try the next.
    for (const mimeType of supportedRecordingMimeTypes(true, isSupported)) {
      assert.ok(profile.supportedRecordingTypes.includes(mimeType), `${profile.name}: ${mimeType}`);
    }
  }
});

test("a device with no supported container reports no recording instead of guessing one", () => {
  assert.equal(selectRecordingMimeType(true, () => false), null);
  assert.deepEqual(supportedRecordingMimeTypes(true, () => false), []);
});

test("the interviewer never starts a question while the candidate is still speaking", () => {
  for (const profile of DEVICE_PROFILES) {
    // AI asks, candidate answers over the top of it, candidate finishes.
    const events = [
      "response_created",
      "assistant_output",
      "candidate_speech_started",
      "assistant_output",
      "assistant_output",
    ];
    let state = initialTurnTakingState();
    for (const event of events) {
      const next = reduceTurnTaking(state, event);
      // Checked on the resulting state: candidate_speech_stopped is the one event
      // that legitimately ends the utterance and starts the pause before a question.
      if (next.state.candidateSpeaking) {
        assert.ok(
          !next.actions.includes("scheduleNextQuestion"),
          `${profile.name}: scheduled a question while the candidate was speaking (${event})`,
        );
      }
      state = next.state;
    }
    assert.equal(state.candidateSpeaking, true, profile.name);
    assert.equal(state.awaitingResponse, false, `${profile.name}: barge-in must cancel the response`);
  }
});

test("a barge-in cancels the interviewer and the next question follows the candidate's pause", () => {
  const { state, actions } = replayTurnTaking([
    "response_created",
    "assistant_output",
    "candidate_speech_started",
    "assistant_output",
    "response_done",
    "candidate_speech_stopped",
  ]);
  assert.ok(actions.includes("cancelActiveResponse"));
  assert.equal(actions.filter((action) => action === "scheduleNextQuestion").length, 1);
  assert.deepEqual(state, {
    candidateSpeaking: false,
    awaitingResponse: false,
    candidateTurnPending: false,
  });
});

test("a response.created that lands after the barge-in cancel does not strand the candidate", () => {
  // Regression: response.create is accepted just as the candidate starts talking,
  // so response.created arrives after the cancel. The candidate then finishes and
  // response.done arrives for the cancelled response. Previously nothing scheduled
  // the next question and the interview stalled on "お話を聞いています" with no
  // watchdog left to recover it.
  const { state, actions } = replayTurnTaking([
    "candidate_speech_started",
    "response_created",
    "candidate_speech_stopped",
    "response_done",
  ]);
  assert.equal(
    actions.filter((action) => action === "scheduleNextQuestion").length,
    1,
    "the candidate's finished turn must start exactly one next question",
  );
  assert.equal(state.candidateSpeaking, false);
  assert.equal(state.awaitingResponse, false);
  assert.equal(state.candidateTurnPending, false);
});

test("a rejected barge-in cancel resumes the interview instead of ending it", () => {
  // response.cancel can lose the race against the response finishing, and the
  // server then answers the cancel with an error. That must continue the turn.
  const { state, actions } = replayTurnTaking([
    "candidate_speech_started",
    "response_created",
    "candidate_speech_stopped",
    "response_cancel_rejected",
  ]);
  assert.equal(actions.filter((action) => action === "scheduleNextQuestion").length, 1);
  assert.equal(state.awaitingResponse, false);
  assert.equal(state.candidateTurnPending, false);
});

test("only the error correlated to our recent response.cancel is treated as harmless", () => {
  const pending = new Map([["cancel-1", 1_000]]);
  assert.equal(isExpectedResponseCancelError("cancel-1", pending, 2_000, 5_000), true);
  assert.equal(isExpectedResponseCancelError("different-event", pending, 2_000, 5_000), false);
  assert.equal(isExpectedResponseCancelError(undefined, pending, 2_000, 5_000), false);
  assert.equal(isExpectedResponseCancelError("cancel-1", pending, 7_001, 5_000), false);
});

test("no realtime event order can leave the interview stalled or talking over the candidate", () => {
  // Exhaustive replay of every event order up to length 5. Two invariants:
  //   1. a question is never started from a state where the candidate is speaking
  //   2. the machine never comes to rest with the candidate's turn finished, no
  //      response in flight, and no next question scheduled (a silent stall)
  let checked = 0;
  const walk = (state, depth) => {
    checked += 1;
    assert.ok(
      !(state.candidateTurnPending && !state.awaitingResponse && !state.candidateSpeaking),
      `stalled state reached: ${JSON.stringify(state)}`,
    );
    if (depth === 0) return;
    for (const event of TURN_EVENTS) {
      const next = reduceTurnTaking(state, event);
      if (next.state.candidateSpeaking) {
        assert.ok(
          !next.actions.includes("scheduleNextQuestion"),
          `${event} scheduled a question mid-utterance from ${JSON.stringify(state)}`,
        );
      }
      walk(next.state, depth - 1);
    }
  };
  walk(initialTurnTakingState(), 5);
  assert.ok(checked > 10_000, `expected an exhaustive walk, visited ${checked}`);
});

test("a candidate's finished turn always leads to a question once the line is idle", () => {
  // Every order that ends with the candidate having stopped and nothing in
  // flight must have produced a next question at some point after that stop.
  for (const first of TURN_EVENTS) {
    for (const second of TURN_EVENTS) {
      for (const third of TURN_EVENTS) {
        const order = ["candidate_speech_started", "candidate_speech_stopped", first, second, third];
        // response_failed hands the candidate to the reconnect screen on purpose,
        // so those orders are not expected to continue with a question.
        if (order.includes("response_failed")) continue;
        let state = initialTurnTakingState();
        let scheduled = 0;
        let lastStopIndex = -1;
        let scheduledAfterLastStop = false;
        order.forEach((event, index) => {
          const next = reduceTurnTaking(state, event);
          if (event === "candidate_speech_stopped") {
            lastStopIndex = index;
            scheduledAfterLastStop = false;
          }
          if (next.actions.includes("scheduleNextQuestion")) {
            scheduled += 1;
            if (index >= lastStopIndex) scheduledAfterLastStop = true;
          }
          state = next.state;
        });
        if (!state.candidateSpeaking && !state.awaitingResponse) {
          assert.ok(
            scheduledAfterLastStop,
            `no question after the candidate stopped: ${order.join(" → ")} (scheduled ${scheduled})`,
          );
        }
      }
    }
  }
});

test("reconnecting to the same interview keeps the transcript and recording captured so far", () => {
  // The transcript and the recording chunks are only sent when the interview
  // completes, so a reconnect that treats the session as new would silently drop
  // everything the candidate already said.
  assert.equal(isNewInterviewRecord(null, "TD-ABC-1234567"), true);
  assert.equal(isNewInterviewRecord("TD-ABC-1234567", "TD-ABC-1234567"), false);
  assert.equal(isNewInterviewRecord("TD-ABC-1234567", "TD-XYZ-7654321"), true);
});

test("app/page.tsx drives the audited turn-taking rules instead of its own copy", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /from "@\/lib\/interview-turn-taking"/);
  assert.match(source, /applyTurnTaking\("candidate_speech_stopped"/);
  assert.match(source, /applyTurnTaking\("response_done"/);
  assert.match(source, /applyTurnTaking\("response_cancel_rejected"/);
  assert.match(source, /event\.error\?\.event_id/);
  assert.match(source, /isExpectedResponseCancelError\(/);
  assert.match(source, /supportedRecordingMimeTypes\(/);
  assert.match(source, /isNewInterviewRecord\(recordedInterviewSessionRef\.current, activeSessionId\)/);
  // The pre-refactor duplicates must be gone, or the audited rules and the
  // shipped behaviour could drift apart again.
  assert.doesNotMatch(source, /responseWaitingRef/);
  assert.doesNotMatch(source, /candidateSpeakingRef/);
});
