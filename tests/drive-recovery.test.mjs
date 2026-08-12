import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("Drive recovery reclaims an abandoned running archive but ignores unfinished interviews", () => {
  const items = [
    interview("TD-RUNNING-STALE", { driveStatus: "running", driveUpdatedAt: "2026-08-03T05:40:00.000Z" }),
    interview("TD-NOT-COMPLETE", { status: "in_progress", driveStatus: null, driveUpdatedAt: null }),
  ];
  assert.deepEqual(planDriveRecovery(items, now), ["TD-RUNNING-STALE"]);
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
