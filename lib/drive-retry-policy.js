export const EXTERNAL_SYNC_MAX_FAILURES = 4;
export const EXTERNAL_SYNC_MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;
const BASE_BACKOFF_MS = 10 * 60 * 1_000;

export function isRetryableExternalSyncError(code) {
  return /^(?:GOOGLE_DRIVE_(?:API|EXPORT|RESUMABLE_INIT|RESUMABLE_UPLOAD)_)(?:429|500|502|503|504|524)$/.test(code) ||
    code === "GOOGLE_DRIVE_TOKEN_REFRESH_TRANSIENT" ||
    code === "GOOGLE_DRIVE_ROOT_LOOKUP_FAILED" ||
    code === "GOOGLE_DRIVE_HIERARCHY_BUSY" ||
    code === "GOOGLE_DRIVE_SYNC_FAILED";
}

/**
 * Pure retry decision shared by production persistence and unit tests. 404/410,
 * permission/auth failures, and deterministic integrity faults stop immediately.
 * Transient failures receive at most four total attempts with capped backoff.
 */
export function decideExternalSyncFailure(code, previousFailureCount, nowMs = Date.now()) {
  const failureCount = Math.max(0, Math.trunc(Number(previousFailureCount) || 0)) + 1;
  const retryable = isRetryableExternalSyncError(code);
  const blocked = !retryable || failureCount >= EXTERNAL_SYNC_MAX_FAILURES;
  const delayMs = blocked ? null : Math.min(
    EXTERNAL_SYNC_MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * (2 ** Math.max(0, failureCount - 1)),
  );
  return {
    failureCount,
    blocked,
    nextRetryAt: delayMs === null ? null : new Date(nowMs + delayMs).toISOString(),
  };
}
