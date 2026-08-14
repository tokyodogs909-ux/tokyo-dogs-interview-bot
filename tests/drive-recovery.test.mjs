import assert from "node:assert/strict";
import test from "node:test";
import {
  isVerifiedInterviewArchive,
  planDriveRecovery,
  planRecordingRecovery,
  summarizeDriveArchives,
} from "../lib/drive-recovery.js";

const now = Date.parse("2026-08-03T06:00:00.000Z");

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
    ...patch,
  };
}

test("Drive recovery retries only absent or cooled-down archives and caps background work", () => {
  const items = [
    interview("TD-MISSING", { driveStatus: null, driveUpdatedAt: null }),
    interview("TD-FAILED-OLD", { driveStatus: "failed", driveUpdatedAt: "2026-08-03T05:40:00.000Z" }),
    interview("TD-FAILED-NEW", { driveStatus: "failed", driveUpdatedAt: "2026-08-03T05:55:00.000Z" }),
    interview("TD-PENDING-NEW", { driveStatus: "pending", driveUpdatedAt: "2026-08-03T05:58:00.000Z" }),
    interview("TD-RUNNING-LIVE", { driveStatus: "running", driveUpdatedAt: "2026-08-03T05:50:00.000Z" }),
    interview("TD-COMPLETE"),
  ];
  assert.deepEqual(planDriveRecovery(items, now), ["TD-MISSING", "TD-FAILED-OLD"]);
});

test("Drive recovery repairs completed camera archives that omitted a now-stored recording", () => {
  const items = [
    interview("TD-VIDEO-MISSING", { driveRecordingIncluded: false }),
    interview("TD-TEXT", { recordingStatus: "not_applicable", driveRecordingIncluded: false }),
    interview("TD-UPLOAD-IN-PROGRESS", { recordingStatus: "uploading", driveRecordingIncluded: false }),
  ];
  assert.deepEqual(planDriveRecovery(items, now), ["TD-VIDEO-MISSING"]);
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
