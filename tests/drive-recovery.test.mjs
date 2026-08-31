import assert from "node:assert/strict";
import test from "node:test";
import {
  isVerifiedInterviewArchive,
  planDriveRecovery,
  planRecordingRecovery,
  recordingReplacementBlockCode,
  summarizeDriveArchives,
} from "../lib/drive-recovery.js";
import { decideExternalSyncFailure } from "../lib/drive-retry-policy.js";

const now = Date.parse("2026-08-03T06:00:00.000Z");

test("Drive retry policy blocks 404 immediately and caps transient retries", () => {
  assert.deepEqual(decideExternalSyncFailure("GOOGLE_DRIVE_API_404", 0, now), {
    failureCount: 1,
    blocked: true,
    nextRetryAt: null,
  });
  assert.deepEqual(decideExternalSyncFailure("GOOGLE_DRIVE_RESUMABLE_UPLOAD_524", 3, now), {
    failureCount: 4,
    blocked: true,
    nextRetryAt: null,
  });
  assert.deepEqual(decideExternalSyncFailure("GOOGLE_DRIVE_API_503", 0, now), {
    failureCount: 1,
    blocked: false,
    nextRetryAt: "2026-08-03T06:10:00.000Z",
  });
});

test("recording replacement stays fail-closed for ambiguous, moved, trashed, and denied reads", () => {
  const base = {
    oldRecording: null,
    expectedFolderId: "candidate-folder",
    confirmedMissingAcrossDrive: false,
    globalCandidates: null,
  };
  assert.equal(recordingReplacementBlockCode({
    ...base,
    oldReadErrorCode: "GOOGLE_DRIVE_API_404",
  }), "GOOGLE_DRIVE_RECORDING_REPAIR_CONFIRMATION_REQUIRED");
  assert.equal(recordingReplacementBlockCode({
    ...base,
    oldReadErrorCode: "GOOGLE_DRIVE_API_410",
  }), "GOOGLE_DRIVE_RECORDING_REPAIR_CONFIRMATION_REQUIRED");
  assert.equal(recordingReplacementBlockCode({
    ...base,
    oldReadErrorCode: "GOOGLE_DRIVE_API_403",
  }), "GOOGLE_DRIVE_API_403");
  assert.equal(recordingReplacementBlockCode({
    ...base,
    oldReadErrorCode: null,
    oldRecording: { trashed: true, parents: ["candidate-folder"] },
  }), "GOOGLE_DRIVE_ARCHIVE_RECORDING_TRASHED_RESTORE_REQUIRED");
  assert.equal(recordingReplacementBlockCode({
    ...base,
    oldReadErrorCode: null,
    oldRecording: { trashed: false, parents: ["other-folder"] },
  }), "GOOGLE_DRIVE_ARCHIVE_RECORDING_MOVED_MANUAL_ATTENTION");
  assert.equal(recordingReplacementBlockCode({
    ...base,
    oldReadErrorCode: "GOOGLE_DRIVE_API_404",
    confirmedMissingAcrossDrive: true,
    globalCandidates: [{ trashed: false }],
  }), "GOOGLE_DRIVE_ARCHIVE_RECORDING_MOVED_MANUAL_ATTENTION");
  assert.equal(recordingReplacementBlockCode({
    ...base,
    oldReadErrorCode: "GOOGLE_DRIVE_API_404",
    confirmedMissingAcrossDrive: true,
    globalCandidates: [{ trashed: true }],
  }), "GOOGLE_DRIVE_ARCHIVE_RECORDING_TRASHED_RESTORE_REQUIRED");
  assert.equal(recordingReplacementBlockCode({
    ...base,
    oldReadErrorCode: "GOOGLE_DRIVE_API_404",
    confirmedMissingAcrossDrive: true,
    globalCandidates: [],
  }), null);
});

function interview(sessionId, patch = {}) {
  return {
    sessionId,
    status: "completed",
    recordingStatus: "stored",
    driveStatus: "completed",
    driveRecordingIncluded: true,
    driveTranscriptAvailable: true,
    driveTranscriptKind: "actual_transcript",
    driveIntegrityStatus: "verified",
    sourceTranscriptVerified: true,
    driveUpdatedAt: "2026-08-03T05:59:00.000Z",
    driveNextRetryAt: null,
    driveRetryBlockedAt: null,
    driveAlertStatus: null,
    ...patch,
  };
}

test("Drive recovery retries only absent or cooled-down archives and caps background work", () => {
  const items = [
    interview("TD-MISSING", { driveStatus: null, driveUpdatedAt: null }),
    interview("TD-FAILED-OLD", { driveStatus: "failed", driveUpdatedAt: "2026-08-03T05:40:00.000Z" }),
    interview("TD-MISSING-THREE", { driveStatus: null, driveUpdatedAt: null }),
    interview("TD-FAILED-NEW", { driveStatus: "failed", driveUpdatedAt: "2026-08-03T05:55:00.000Z" }),
    interview("TD-PENDING-NEW", { driveStatus: "pending", driveUpdatedAt: "2026-08-03T05:58:00.000Z" }),
    interview("TD-RUNNING-LIVE", { driveStatus: "running", driveUpdatedAt: "2026-08-03T05:50:00.000Z" }),
    interview("TD-COMPLETE"),
  ];
  assert.deepEqual(planDriveRecovery(items, now), ["TD-MISSING", "TD-FAILED-OLD", "TD-MISSING-THREE"]);
});

test("Drive recovery repairs completed camera archives that omitted a now-stored recording", () => {
  const items = [
    interview("TD-VIDEO-MISSING", { driveRecordingIncluded: false }),
    interview("TD-TEXT", { recordingStatus: "not_applicable", driveRecordingIncluded: false }),
    interview("TD-UPLOAD-IN-PROGRESS", { recordingStatus: "uploading", driveRecordingIncluded: false }),
  ];
  assert.deepEqual(planDriveRecovery(items, now), ["TD-VIDEO-MISSING"]);
});

test("Drive recovery never auto-reopens a completed archive whose recording disappeared", () => {
  const items = [
    interview("TD-VIDEO-DRIFT", {
      driveIntegrityStatus: "drift",
      driveAlertCode: "GOOGLE_DRIVE_ARCHIVE_RECORDING_MISSING",
    }),
    interview("TD-TEXT-DRIFT", {
      recordingStatus: "not_applicable",
      driveRecordingIncluded: false,
      driveIntegrityStatus: "drift",
    }),
    interview("TD-OTHER-DRIFT", {
      driveIntegrityStatus: "drift",
      driveAlertCode: "GOOGLE_DRIVE_ARCHIVE_INTEGRITY_DRIFT",
    }),
    interview("TD-VIDEO-UNKNOWN", { driveIntegrityStatus: "unknown" }),
    interview("TD-VIDEO-DRIFT-BLOCKED", {
      driveIntegrityStatus: "drift",
      driveAlertCode: "GOOGLE_DRIVE_ARCHIVE_RECORDING_MISSING",
      driveRetryBlockedAt: "2026-08-03T05:10:00.000Z",
    }),
  ];
  assert.deepEqual(planDriveRecovery(items, now), []);
});

test("Drive recovery repairs a legacy transcript receipt only when the durable source is actual", () => {
  const items = [
    interview("TD-TRANSCRIPT-REPAIR", {
      driveTranscriptAvailable: false,
      driveTranscriptKind: "unknown",
      sourceTranscriptVerified: true,
    }),
    interview("TD-PLACEHOLDER-NO-REPAIR", {
      driveTranscriptAvailable: false,
      driveTranscriptKind: "recorded_fallback_placeholder",
      sourceTranscriptVerified: false,
    }),
  ];
  assert.deepEqual(planDriveRecovery(items, now), ["TD-TRANSCRIPT-REPAIR"]);
});

test("Drive recovery advances every running step but ignores unfinished interviews", () => {
  const items = [
    interview("TD-RUNNING-LIVE", { driveStatus: "running", driveUpdatedAt: "2026-08-03T05:59:59.000Z" }),
    interview("TD-RUNNING-STALE", { driveStatus: "running", driveUpdatedAt: "2026-08-03T05:40:00.000Z" }),
    interview("TD-NOT-COMPLETE", { status: "in_progress", driveStatus: null, driveUpdatedAt: null }),
  ];
  assert.deepEqual(planDriveRecovery(items, now), ["TD-RUNNING-LIVE", "TD-RUNNING-STALE"]);
});

test("Drive recovery never reopens a blocked archive and honors durable backoff", () => {
  const items = [
    interview("TD-404-BLOCKED", {
      driveStatus: "failed",
      driveUpdatedAt: "2026-08-03T05:00:00.000Z",
      driveRetryBlockedAt: "2026-08-03T05:10:00.000Z",
    }),
    interview("TD-503-WAIT", {
      driveStatus: "failed",
      driveUpdatedAt: "2026-08-03T05:00:00.000Z",
      driveNextRetryAt: "2026-08-03T06:10:00.000Z",
    }),
    interview("TD-503-DUE", {
      driveStatus: "failed",
      driveUpdatedAt: "2026-08-03T05:00:00.000Z",
      driveNextRetryAt: "2026-08-03T05:50:00.000Z",
    }),
  ];
  assert.deepEqual(planDriveRecovery(items, now), ["TD-503-DUE"]);
});

test("recording recovery finalizes only stale interrupted completed uploads", () => {
  const items = [
    interview("TD-UPLOAD-STALE", {
      recordingStatus: "uploading",
      completedAt: "2026-08-03T05:40:00.000Z",
      driveRecordingIncluded: false,
    }),
    interview("TD-FAILED-STALE", {
      recordingStatus: "failed",
      completedAt: "2026-08-03T05:40:00.000Z",
      driveRecordingIncluded: false,
    }),
    interview("TD-UPLOAD-RECENT", {
      recordingStatus: "uploading",
      completedAt: "2026-08-03T05:58:00.000Z",
      driveRecordingIncluded: false,
    }),
    interview("TD-NOT-COMPLETE", {
      status: "in_progress",
      recordingStatus: "uploading",
      completedAt: null,
      driveRecordingIncluded: false,
    }),
  ];
  assert.deepEqual(planRecordingRecovery(items, now), ["TD-UPLOAD-STALE", "TD-FAILED-STALE"]);
});

test("Drive archive health separates stored, processing, and attention records", () => {
  const items = [
    interview("TD-A"),
    interview("TD-B", { driveStatus: "pending" }),
    interview("TD-C", { driveStatus: "failed" }),
    interview("TD-D", { status: "in_progress", driveStatus: null }),
  ];
  assert.deepEqual(summarizeDriveArchives(items, ["TD-C"]), {
    completedInterviews: 3,
    stored: 1,
    processing: 1,
    attention: 1,
    blocked: 0,
    openAlerts: 0,
    autoRecoveryScheduled: 1,
  });
});

test("Drive archive health does not call a video-less camera archive stored", () => {
  const items = [
    interview("TD-VIDEO-MISSING", { driveRecordingIncluded: false }),
    interview("TD-TEXT", { recordingStatus: "not_applicable", driveRecordingIncluded: false }),
  ];
  assert.deepEqual(summarizeDriveArchives(items, ["TD-VIDEO-MISSING"]), {
    completedInterviews: 2,
    stored: 1,
    processing: 0,
    attention: 1,
    blocked: 0,
    openAlerts: 0,
    autoRecoveryScheduled: 1,
  });
});

test("verified receipt requires every mode-specific Drive artifact", () => {
  assert.equal(isVerifiedInterviewArchive(interview("TD-CAMERA")), true);
  assert.equal(isVerifiedInterviewArchive(interview("TD-CAMERA-DRIFT", {
    driveIntegrityStatus: "drift",
  })), false);
  assert.equal(isVerifiedInterviewArchive(interview("TD-CAMERA-INTEGRITY-UNKNOWN", {
    driveIntegrityStatus: "unknown",
  })), false);
  assert.equal(isVerifiedInterviewArchive(interview("TD-CAMERA-NO-VIDEO", {
    driveRecordingIncluded: false,
  })), false);
  assert.equal(isVerifiedInterviewArchive(interview("TD-CAMERA-PLACEHOLDER", {
    driveTranscriptAvailable: false,
    driveTranscriptKind: "recorded_fallback_placeholder",
  })), false);
  assert.equal(isVerifiedInterviewArchive(interview("TD-CAMERA-UNKNOWN-TRANSCRIPT", {
    driveTranscriptAvailable: true,
    driveTranscriptKind: "unknown",
  })), false);
  assert.equal(isVerifiedInterviewArchive(interview("TD-CAMERA-PARTIAL-SOURCE", {
    sourceTranscriptVerified: false,
  })), false);
  assert.equal(isVerifiedInterviewArchive(interview("TD-CAMERA-UPLOADING", {
    recordingStatus: "uploading",
    driveRecordingIncluded: true,
  })), false);
  assert.equal(isVerifiedInterviewArchive(interview("TD-TEXT", {
    recordingStatus: "not_applicable",
    driveRecordingIncluded: false,
  })), true);
  assert.equal(isVerifiedInterviewArchive(interview("TD-TEXT-NO-DRIVE", {
    recordingStatus: "not_applicable",
    driveStatus: "failed",
    driveRecordingIncluded: false,
  })), false);
  assert.equal(isVerifiedInterviewArchive(interview("TD-STATUS-ONLY", {
    driveStatus: null,
    recordingStatus: "stored",
    driveRecordingIncluded: null,
  })), false);
  assert.equal(isVerifiedInterviewArchive(interview("TD-NOT-COMPLETE", {
    status: "in_progress",
  })), false);
});
