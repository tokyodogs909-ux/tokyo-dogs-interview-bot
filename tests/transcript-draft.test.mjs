import assert from "node:assert/strict";
import test from "node:test";

import { createTranscriptDraftWriter } from "../lib/transcript-draft.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function digestTranscript(transcript) {
  const text = JSON.stringify(transcript);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const question = {
  id: "question-1",
  speaker: "interviewer",
  text: "自己紹介をお願いします。",
  createdAt: "2026-08-14T00:00:00.000Z",
};
const answer = {
  id: "answer-1",
  speaker: "candidate",
  text: "応募者の回答です。",
  createdAt: "2026-08-14T00:00:10.000Z",
};

test("completed transcript snapshots are serialized and exact receipts are required", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return jsonResponse({
      stored: true,
      sha256: await digestTranscript(body.transcript),
      turnCount: body.transcript.length,
    });
  };
  const writer = createTranscriptDraftWriter({
    sessionId: "TD-TRANSCRIPT-1",
    accessToken: "secret",
    mode: "voice",
    fetchImpl,
  });

  const first = writer.enqueue([question]);
  const second = writer.enqueue([question, answer]);
  await Promise.all([first, second]);

  assert.deepEqual(calls.map((call) => call.body.transcript.length), [1, 2]);
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/interviews/transcript/draft",
    "/api/interviews/transcript/draft",
  ]);
});

test("an ambiguous earlier draft does not poison a later append-only snapshot", async () => {
  const calls = [];
  let first = true;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (first) {
      first = false;
      throw new TypeError("transport lost after a possible server commit");
    }
    return jsonResponse({
      stored: true,
      sha256: await digestTranscript(body.transcript),
      turnCount: body.transcript.length,
    });
  };
  const writer = createTranscriptDraftWriter({
    sessionId: "TD-TRANSCRIPT-2",
    accessToken: "secret",
    mode: "text",
    fetchImpl,
  });

  await assert.rejects(writer.enqueue([question]), /transport lost/);
  await writer.enqueue([question, answer]);
  assert.deepEqual(calls.map((call) => call.body.transcript.length), [1, 2]);
});

test("final seal waits for the draft receipt and uses the identical snapshot", async () => {
  const firstReceipt = deferred();
  const draftStarted = deferred();
  const calls = [];
  const finalTranscript = [question, answer];
  const digest = await digestTranscript(finalTranscript);
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("/draft")) {
      draftStarted.resolve();
      return await firstReceipt.promise;
    }
    return jsonResponse({ sealed: true, sha256: digest, turnCount: finalTranscript.length });
  };
  const writer = createTranscriptDraftWriter({
    sessionId: "TD-TRANSCRIPT-3",
    accessToken: "secret",
    mode: "voice",
    fetchImpl,
  });

  const seal = writer.seal(finalTranscript);
  await draftStarted.promise;
  assert.deepEqual(calls.map((call) => call.url), ["/api/interviews/transcript/draft"]);

  firstReceipt.resolve(jsonResponse({
    stored: true,
    sha256: digest,
    turnCount: finalTranscript.length,
  }));
  await seal;
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/interviews/transcript/draft",
    "/api/interviews/transcript/draft/seal",
  ]);
  assert.deepEqual(calls[0].body.transcript, calls[1].body.transcript);
});

test("a mismatched durable receipt fails closed", async () => {
  const writer = createTranscriptDraftWriter({
    sessionId: "TD-TRANSCRIPT-4",
    accessToken: "secret",
    mode: "voice",
    fetchImpl: async () => jsonResponse({
      stored: true,
      sha256: "0".repeat(64),
      turnCount: 1,
    }),
  });
  await assert.rejects(writer.enqueue([question]), /TRANSCRIPT_DRAFT_RECEIPT_MISMATCH/);
});
