export const REMOTE_RECORDING_ENERGY_RMS = 0.004;
export const REMOTE_RECORDING_REQUIRED_ENERGY_SAMPLES = 3;
export const REMOTE_RECORDING_ALLOWED_QUIET_SAMPLES = 40;

export function initialRecordingAudioCoverageState() {
  return {
    energySamples: 0,
    quietSamples: 0,
    expectedWindowSeen: false,
    invalid: false,
    verified: false,
  };
}

export function reduceRecordingAudioCoverage(state, event) {
  const next = { ...state };
  if (event.type === "interrupted" || event.type === "hidden" || event.type === "track_unavailable") {
    return { ...next, energySamples: 0, quietSamples: 0, invalid: true, verified: false };
  }
  if (event.type === "recovered") {
    // Recovery can restore future capture, but cannot prove that the missing
    // interval was recorded. Invalid therefore remains sticky for this file.
    return { ...next, energySamples: 0, quietSamples: 0 };
  }
  if (event.type !== "sample") return next;
  if (!event.expected || event.candidateSpeaking) {
    return { ...next, energySamples: 0, quietSamples: 0 };
  }
  next.expectedWindowSeen = true;
  if (!event.contextRunning || !event.trackLive || event.trackMuted) {
    return { ...next, energySamples: 0, quietSamples: 0, invalid: true, verified: false };
  }
  if (event.rms >= REMOTE_RECORDING_ENERGY_RMS) {
    next.energySamples += 1;
    next.quietSamples = 0;
    if (next.energySamples >= REMOTE_RECORDING_REQUIRED_ENERGY_SAMPLES && !next.invalid) next.verified = true;
    return next;
  }
  next.energySamples = 0;
  next.quietSamples += 1;
  if (next.quietSamples >= REMOTE_RECORDING_ALLOWED_QUIET_SAMPLES) {
    next.invalid = true;
    next.verified = false;
  }
  return next;
}
