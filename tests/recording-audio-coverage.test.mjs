import assert from "node:assert/strict";
import test from "node:test";

import {
  REMOTE_RECORDING_ALLOWED_QUIET_SAMPLES,
  initialRecordingAudioCoverageState,
  reduceRecordingAudioCoverage,
} from "../lib/recording-audio-coverage.js";

const energy = (state, overrides = {}) => reduceRecordingAudioCoverage(state, {
  type: "sample",
  expected: true,
  candidateSpeaking: false,
  contextRunning: true,
  trackLive: true,
  trackMuted: false,
  rms: 0.01,
  ...overrides,
});

test("three consecutive assistant-window samples prove remote recording, but a spike or candidate speech does not", () => {
  let state = initialRecordingAudioCoverageState();
  state = energy(state);
  assert.equal(state.verified, false);
  state = energy(state, { candidateSpeaking: true });
  assert.equal(state.verified, false);
  state = energy(state);
  state = energy(state);
  assert.equal(state.verified, false);
  state = energy(state);
  assert.equal(state.verified, true);
});

test("interrupted or suspended context resumes conservatively and can never restore both for the same file", () => {
  let state = initialRecordingAudioCoverageState();
  for (let index = 0; index < 3; index += 1) state = energy(state);
  assert.equal(state.verified, true);
  state = reduceRecordingAudioCoverage(state, { type: "interrupted" });
  assert.deepEqual({ invalid: state.invalid, verified: state.verified }, { invalid: true, verified: false });
  state = reduceRecordingAudioCoverage(state, { type: "recovered" });
  for (let index = 0; index < 3; index += 1) state = energy(state);
  assert.deepEqual({ invalid: state.invalid, verified: state.verified }, { invalid: true, verified: false });
});

test("page hidden/pagehide and track mute/end remain fail-closed after visible or unmute recovery", () => {
  for (const event of ["hidden", "track_unavailable"]) {
    let state = initialRecordingAudioCoverageState();
    for (let index = 0; index < 3; index += 1) state = energy(state);
    state = reduceRecordingAudioCoverage(state, { type: event });
    state = reduceRecordingAudioCoverage(state, { type: "recovered" });
    assert.equal(state.invalid, true, event);
    assert.equal(state.verified, false, event);
  }
});

test("full-session monitor detects later expected silence and ordinary gestures cannot postpone it", () => {
  let state = initialRecordingAudioCoverageState();
  for (let index = 0; index < 3; index += 1) state = energy(state);
  for (let index = 0; index < REMOTE_RECORDING_ALLOWED_QUIET_SAMPLES; index += 1) {
    if (index === 20) state = reduceRecordingAudioCoverage(state, { type: "ordinary_user_gesture" });
    state = energy(state, { rms: 0 });
  }
  assert.equal(state.invalid, true);
  assert.equal(state.verified, false);
});
