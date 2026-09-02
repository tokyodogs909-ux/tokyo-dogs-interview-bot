import assert from "node:assert/strict";
import test from "node:test";

import {
  cameraInterviewReadiness,
  initialLocalMediaHealth,
  initialMicrophoneVerification,
  isEmbeddedInterviewBrowser,
  reduceLocalMediaHealth,
  reduceMicrophoneVerification,
  reduceSpeakerVerification,
} from "../lib/interview-device-readiness.js";

test("known embedded WebViews fail closed while Safari and Chrome remain eligible", () => {
  assert.equal(isEmbeddedInterviewBrowser("Mozilla/5.0 Line/14.2.0"), true);
  assert.equal(isEmbeddedInterviewBrowser("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A; wv) Version/4.0 Chrome/124 Mobile"), true);
  assert.equal(isEmbeddedInterviewBrowser("Mozilla/5.0 Instagram 331.0.0 iPhone"), true);
  assert.equal(isEmbeddedInterviewBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"), true);
  assert.equal(isEmbeddedInterviewBrowser("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1"), false);
  assert.equal(isEmbeddedInterviewBrowser("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36"), false);
});

test("camera mode requires live tracks, measured microphone energy, and an explicit speaker test", () => {
  const base = {
    embeddedBrowser: false,
    recoveryRequired: false,
    hasLiveVideo: true,
    hasLiveAudio: true,
    microphoneVerified: false,
    speakerVerified: false,
  };
  assert.equal(cameraInterviewReadiness(base).code, "MICROPHONE_NOT_HEARD");
  assert.equal(cameraInterviewReadiness({ ...base, microphoneVerified: true }).code, "SPEAKER_NOT_VERIFIED");
  assert.deepEqual(
    cameraInterviewReadiness({ ...base, microphoneVerified: true, speakerVerified: true }),
    { ready: true, code: "READY", message: "映像・マイク・スピーカーを確認済みです。" },
  );
  assert.equal(cameraInterviewReadiness({ ...base, embeddedBrowser: true }).code, "EMBEDDED_BROWSER");
});

test("real media interruptions stay sticky while visibility-only backgrounding does not invent a track failure", () => {
  for (const type of ["track_muted", "track_ended", "device_changed"]) {
    const blocked = reduceLocalMediaHealth(initialLocalMediaHealth(), { type });
    assert.equal(blocked.blocked, true);
    assert.equal(reduceLocalMediaHealth(blocked, { type: "track_unmuted" }), blocked);
    assert.equal(reduceLocalMediaHealth(blocked, { type: "microphone_verified" }), blocked);
    const recovered = reduceLocalMediaHealth(blocked, { type: "explicit_recovery_verified" });
    assert.equal(recovered.blocked, false);
    assert.equal(recovered.revision, blocked.revision + 1);
  }
  const healthy = initialLocalMediaHealth();
  assert.equal(reduceLocalMediaHealth(healthy, { type: "page_hidden" }), healthy);
});

test("microphone verification needs five consecutive live energy samples and resets on silence", () => {
  let state = initialMicrophoneVerification();
  for (let index = 0; index < 4; index += 1) {
    state = reduceMicrophoneVerification(state, { trackLive: true, level: 8 });
    assert.equal(state.verified, false);
  }
  state = reduceMicrophoneVerification(state, { trackLive: true, level: 2 });
  assert.deepEqual(state, initialMicrophoneVerification());
  for (let index = 0; index < 5; index += 1) {
    state = reduceMicrophoneVerification(state, { trackLive: true, level: 8 });
  }
  assert.equal(state.verified, true);
});

test("speaker playback cannot pass until the candidate explicitly confirms hearing it", () => {
  let state = "idle";
  state = reduceSpeakerVerification(state, "playback_started");
  assert.equal(state, "playing");
  assert.equal(reduceSpeakerVerification(state, "candidate_confirmed"), "playing");
  state = reduceSpeakerVerification(state, "playback_completed");
  assert.equal(state, "played");
  state = reduceSpeakerVerification(state, "candidate_confirmed");
  assert.equal(state, "passed");
  assert.equal(reduceSpeakerVerification("error", "candidate_confirmed"), "error");
});
