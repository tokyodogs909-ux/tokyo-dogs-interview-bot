import assert from "node:assert/strict";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("api-test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

const workerEnv = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const workerContext = {
  waitUntil() {},
  passThroughOnException() {},
};

function request(path, init, env = workerEnv) {
  return worker.fetch(new Request(`http://localhost${path}`, init), env, workerContext);
}

class FakeD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO interview_sessions")) {
      const [id, accessTokenHash, employment, preferredLocation, consentVersion,
        consentedAt, expiresAt, retentionUntil, createdAt, updatedAt] = this.values;
      this.database.sessions.set(id, {
        id,
        access_token_hash: accessTokenHash,
        employment,
        preferred_location: preferredLocation,
        consent_version: consentVersion,
        consented_at: consentedAt,
        status: "created",
        recording_status: "not_started",
        expires_at: expiresAt,
        retention_until: retentionUntil,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    } else if (this.sql.startsWith("INSERT INTO interview_artifacts")) {
      this.database.artifacts.push(this.values);
    } else if (this.sql.startsWith("UPDATE interview_sessions SET recording_status")) {
      const [, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session) session.recording_status = "stored";
    } else if (this.sql.startsWith("UPDATE interview_sessions SET status = 'evaluation_pending'")) {
      const [transcriptJson, updatedAt, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session) Object.assign(session, { status: "evaluation_pending", transcript_json: transcriptJson, updated_at: updatedAt });
    } else if (this.sql.startsWith("UPDATE interview_sessions SET status = 'completed'")) {
      const [transcriptJson, evaluationJson, summary, completedAt, updatedAt, id] = this.values;
      const session = this.database.sessions.get(id);
      if (session) Object.assign(session, {
        status: "completed",
        transcript_json: transcriptJson,
        evaluation_json: evaluationJson,
        summary,
        completed_at: completedAt,
        updated_at: updatedAt,
      });
    } else if (this.sql.startsWith("INSERT INTO interview_human_reviews")) {
      const [, sessionId, reviewerName, videoScoresJson, overallNote, , updatedAt] = this.values;
      this.database.humanReviews.set(`${sessionId}:${reviewerName}`, {
        reviewer_name: reviewerName,
        video_scores_json: videoScoresJson,
        overall_note: overallNote,
        updated_at: updatedAt,
      });
    }
    return { success: true };
  }

  async first() {
    if (this.sql.startsWith("SELECT id, access_token_hash")) {
      return this.database.sessions.get(this.values[0]) ?? null;
    }
    if (this.sql.startsWith("SELECT id, employment, preferred_location")) {
      return this.database.sessions.get(this.values[0]) ?? null;
    }
    if (this.sql.startsWith("SELECT id FROM interview_sessions")) {
      const session = this.database.sessions.get(this.values[0]);
      return session ? { id: session.id } : null;
    }
    if (this.sql.startsWith("SELECT object_key, content_type, byte_size")) {
      const sessionId = this.values[0];
      const values = this.database.artifacts.find((item) => item[1] === sessionId);
      return values ? { object_key: values[2], content_type: values[3], byte_size: values[4] } : null;
    }
    return null;
  }

  async all() {
    if (this.sql.startsWith("SELECT reviewer_name, video_scores_json")) {
      const sessionId = this.values[0];
      return {
        results: [...this.database.humanReviews.entries()]
          .filter(([key]) => key.startsWith(`${sessionId}:`))
          .map(([, value]) => value),
      };
    }
    return { results: [] };
  }

}

class FakeD1 {
  constructor() {
    this.sessions = new Map();
    this.artifacts = [];
    this.humanReviews = new Map();
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class FakeR2 {
  constructor() {
    this.objects = new Map();
  }

  async put(key, body, options) {
    this.objects.set(key, { body, options });
    return { etag: "test-etag" };
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { body: object.body, etag: "test-etag" };
  }

}

async function createTestInterviewSession(env, employment = "正社員", location = "越谷店") {
  const response = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employment, location, consent: true }),
  }, env);
  assert.equal(response.status, 201);
  return response.json();
}

test("health endpoint reports server credential presence without returning the key", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const response = await request("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: true });
  assert.equal(response.headers.get("permissions-policy"), "camera=(self), microphone=(self), display-capture=(self)");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("interview session uses a one-time bearer token and stores a recording without a candidate name", async () => {
  process.env.INTERVIEW_REVIEW_TOKEN_KASAMA = "kasama-review-secret";
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      employment: "正社員",
      location: "越谷店",
      consent: true,
    }),
  }, env);
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 201);
  assert.match(session.sessionId, /^TD-[A-Z0-9-]{6,40}$/);
  assert.equal(typeof session.accessToken, "string");
  assert.ok(session.accessToken.length > 20);
  assert.notEqual(database.sessions.get(session.sessionId).access_token_hash, session.accessToken);
  assert.equal(session.storagePolicy, "manual-deletion-only");
  assert.equal(database.sessions.get(session.sessionId).retention_until, "manual-deletion-only");

  const recordingBody = new TextEncoder().encode("small-webm-fixture");
  const uploadResponse = await request("/api/interviews/recording", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-Interview-Session": session.sessionId,
      "Content-Type": "video/webm",
      "Content-Length": String(recordingBody.byteLength),
    },
    body: recordingBody,
  }, env);
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200);
  assert.equal(upload.stored, true);
  assert.equal("objectKey" in upload, false);
  const storedObjectKey = `interviews/${session.sessionId}/recording.webm`;
  assert.equal(recordings.objects.has(storedObjectKey), true);
  assert.equal(recordings.objects.get(storedObjectKey).options.customMetadata.storagePolicy, "manual-deletion-only");
  assert.equal(database.sessions.get(session.sessionId).recording_status, "stored");

  const unauthorized = await request("/api/interviews/recording", {
    method: "POST",
    headers: {
      "X-Interview-Session": session.sessionId,
      "Content-Type": "video/webm",
      "Content-Length": String(recordingBody.byteLength),
    },
    body: recordingBody,
  }, env);
  assert.equal(unauthorized.status, 401);
  assert.equal(worker.scheduled, undefined);
  assert.equal(recordings.objects.has(storedObjectKey), true);

  const protectedRecording = await request(`/api/staff/recording?sessionId=${session.sessionId}`, {}, env);
  assert.equal(protectedRecording.status, 401);
  const staffRecording = await request(`/api/staff/recording?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
    },
  }, env);
  assert.equal(staffRecording.status, 200);
  assert.equal(staffRecording.headers.get("content-type"), "video/webm");
  assert.equal(await staffRecording.text(), "small-webm-fixture");
});

test("realtime endpoint mints a short-lived token with the interview safety settings", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const session = await createTestInterviewSession(env);
  const originalFetch = globalThis.fetch;
  let capturedBody;
  let capturedAuthorization;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/realtime/client_secrets");
      capturedBody = JSON.parse(init.body);
      capturedAuthorization = init.headers.Authorization;
      return Response.json({
        value: "ek_test_ephemeral",
        expires_at: 9999999999,
        session: { model: "gpt-realtime-2.1" },
      });
    };

    const response = await request("/api/realtime/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
      }),
    }, env);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.value, "ek_test_ephemeral");
    assert.equal(payload.model, "gpt-realtime-2.1");
    assert.equal(capturedAuthorization, "Bearer test-key-never-returned");
    assert.equal(capturedBody.session.audio.input.turn_detection.type, "semantic_vad");
    assert.equal(capturedBody.session.audio.input.turn_detection.eagerness, "low");
    assert.equal(capturedBody.session.audio.input.turn_detection.create_response, false);
    assert.equal(capturedBody.session.audio.input.turn_detection.interrupt_response, false);
    assert.equal(capturedBody.session.max_output_tokens, 1400);
    assert.match(capturedBody.session.instructions, /退職・転職を考えた理由/);
    assert.match(capturedBody.session.instructions, /なぜそれをやろうと思ったのですか/);
    assert.match(capturedBody.session.instructions, /決め手は何でしたか/);
    assert.match(capturedBody.session.instructions, /私の理解が合っているか/);
    assert.match(capturedBody.session.instructions, /長い回答は/);
    assert.match(capturedBody.session.instructions, /ドッグトレーナー、ペット業界の中でも東京DOGS/);
    assert.match(capturedBody.session.instructions, /清掃、安全管理、飼い主対応、記録、報告/);
    assert.match(capturedBody.session.instructions, /既存資料の「違和感」は自動不採用に使わない/);
    assert.match(capturedBody.session.instructions, /笑顔を含む表情、話を聞く反応、姿勢、応対態度/);
    assert.match(capturedBody.session.instructions, /犬を通して、人々を幸せに/);
    assert.match(capturedBody.session.instructions, /仕事選びの基準は、まず本人の言葉で三つ/);
    assert.match(capturedBody.session.instructions, /希望店舗以外への配属や他店舗ヘルプが実際に発生する可能性/);
    assert.match(capturedBody.session.instructions, /普通自動車免許、送迎、当直/);
    assert.match(capturedBody.session.instructions, /通常数日〜1週間、長い場合は10日程度/);
    assert.match(capturedBody.session.instructions, /既存資料の「両親の反応」「家族構成」「家族間の仲」「住まい」は質問しない/);
    assert.doesNotMatch(capturedBody.session.instructions, /笠間・山本・松尾/);
    assert.equal(capturedBody.session.tools[0].name, "complete_interview");
    assert.deepEqual(
      capturedBody.session.tools[0].parameters.properties.topics_covered.items.enum,
      Array.from({ length: 15 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`),
    );
    assert.doesNotMatch(JSON.stringify(payload), /test-key-never-returned/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("realtime endpoint distinguishes missing quota from temporary congestion", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const session = await createTestInterviewSession(env);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(
      { error: { type: "insufficient_quota", code: "insufficient_quota" } },
      { status: 429 },
    );
    const response = await request("/api/realtime/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
      }),
    }, env);
    const payload = await response.json();
    assert.equal(response.status, 429);
    assert.match(payload.error, /オンライン一次面接の接続設定が完了していません/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("realtime token endpoint never bypasses interview authentication when storage is unavailable", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const originalFetch = globalThis.fetch;
  let upstreamCalled = false;
  try {
    globalThis.fetch = async () => {
      upstreamCalled = true;
      return Response.json({ value: "must-not-be-issued" });
    };
    const response = await request("/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "TD-TEST-ABC123",
        employment: "正社員",
        location: "越谷店",
      }),
    });
    assert.equal(response.status, 401);
    assert.equal(upstreamCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same-origin realtime call authorizes the exact new interview session and proxies SDP", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  const database = new FakeD1();
  const env = { ...workerEnv, DB: database };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  const session = await sessionResponse.json();
  const originalFetch = globalThis.fetch;
  let capturedSession;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/realtime/calls");
      assert.equal(init.headers.Authorization, "Bearer test-key-never-returned");
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("sdp"), "v=0\r\no=test-offer\r\n");
      capturedSession = JSON.parse(init.body.get("session"));
      return new Response("v=0\r\no=test-answer\r\n", {
        status: 200,
        headers: { "Content-Type": "application/sdp" },
      });
    };
    const response = await request("/api/realtime/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/sdp",
        "X-Interview-Session": session.sessionId,
      },
      body: "v=0\r\no=test-offer\r\n",
    }, env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/sdp");
    assert.equal(await response.text(), "v=0\r\no=test-answer\r\n");
    assert.equal(capturedSession.model, "gpt-realtime-2.1");
    assert.equal(capturedSession.audio.input.turn_detection.type, "semantic_vad");

    const rejected = await request("/api/realtime/call", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-session-token",
        "Content-Type": "application/sdp",
        "X-Interview-Session": session.sessionId,
      },
      body: "v=0\r\no=test-offer\r\n",
    }, env);
    assert.equal(rejected.status, 401);
    assert.match(await rejected.text(), /TD-CONN-AUTH/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const dimensionNames = [
  "理念・志望動機",
  "素直さ・改善行動",
  "責任感・誠実性",
  "接客・対話力",
  "学習意欲・継続力",
  "犬と人への安全配慮",
  "勤務条件の適合性",
];

const candidateTurns = dimensionNames.map((name, index) => ({
  id: `candidate-${index + 1}`,
  speaker: "candidate",
  createdAt: new Date(2026, 6, 29, 9, index).toISOString(),
  text: `${name}について、私は状況を確認し、周囲へ報告してから具体的に行動しました。その結果を振り返り、次回の改善策まで決めて継続しました。`,
}));

function modelEvaluation({ invalidEvidence = false } = {}) {
  return {
    recommendation: "next_interview_recommended",
    summary: "職務に関連する具体的な経験を確認できました。",
    dimensions: dimensionNames.map((name, index) => ({
      name,
      score: 4,
      confidence: "medium",
      rationale: "具体的な行動と改善を説明しています。",
      evidence: [{
        quote: invalidEvidence && index === 0
          ? "文字起こしに存在しない引用"
          : candidateTurns[index].text.slice(0, 42),
        turnId: candidateTurns[index].id,
        relevance: "本人の行動を示す回答です。",
      }],
    })),
    strengths: ["改善行動を具体的に説明した"],
    concerns: [],
    contradictions: [],
    missingTopics: [],
    conditions: ["勤務条件は採用担当者が最終確認する"],
  };
}

async function runEvaluationApi(invalidEvidence) {
  const database = new FakeD1();
  const recordings = new FakeR2();
  const env = { ...workerEnv, DB: database, RECORDINGS: recordings };
  const sessionResponse = await request("/api/interviews/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employment: "正社員", location: "越谷店", consent: true }),
  }, env);
  const session = await sessionResponse.json();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(init.body);
      assert.equal(body.store, false);
      assert.equal(body.model, "gpt-5.6-sol");
      assert.equal(body.text.format.strict, true);
      assert.match(body.instructions, /総合評価は過去応募者との順位比較ではなく/);
      assert.match(body.instructions, /部活経験の有無そのものは評価しない/);
      return Response.json({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify(modelEvaluation({ invalidEvidence })),
          }],
        }],
      });
    };
    const response = await request("/api/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        employment: "正社員",
        location: "越谷店",
        transcript: candidateTurns,
      }),
    }, env);
    return { response, database, env, session };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("candidate evaluation endpoint stores a verified result without disclosing it", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  process.env.INTERVIEW_REVIEW_TOKEN_KASAMA = "kasama-review-secret";
  const { response, env, session } = await runEvaluationApi(false);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.stored, true);
  assert.equal(payload.humanReviewRequired, true);
  assert.equal("evaluation" in payload, false);

  const unauthorized = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {}, env);
  assert.equal(unauthorized.status, 401);
  const staffResponse = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
    },
  }, env);
  const staffPayload = await staffResponse.json();
  assert.equal(staffResponse.status, 200);
  assert.equal(staffPayload.review.evaluation.recommendation, "next_interview_recommended");
  assert.equal(staffPayload.review.evaluation.evidenceValidationWarnings.length, 0);
  assert.equal(staffPayload.review.evaluation.dimensions.every((item) => item.evidence[0].verified), true);
  assert.deepEqual(staffPayload.review.authorizedReviewers, ["笠間", "山本"]);

  const videoScores = [
    { name: "接客時の表情・姿勢・態度", score: 4, note: "ロールプレイ中の応対を確認" },
    { name: "接客ロールプレイの進行", score: 4, note: "順序立てて説明" },
    { name: "安全説明の具体性", score: 5, note: "相談と安全確保を説明" },
    { name: "相手への配慮と分かりやすさ", score: 4, note: "責めない説明" },
  ];
  const saveReview = await request("/api/staff/review", {
    method: "POST",
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId: session.sessionId, scores: videoScores, overallNote: "人による確認" }),
  }, env);
  assert.equal(saveReview.status, 200);
  const refreshed = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
    },
  }, env);
  const refreshedPayload = await refreshed.json();
  assert.equal(refreshedPayload.review.humanReviews[0].reviewerName, "笠間");
  assert.equal(refreshedPayload.review.humanReviews[0].videoScores.length, 4);
});

test("staff-only evaluation drops invented evidence and forces human review", async () => {
  process.env.OPENAI_API_KEY = "test-key-never-returned";
  process.env.INTERVIEW_REVIEW_TOKEN_KASAMA = "kasama-review-secret";
  const { response, env, session } = await runEvaluationApi(true);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal("evaluation" in payload, false);
  const staffResponse = await request(`/api/staff/interview?sessionId=${session.sessionId}`, {
    headers: {
      Authorization: "Bearer kasama-review-secret",
      "X-Interview-Reviewer": "kasama",
    },
  }, env);
  const staffPayload = await staffResponse.json();
  assert.equal(staffPayload.review.evaluation.recommendation, "human_review");
  assert.equal(staffPayload.review.evaluation.dimensions[0].score, null);
  assert.equal(staffPayload.review.evaluation.dimensions[0].evidence.length, 0);
  assert.ok(staffPayload.review.evaluation.evidenceValidationWarnings.length >= 1);
});
