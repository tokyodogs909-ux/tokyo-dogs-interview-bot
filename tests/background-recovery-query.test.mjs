import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function driveRecoveryQuery(source) {
  const match = source.match(
    /const candidates = await db\.prepare\(`([\s\S]*?)`\)\n\s+\.bind\(failedBefore, pendingBefore, integrityBefore\)/,
  );
  assert.ok(match, "the exact production Drive recovery query must remain discoverable");
  return match[1];
}

function technicalEvidenceDriveQuery(source) {
  const start = source.indexOf("export async function findNextInterviewTechnicalEvidenceDriveSession()");
  const end = source.indexOf("export async function getInterviewRecordingChunk", start);
  assert.ok(start >= 0 && end > start, "the technical-evidence selector must remain discoverable");
  const match = source.slice(start, end).match(
    /const row = await db\.prepare\(`([\s\S]*?)`\)\n\s+\.bind\(failedBefore, pendingBefore, integrityBefore\)/,
  );
  assert.ok(match, "the exact production technical-evidence query must remain discoverable");
  return match[1];
}

function insertSession(database, id, transcript, createdAt) {
  database.prepare(`INSERT INTO interview_sessions (
    id, status, recording_status, transcript_json, created_at, completed_at
  ) VALUES (?, 'completed', 'stored', ?, ?, ?)`).run(
    id,
    JSON.stringify(transcript),
    createdAt,
    createdAt,
  );
}

test("global Drive recovery skips more than 25 invalid rows without starving valid archives", async () => {
  const source = await readFile(new URL("../lib/interview-persistence.ts", import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE interview_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      recording_status TEXT NOT NULL,
      transcript_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX interview_sessions_status_idx ON interview_sessions (status);
    CREATE TABLE interview_audit_events (
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail_json TEXT
    );
    CREATE TABLE interview_external_syncs (
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      manifest_json TEXT
    );
  `);

  for (let index = 0; index < 25; index += 1) {
    insertSession(database, `TD-BAD-${String(index).padStart(4, "0")}`, [{
      id: `recorded-fallback-answer-${index + 1}`,
      speaker: "candidate",
      text: "legacy placeholder",
    }], "2026-07-01T00:00:00.000Z");
  }
  insertSession(database, "TD-PRIMITIVE-01", [null, "malformed"], "2026-07-02T00:00:00.000Z");
  insertSession(database, "TD-VALID-0001", [{
    id: "candidate-answer-1",
    speaker: "candidate",
    text: "actual answer",
  }], "2026-07-03T00:00:00.000Z");
  insertSession(database, "TD-GAP-000001", [{
    id: "candidate-answer-1",
    speaker: "candidate",
    text: "partial realtime answer",
  }], "2026-07-04T00:00:00.000Z");
  database.prepare(`INSERT INTO interview_audit_events (
    session_id, event_type, detail_json
  ) VALUES (?, 'transcription_failed', ?)`).run(
    "TD-GAP-000001",
    JSON.stringify({ code: "TRANSCRIPTION_FAILED" }),
  );
  insertSession(database, "TD-RECOVERED-01", [{
    id: "recorded-transcribed-answer-1",
    speaker: "candidate",
    text: "actual recovered answer",
  }], "2026-07-05T00:00:00.000Z");
  database.prepare(`INSERT INTO interview_audit_events (
    session_id, event_type, detail_json
  ) VALUES (?, 'transcription_failed', ?)`).run(
    "TD-RECOVERED-01",
    JSON.stringify({ code: "TRANSCRIPTION_FAILED" }),
  );

  const rows = database.prepare(driveRecoveryQuery(source)).all(
    "2026-08-12T00:00:00.000Z",
    "2026-08-12T00:05:00.000Z",
    "2026-08-11T00:00:00.000Z",
  );
  assert.deepEqual(rows.map((row) => row.id), ["TD-VALID-0001", "TD-RECOVERED-01"]);
  assert.equal(rows.some((row) => row.id.startsWith("TD-BAD-")), false);
  assert.equal(rows.some((row) => row.id === "TD-GAP-000001"), false);
  database.close();
});

test("technical evidence recovery selects only stored empty-ASR voice drafts without harmful holds", async () => {
  const source = await readFile(new URL("../lib/interview-persistence.ts", import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE interview_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      recording_status TEXT NOT NULL,
      transcript_json TEXT,
      evaluation_json TEXT,
      summary TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE interview_transcript_drafts (
      session_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      transcript_json TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      sealed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE interview_artifacts (
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE TABLE interview_audit_events (
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail_json TEXT
    );
    CREATE TABLE interview_evaluation_claims (session_id TEXT PRIMARY KEY);
    CREATE TABLE interview_external_syncs (
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      manifest_json TEXT
    );
  `);
  const turns = JSON.stringify([
    { id: "assistant-1", speaker: "interviewer", text: "question" },
    { id: "candidate-1", speaker: "candidate", text: "answer" },
  ]);
  const insert = (id, options = {}) => {
    database.prepare(`INSERT INTO interview_sessions (
      id, status, recording_status, transcript_json, evaluation_json, summary,
      completed_at, updated_at
    ) VALUES (?, 'in_progress', ?, NULL, NULL, NULL, NULL, ?)`)
      .run(id, options.recordingStatus ?? "stored", "2026-08-19T00:00:00Z");
    database.prepare(`INSERT INTO interview_transcript_drafts (
      session_id, mode, transcript_json, turn_count, sealed_at, updated_at
    ) VALUES (?, 'voice', ?, 2, ?, '2026-08-19T00:00:00Z')`)
      .run(id, turns, options.sealed ? "2026-08-19T00:01:00Z" : null);
    if (!options.noRecording) {
      database.prepare("INSERT INTO interview_artifacts (session_id, kind) VALUES (?, 'recording')").run(id);
    }
    database.prepare(`INSERT INTO interview_audit_events (
      session_id, event_type, detail_json
    ) VALUES (?, 'transcription_failed', ?)`)
      .run(id, JSON.stringify({ code: options.code ?? "TRANSCRIPTION_EMPTY" }));
    if (options.hold) {
      database.prepare("INSERT INTO interview_audit_events (session_id, event_type, detail_json) VALUES (?, ?, '{}')")
        .run(id, options.hold);
    }
  };
  insert("TD-TECH-VALID-01");
  insert("TD-TECH-IDMISS-1", { code: "TRANSCRIPTION_ID_MISSING" });
  insert("TD-TECH-STOPPED-1", { hold: "candidate_requested_stop" });
  insert("TD-TECH-NORECORD", { noRecording: true });
  insert("TD-TECH-SEALED-01", { sealed: true });

  const selected = database.prepare(technicalEvidenceDriveQuery(source)).get(
    "2026-08-20T00:00:00Z",
    "2026-08-20T00:00:00Z",
    "2026-08-20T00:00:00Z",
  );
  assert.equal(selected.id, "TD-TECH-VALID-01");
  database.close();
});
