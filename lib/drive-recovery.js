const DEFAULT_RECOVERY_LIMIT = 2;
const FAILED_RETRY_AFTER_MS = 10 * 60 * 1000;
const PENDING_RETRY_AFTER_MS = 5 * 60 * 1000;
const RECORDING_RETRY_AFTER_MS = 5 * 60 * 1000;

function elapsedSince(value, nowMs) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : Number.POSITIVE_INFINITY;
}

/**
 * Selects only completed interviews whose Drive archive is absent or old enough
 * to retry. The cooldown keeps the staff page's 15-second polling from turning a
 * prolonged Google outage into an API request loop.
 */
export function planDriveRecovery(interviews, nowMs = Date.now(), limit = DEFAULT_RECOVERY_LIMIT) {
  const safeLimit = Math.max(0, Math.min(5, Math.trunc(limit)));
  return interviews.filter((item) => {
    if (item.status !== "completed") return false;
    if (!["stored", "not_applicable"].includes(item.recordingStatus)) return false;
    if (!item.driveStatus) return true;
    if (
      item.driveStatus === "completed" &&
      item.recordingStatus === "stored" &&
      item.driveRecordingIncluded !== true
    ) return true;
    if (
      item.driveStatus === "completed" &&
      item.sourceTranscriptVerified === true &&
      (item.driveTranscriptAvailable !== true || item.driveTranscriptKind !== "actual_transcript")
    ) return true;
    const elapsed = elapsedSince(item.driveUpdatedAt, nowMs);
    if (item.driveStatus === "failed") return elapsed >= FAILED_RETRY_AFTER_MS;
    if (item.driveStatus === "pending") return elapsed >= PENDING_RETRY_AFTER_MS;
    // A running durable Drive archive represents a step machine, not one long
    // worker. Each authenticated staff poll may safely advance one <=4 MiB step;
    // the D1 lease prevents two tabs from writing the same offset concurrently.
    if (item.driveStatus === "running") return true;
    return false;
  }).slice(0, safeLimit).map((item) => item.sessionId);
}

/** Selects interrupted part uploads that are safe to finalize without the candidate token. */
export function planRecordingRecovery(interviews, nowMs = Date.now(), limit = DEFAULT_RECOVERY_LIMIT) {
  const safeLimit = Math.max(0, Math.min(5, Math.trunc(limit)));
  return interviews.filter((item) =>
    item.status === "completed" &&
    ["uploading", "failed"].includes(item.recordingStatus) &&
    elapsedSince(item.completedAt, nowMs) >= RECORDING_RETRY_AFTER_MS
  ).slice(0, safeLimit).map((item) => item.sessionId);
}

/**
 * Returns true only when the candidate-facing interview result and every
 * mode-required Drive artifact have been verified. `status=completed` alone
 * means the evaluation was stored; it is not an archive receipt.
 */
export function isVerifiedInterviewArchive(item) {
  if (item.status !== "completed") return false;
  if (item.driveStatus !== "completed") return false;
  if (item.driveIntegrityStatus !== "verified") return false;
  if (item.sourceTranscriptVerified !== true) return false;
  if (item.driveTranscriptAvailable !== true || item.driveTranscriptKind !== "actual_transcript") return false;
  if (item.recordingStatus === "not_applicable") return true;
  return item.recordingStatus === "stored" && item.driveRecordingIncluded === true;
}

export function summarizeDriveArchives(interviews, recoverySessionIds = []) {
  const completed = interviews.filter((item) => item.status === "completed");
  const stored = completed.filter(isVerifiedInterviewArchive).length;
  const processing = completed.filter((item) => item.driveStatus === "pending" || item.driveStatus === "running").length;
  const attention = completed.length - stored - processing;
  return {
    completedInterviews: completed.length,
    stored,
    processing,
    attention,
    autoRecoveryScheduled: recoverySessionIds.length,
  };
}
