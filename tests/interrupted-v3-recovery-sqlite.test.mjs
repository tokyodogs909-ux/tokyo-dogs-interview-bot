import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

process.env.OPENAI_API_KEY = "test-key-never-returned";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("sqlite-interrupted-recovery-test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

class SqliteD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.database.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.database.sqlite.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.sqlite.prepare(this.sql).all(...this.values) };
  }
}

class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql) {
    return new SqliteD1Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  close() {
    this.sqlite.close();
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

class MemoryR2 {
  constructor() {
    this.objects = new Map();
    this.etag = 0;
  }

  async put(key, body, options = {}) {
    const existing = this.objects.get(key);
    if (options.onlyIf?.etagDoesNotMatch === "*" && existing) return null;
    if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
    const bytes = typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof Uint8Array
        ? Uint8Array.from(body)
        : new Uint8Array(await new Response(body).arrayBuffer());
    if (options.sha256 && sha256Hex(bytes) !== options.sha256) throw new Error("R2_DIGEST_MISMATCH");
    const object = { bytes, options, etag: `sqlite-etag-${++this.etag}` };
    this.objects.set(key, object);
    return this.metadata(object);
  }

  metadata(object) {
    return {
      etag: object.etag,
      size: object.bytes.byteLength,
      customMetadata: object.options.customMetadata ?? {},
      httpMetadata: object.options.httpMetadata ?? {},
      checksums: object.options.sha256
        ? { sha256: Uint8Array.from(Buffer.from(object.options.sha256, "hex")).buffer }
        : {},
    };
  }

  async head(key) {
    const object = this.objects.get(key);
    return object ? this.metadata(object) : null;
  }

  async get(key, options = {}) {
    const object = this.objects.get(key);
    if (!object) return null;
    const offset = options.range?.offset ?? 0;
    const length = options.range?.length ?? object.bytes.byteLength - offset;
    const bytes = object.bytes.slice(offset, offset + length);
    return {
      ...this.metadata({ ...object, bytes }),
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
}

function scheduled(workerEnv) {
  let promise;
  worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, workerEnv, {
    waitUntil(value) { promise = value; },
    passThroughOnException() {},
  });
  assert.ok(promise instanceof Promise);
  return promise;
}

test("real SQLite executes interrupted v3 claim and final fences atomically", async () => {
  const db = new SqliteD1();
  const recordings = new MemoryR2();
  const env = {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    DB: db,
    RECORDINGS: recordings,
  };
  try {
    await scheduled(env); // create the production runtime schema
    const sessionId = "TD-SQLITE-INTERRUPTED-01";
    const createdAt = "2026-08-14T08:00:00.000Z";
    const updatedAt = "2026-08-14T08:20:00.000Z";
    const expiresAt = "2026-08-14T10:00:00.000Z";
    const retentionUntil = "2027-08-14T08:00:00.000Z";
    const transcript = JSON.stringify([
      { id: "ai-1", speaker: "interviewer", text: "Question", createdAt },
      { id: "candidate-1", speaker: "candidate", text: "Answer", createdAt: updatedAt },
    ]);
    const draftSha256 = sha256Hex(new TextEncoder().encode(transcript));
    db.sqlite.prepare(`INSERT INTO interview_sessions (
      id, access_token_hash, candidate_name, employment, preferred_location,
      consent_version, consented_at, status, recording_status, expires_at,
      retention_until, created_at, updated_at
    ) VALUES (?, ?, '', 'fixture', 'fixture', 'fixture-consent', ?, 'in_progress',
      'uploading', ?, ?, ?, ?)`)
      .run(sessionId, "fixture-token-hash", createdAt, expiresAt, retentionUntil, createdAt, updatedAt);
    db.sqlite.prepare(`INSERT INTO interview_transcript_drafts (
      session_id, mode, transcript_json, transcript_sha256, turn_count, sealed_at,
      created_at, updated_at
    ) VALUES (?, 'voice', ?, ?, 2, NULL, ?, ?)`)
      .run(sessionId, transcript, draftSha256, createdAt, updatedAt);
    for (const [id, eventType, detail] of [
      ["consent", "consent_recorded", { interviewMode: "camera" }],
      ["started", "interview_started", {}],
      ["held", "candidate_requested_stop", { code: "USER_ACTION" }],
    ]) {
      db.sqlite.prepare(`INSERT INTO interview_audit_events (
        id, session_id, event_type, actor_type, detail_json, created_at
      ) VALUES (?, ?, ?, 'candidate', ?, ?)`)
        .run(`${id}-sqlite`, sessionId, eventType, JSON.stringify(detail), updatedAt);
    }
    const state = {
      version: 3,
      sessionId,
      uploadId: "sqliteinterruptedupload01",
      contentType: "video/webm",
      partSize: 4 * 1024 * 1024,
      byteSize: null,
      totalParts: null,
      audioCoverage: null,
      sealedAt: null,
      retentionUntil,
      createdAt: "2026-08-14T08:00:05.000Z",
    };
    await recordings.put(`interviews/${sessionId}/recording-parts/upload.json`, JSON.stringify(state), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sessionId, retentionUntil },
    });
    const part = new Uint8Array(4 * 1024 * 1024).fill(73);
    const partSha256 = sha256Hex(part);
    await recordings.put(`interviews/${sessionId}/recording-parts/part-000`, part, {
      sha256: partSha256,
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        sessionId,
        byteSize: String(part.byteLength),
        sha256: partSha256,
        retentionUntil,
      },
    });

    await scheduled(env);

    const session = db.sqlite.prepare(`SELECT status, recording_status, transcript_json,
      evaluation_json, summary, completed_at FROM interview_sessions WHERE id = ?`).get(sessionId);
    assert.deepEqual({ ...session }, {
      status: "in_progress",
      recording_status: "stored",
      transcript_json: null,
      evaluation_json: null,
      summary: null,
      completed_at: null,
    });
    const artifact = db.sqlite.prepare(`SELECT kind, object_key, content_type, byte_size
      FROM interview_artifacts WHERE session_id = ?`).get(sessionId);
    assert.deepEqual({ ...artifact }, {
      kind: "recording",
      object_key: `interviews/${sessionId}/recording.interrupted-v3.manifest.json`,
      content_type: "video/webm",
      byte_size: 4 * 1024 * 1024,
    });
    const recovered = db.sqlite.prepare(`SELECT COUNT(*) AS count FROM interview_audit_events
      WHERE session_id = ? AND event_type = 'interrupted_recording_recovered'`).get(sessionId);
    assert.equal(recovered.count, 1);
    const draft = db.sqlite.prepare(`SELECT transcript_sha256, turn_count, sealed_at
      FROM interview_transcript_drafts WHERE session_id = ?`).get(sessionId);
    assert.deepEqual({ ...draft }, { transcript_sha256: draftSha256, turn_count: 2, sealed_at: null });
  } finally {
    db.close();
  }
});
