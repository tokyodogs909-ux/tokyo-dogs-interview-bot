const DEFAULT_RECOVERY_LIMIT = 2;
const FAILED_RETRY_AFTER_MS = 10 * 60 * 1000;
const PENDING_RETRY_AFTER_MS = 5 * 60 * 1000;
const RUNNING_RECLAIM_AFTER_MS = 16 * 60 * 1000;

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
    if (!item.driveStatus) return true;
    const elapsed = elapsedSince(item.driveUpdatedAt, nowMs);
    if (item.driveStatus === "failed") return elapsed >= FAILED_RETRY_AFTER_MS;
    if (item.driveStatus === "pending") return elapsed >= PENDING_RETRY_AFTER_MS;
    if (item.driveStatus === "running") return elapsed >= RUNNING_RECLAIM_AFTER_MS;
    return false;
  }).slice(0, safeLimit).map((item) => item.sessionId);
}

export function summarizeDriveArchives(interviews, recoverySessionIds = []) {
  const completed = interviews.filter((item) => item.status === "completed");
  const stored = completed.filter((item) => item.driveStatus === "completed").length;
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
