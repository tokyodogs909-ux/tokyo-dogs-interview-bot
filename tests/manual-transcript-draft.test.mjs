import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DIARIZATION_MODEL,
  REQUEST_TIMEOUT_MS,
  approvedLegacySessionIds,
  buildDraftEnvelope,
  parseArguments,
  planAudioChunkCount,
  processPreparedChunks,
  readbackPrivateDraft,
  requestDraftFromRepairEndpoint,
  selectProbedDuration,
  validateDiarizedPayload,
  writePrivateDraft,
} from "../scripts/manual-transcript-draft.mjs";

const SYNTHETIC_SESSION_IDS = [
  "TD-AAAA0001-BBBBB01",
  "TD-AAAA0002-BBBBB02",
  "TD-AAAA0003-BBBBB03",
];
const ALLOWLIST_ENV = "INTERVIEW_MANUAL_REPAIR_SESSION_IDS";
let previousAllowlist;

test.beforeEach(() => {
  previousAllowlist = process.env[ALLOWLIST_ENV];
  process.env[ALLOWLIST_ENV] = SYNTHETIC_SESSION_IDS.join(",");
});

test.afterEach(() => {
  if (previousAllowlist === undefined) delete process.env[ALLOWLIST_ENV];
  else process.env[ALLOWLIST_ENV] = previousAllowlist;
});

function sampleDraft() {
  return buildDraftEnvelope({
    generatedAt: "2026-08-13T03:18:00.000Z",
    sessionIdHash: "a".repeat(32),
    sourceSha256: "b".repeat(64),
    sourceByteSize: 1024,
    sourceDurationSeconds: 42,
    chunks: [{
      index: 1,
      offsetSeconds: 0,
      durationSeconds: 42,
      audioSha256: "c".repeat(64),
      audioByteSize: 256,
      segments: [{ speaker: "A", start: 0, end: 1.5, text: "確認用の下書き" }],
    }],
  });
}

function preparedChunks(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    path: `/private/chunk-${index + 1}.mp3`,
    offsetSeconds: index * 240,
    durationSeconds: 240,
    audioSha256: String(index + 1).repeat(64),
    audioByteSize: 100 + index,
  }));
}

test("manual draft CLI requires an explicit paid API acknowledgement", () => {
  assert.throws(() => parseArguments([
    "--session-id", SYNTHETIC_SESSION_IDS[0],
    "--input", "/private/source.webm",
    "--output", "/private/draft.json",
  ]), /PAID_API_CONFIRMATION_REQUIRED/);
  const dryRun = parseArguments([
    "--dry-run",
    "--session-id", SYNTHETIC_SESSION_IDS[0],
    "--input", "/private/source.webm",
    "--output", "/private/draft.json",
  ]);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.yesPaidApi, false);
  assert.throws(() => parseArguments([
    "--dry-run",
    "--session-id", "TD-TEST0000-OTHER01",
    "--input", "/private/source.webm",
    "--output", "/private/draft.json",
  ]), /SESSION_NOT_APPROVED_FOR_MANUAL_DRAFT/);
});

test("manual draft allowlist requires exactly three unique valid secret session IDs", () => {
  assert.deepEqual([...approvedLegacySessionIds()], SYNTHETIC_SESSION_IDS);
  delete process.env[ALLOWLIST_ENV];
  assert.throws(() => approvedLegacySessionIds(), /MANUAL_REPAIR_SESSION_ALLOWLIST_INVALID/);
  process.env[ALLOWLIST_ENV] = `${SYNTHETIC_SESSION_IDS[0]},${SYNTHETIC_SESSION_IDS[0]},${SYNTHETIC_SESSION_IDS[2]}`;
  assert.throws(() => approvedLegacySessionIds(), /MANUAL_REPAIR_SESSION_ALLOWLIST_INVALID/);
  process.env[ALLOWLIST_ENV] = `${SYNTHETIC_SESSION_IDS[0]},INVALID,${SYNTHETIC_SESSION_IDS[2]}`;
  assert.throws(() => approvedLegacySessionIds(), /MANUAL_REPAIR_SESSION_ALLOWLIST_INVALID/);
});

test("approved legacy recordings are segmented by four-minute duration", () => {
  assert.equal(planAudioChunkCount(1), 1);
  assert.equal(planAudioChunkCount(240), 1);
  assert.equal(planAudioChunkCount(241), 2);
  assert.equal(planAudioChunkCount(15 * 60), 4);
  assert.equal(planAudioChunkCount(22 * 60), 6);
  assert.throws(() => planAudioChunkCount((24 * 60) + 1), /MEDIA_DURATION_INVALID/);
});

test("duration falls back from N/A format and stream metadata to the final audio packet", () => {
  assert.equal(selectProbedDuration("N/A", "N/A", 918.508), 918.508);
  assert.equal(selectProbedDuration("N/A", "1232.271", 1232.3), 1232.271);
  assert.equal(selectProbedDuration("1307.163", "N/A", 1307.2), 1307.163);
  assert.throws(() => selectProbedDuration("N/A", "N/A", null), /MEDIA_DURATION_INVALID/);
});

test("diarized payload validation retains only bounded speaker segments", () => {
  assert.deepEqual(validateDiarizedPayload({
    model: DIARIZATION_MODEL,
    segments: [
      { speaker: "A", start: 0, end: 1.2, text: " 質問です。 " },
      { speaker: "B", start: 1.3, end: 3, text: "回答です。" },
    ],
  }), [
    { speaker: "A", start: 0, end: 1.2, text: "質問です。" },
    { speaker: "B", start: 1.3, end: 3, text: "回答です。" },
  ]);
  assert.throws(() => validateDiarizedPayload({ model: DIARIZATION_MODEL, segments: [] }), /DIARIZED_RESPONSE_EMPTY/);
  assert.throws(() => validateDiarizedPayload({
    model: DIARIZATION_MODEL,
    segments: [{ speaker: "A", start: 0, end: 1, text: "本文", unexpected: true }],
  }), /DIARIZED_RESPONSE_INVALID/);
});

test("local CLI has no direct OpenAI credential or API route", async () => {
  const source = await readFile(new URL("../scripts/manual-transcript-draft.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /OPENAI_API_KEY/);
  assert.doesNotMatch(source, /api\.openai\.com/);
  assert.match(source, /INTERVIEW_MANUAL_DRAFT_ENDPOINT/);
  assert.match(source, /INTERVIEW_MANUAL_REPAIR_TOKEN/);
});

test("manual draft CLI does not reconstruct questions or provide a production writer", async () => {
  const source = await readFile(new URL("../scripts/manual-transcript-draft.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /RECORDED_FALLBACK_QUESTIONS/);
  assert.doesNotMatch(source, /recorded-fallback-question-/);
  assert.doesNotMatch(source, /wrangler|d1\s+execute|drive\/v3|googleapis\.com/i);
  assert.match(source, /INTERVIEW_MANUAL_REPAIR_SESSION_IDS/);
});

test("manual draft endpoint receives raw audio with exact provenance headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-transcript-test-"));
  const source = join(directory, "audio.mp3");
  const originalFetch = globalThis.fetch;
  const audio = new Uint8Array([1, 2, 3, 4]);
  let captured;
  try {
    await writeFile(source, audio, { mode: 0o600 });
    globalThis.fetch = async (url, init) => {
      captured = { url, init };
      return Response.json({
        model: DIARIZATION_MODEL,
        segments: [{ speaker: "A", start: 0, end: 1, text: "下書き" }],
      });
    };
    const result = await requestDraftFromRepairEndpoint({
      path: source,
      index: 1,
      endpoint: "https://recruit.example.test/api/internal/manual-transcript-draft",
      repairToken: "t".repeat(43),
      sessionId: SYNTHETIC_SESSION_IDS[0],
    });
    assert.equal(captured.url, "https://recruit.example.test/api/internal/manual-transcript-draft");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers.Authorization, `Bearer ${"t".repeat(43)}`);
    assert.equal(captured.init.headers["Content-Type"], "audio/mpeg");
    assert.equal(captured.init.headers["Content-Length"], "4");
    assert.equal(captured.init.headers["X-Interview-Session-Id"], SYNTHETIC_SESSION_IDS[0]);
    assert.equal(captured.init.headers["X-Interview-Audio-Sha256"],
      "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a");
    assert.equal(captured.init.headers["X-Interview-Audio-Index"], "1");
    assert.deepEqual(new Uint8Array(captured.init.body), audio);
    assert.deepEqual(result, [{ speaker: "A", start: 0, end: 1, text: "下書き" }]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual draft endpoint never retries an HTTP or transport failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-transcript-test-"));
  const source = join(directory, "audio.mp3");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    await writeFile(source, new Uint8Array([1, 2, 3, 4]), { mode: 0o600 });
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({ error: { code: "upstream_unavailable" } }, { status: 503 });
    };
    await assert.rejects(() => requestDraftFromRepairEndpoint({
      path: source,
      index: 1,
      endpoint: "https://recruit.example.test/api/internal/manual-transcript-draft",
      repairToken: "t".repeat(43),
      sessionId: SYNTHETIC_SESSION_IDS[0],
    }), /OPENAI_TRANSCRIPTION_FAILED_UPSTREAM_UNAVAILABLE/);
    assert.equal(calls, 1);

    globalThis.fetch = async () => {
      calls += 1;
      throw new TypeError("ambiguous transport failure");
    };
    await assert.rejects(() => requestDraftFromRepairEndpoint({
      path: source,
      index: 1,
      endpoint: "https://recruit.example.test/api/internal/manual-transcript-draft",
      repairToken: "t".repeat(43),
      sessionId: SYNTHETIC_SESSION_IDS[0],
    }), /OPENAI_TRANSCRIPTION_TRANSPORT_FAILED/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("streamed HTTP 200 error JSON is recognized once after leading whitespace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-transcript-test-"));
  const source = join(directory, "audio.mp3");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    await writeFile(source, new Uint8Array([1, 2, 3, 4]), { mode: 0o600 });
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(" \n \n{\"error\":{\"code\":\"manual_repair_upstream_unavailable\"}}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await assert.rejects(() => requestDraftFromRepairEndpoint({
      path: source,
      index: 1,
      endpoint: "https://recruit.example.test/api/internal/manual-transcript-draft",
      repairToken: "t".repeat(43),
      sessionId: SYNTHETIC_SESSION_IDS[0],
    }), /OPENAI_TRANSCRIPTION_FAILED_MANUAL_REPAIR_UPSTREAM_UNAVAILABLE/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("client timeout leaves upload and server-finalization margin without enabling retries", async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 240_000);
  const source = await readFile(new URL("../scripts/manual-transcript-draft.mjs", import.meta.url), "utf8");
  assert.match(source, /REQUEST_TIMEOUT_MS = 240 \* 1000/);
  assert.doesNotMatch(source, /for\s*\([^)]*attempt|while\s*\([^)]*attempt|retryDelay|retryAfter/);
});

test("draft artifact is fail-closed and private on disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-transcript-test-"));
  const destination = join(directory, "draft.json");
  try {
    const draft = sampleDraft();
    assert.equal(draft.model, DIARIZATION_MODEL);
    assert.deepEqual(draft.productionWriteGuard, {
      safeToWriteProduction: false,
      d1Written: false,
      googleDriveWritten: false,
      evaluationTriggered: false,
    });
    const written = await writePrivateDraft(destination, draft);
    assert.equal(written.mode, "0600");
    assert.equal(written.segmentCount, 1);
    const readback = await readbackPrivateDraft(destination);
    assert.equal(readback.state, "draft_readback_verified");
    assert.equal(readback.productionWriteAllowed, false);
    assert.equal(readback.sha256, written.sha256);
    assert.match(await readFile(destination, "utf8"), /human_verification_required/);
    await assert.rejects(() => writePrivateDraft(destination, draft), /OUTPUT_ALREADY_EXISTS/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readback refuses a permissive or malformed draft", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-transcript-test-"));
  const destination = join(directory, "draft.json");
  try {
    await writeFile(destination, JSON.stringify(sampleDraft()), { mode: 0o644 });
    await assert.rejects(() => readbackPrivateDraft(destination), /DRAFT_PERMISSIONS_INVALID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint saves each successful chunk and explicit resume skips it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-transcript-test-"));
  const destination = join(directory, "draft.json");
  const sent = [];
  const base = {
    destination,
    sessionIdHash: "a".repeat(32),
    sourceSha256: "b".repeat(64),
    sourceByteSize: 10_000,
    sourceDurationSeconds: 720,
    preparedChunks: preparedChunks(),
  };
  try {
    await assert.rejects(() => processPreparedChunks({
      ...base,
      resumeConfirmed: false,
      requestChunk: async (chunk) => {
        sent.push(chunk.index);
        if (chunk.index === 2) throw new Error("OPENAI_TRANSCRIPTION_FAILED_HTTP_503");
        return [{ speaker: "A", start: 0, end: 1, text: `下書き${chunk.index}` }];
      },
    }), (error) => error.message === "OPENAI_TRANSCRIPTION_FAILED_HTTP_503" && error.partialSaved === true);
    assert.deepEqual(sent, [1, 2]);
    const checkpointPath = `${destination}.partial`;
    const partial = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal((await lstat(checkpointPath)).mode & 0o777, 0o600);
    assert.deepEqual(partial.chunks.map((chunk) => chunk.index), [1]);

    await assert.rejects(() => processPreparedChunks({
      ...base,
      resumeConfirmed: false,
      requestChunk: async () => assert.fail("plain rerun must not call endpoint"),
    }), /PARTIAL_CHECKPOINT_REQUIRES_EXPLICIT_RESUME/);

    sent.length = 0;
    const resumed = await processPreparedChunks({
      ...base,
      resumeConfirmed: true,
      requestChunk: async (chunk) => {
        sent.push(chunk.index);
        return [{ speaker: "A", start: 0, end: 1, text: `下書き${chunk.index}` }];
      },
    });
    assert.deepEqual(sent, [2, 3]);
    assert.deepEqual(resumed.chunks.map((chunk) => chunk.index), [1, 2, 3]);
    const readback = await readbackPrivateDraft(checkpointPath);
    assert.equal(readback.state, "partial_checkpoint_readback_verified");
    assert.deepEqual(readback.completedChunkIndexes, [1, 2, 3]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint resume refuses source mismatch and permissive permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-transcript-test-"));
  const destination = join(directory, "draft.json");
  const base = {
    destination,
    sessionIdHash: "a".repeat(32),
    sourceSha256: "b".repeat(64),
    sourceByteSize: 10_000,
    sourceDurationSeconds: 240,
    preparedChunks: preparedChunks(1),
  };
  try {
    await processPreparedChunks({
      ...base,
      resumeConfirmed: false,
      requestChunk: async () => [{ speaker: "A", start: 0, end: 1, text: "下書き" }],
    });
    await assert.rejects(() => processPreparedChunks({
      ...base,
      sourceSha256: "c".repeat(64),
      resumeConfirmed: true,
      requestChunk: async () => assert.fail("source mismatch must not call endpoint"),
    }), /PARTIAL_CHECKPOINT_SOURCE_MISMATCH/);
    await chmod(`${destination}.partial`, 0o644);
    await assert.rejects(() => processPreparedChunks({
      ...base,
      resumeConfirmed: true,
      requestChunk: async () => assert.fail("permission mismatch must not call endpoint"),
    }), /PARTIAL_CHECKPOINT_PERMISSIONS_INVALID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint lock prevents concurrent resumes from sending the same missing chunk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-transcript-test-"));
  const destination = join(directory, "draft.json");
  let releaseFirst;
  const firstMayFinish = new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
  let firstStarted;
  const firstHasStarted = new Promise((resolvePromise) => { firstStarted = resolvePromise; });
  let firstCalls = 0;
  let secondCalls = 0;
  const base = {
    destination,
    resumeConfirmed: false,
    sessionIdHash: "a".repeat(32),
    sourceSha256: "b".repeat(64),
    sourceByteSize: 10_000,
    sourceDurationSeconds: 240,
    preparedChunks: preparedChunks(1),
  };
  try {
    const first = processPreparedChunks({
      ...base,
      requestChunk: async () => {
        firstCalls += 1;
        firstStarted();
        await firstMayFinish;
        throw new Error("OPENAI_TRANSCRIPTION_FAILED_HTTP_503");
      },
    });
    await firstHasStarted;
    await assert.rejects(() => processPreparedChunks({
      ...base,
      resumeConfirmed: true,
      requestChunk: async () => {
        secondCalls += 1;
        return [{ speaker: "A", start: 0, end: 1, text: "送信禁止" }];
      },
    }), /PARTIAL_CHECKPOINT_BUSY/);
    releaseFirst();
    await assert.rejects(() => first, /OPENAI_TRANSCRIPTION_FAILED_HTTP_503/);
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0);
    await assert.rejects(() => lstat(`${destination}.partial.lock`), { code: "ENOENT" });
  } finally {
    releaseFirst?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint implementation never logs transcript text or checkpoint path", async () => {
  const source = await readFile(new URL("../scripts/manual-transcript-draft.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\.log|console\.warn/);
  assert.match(source, /partialSaved: true/);
  assert.doesNotMatch(source, /partialPath|checkpointPath.*process\.(?:stdout|stderr)/);
});
