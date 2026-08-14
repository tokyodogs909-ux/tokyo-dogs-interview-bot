import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { readBoundedJsonBody } from "../lib/http-body.ts";
import { fetchOpenAIBytes, OpenAIRequestFailure } from "../lib/openai-fetch.ts";
import {
  authorizeBearerSecret,
  secureServerSecretMatch,
  serverSecretReadiness,
} from "../lib/server-secret-auth.ts";

test("bounded JSON reader rejects unsupported, malformed, declared-large, and chunked-large bodies", async () => {
  const unsupported = await readBoundedJsonBody(new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  }), { maxBytes: 32 });
  assert.deepEqual(unsupported, { ok: false, status: 415, reason: "unsupported_media_type" });

  const malformed = await readBoundedJsonBody(new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  }), { maxBytes: 32 });
  assert.deepEqual(malformed, { ok: false, status: 400, reason: "malformed" });

  const declaredLarge = await readBoundedJsonBody(new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "33" },
    body: "{}",
  }), { maxBytes: 32 });
  assert.deepEqual(declaredLarge, { ok: false, status: 413, reason: "too_large" });

  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"a":"'));
      controller.enqueue(new Uint8Array(40));
    },
    cancel() {
      cancelled = true;
    },
  });
  const chunkedLarge = await readBoundedJsonBody(new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/problem+json" },
    body: stream,
    duplex: "half",
  }), { maxBytes: 32 });
  assert.deepEqual(chunkedLarge, { ok: false, status: 413, reason: "too_large" });
  assert.equal(cancelled, true);
});

test("OpenAI timeout remains armed through a stalled response body and exposes only a fixed code", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
    const fetcher = {
      async fetch(request) {
        const body = new ReadableStream({
          start(controller) {
            request.signal.addEventListener("abort", () => {
              controller.error(new DOMException("sensitive upstream body", "AbortError"));
            }, { once: true });
          },
        });
        return new Response(body, { status: 200 });
      },
    };
    await assert.rejects(
      fetchOpenAIBytes(new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: "Bearer secret-token" },
        body: "candidate private text",
      }), { timeoutMs: 85_000, maxResponseBytes: 1_000_000, fetcher }),
      (error) => {
        assert.equal(error instanceof OpenAIRequestFailure, true);
        assert.equal(error.message, "OPENAI_REQUEST_TIMEOUT");
        assert.doesNotMatch(error.message, /secret|candidate|api\.openai/i);
        return true;
      },
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("server secret helper uses fixed-length digest comparison without hard-failing legacy strength", async () => {
  assert.deepEqual(serverSecretReadiness("legacy"), { configured: true, strong: false });
  assert.deepEqual(serverSecretReadiness("x".repeat(32)), { configured: true, strong: true });
  assert.equal(await secureServerSecretMatch("same", "same"), true);
  assert.equal(await secureServerSecretMatch("different", "same"), false);
  assert.equal(await authorizeBearerSecret(new Request("https://example.test", {
    headers: { Authorization: "Bearer same" },
  }), "same"), true);
});

test("all API route body reads and OpenAI production fetches use the bounded helpers", async () => {
  const apiRoot = new URL("../app/api/", import.meta.url);
  const entries = await readdir(apiRoot, { recursive: true, withFileTypes: true });
  const routeUrls = entries
    .filter((entry) => entry.isFile() && entry.name === "route.ts")
    .map((entry) => pathToFileURL(resolve(entry.parentPath, entry.name)));
  assert.ok(routeUrls.length >= 35);
  for (const url of routeUrls) {
    const source = await readFile(url, "utf8");
    assert.doesNotMatch(source, /request\.(?:text|json)\(/, url.pathname);
  }

  const openAIFiles = [
    "../lib/interview-evaluation-service.ts",
    "../lib/interview-manual-repair.ts",
    "../lib/openai-server.ts",
    "../lib/recorded-transcription.ts",
    "../app/api/realtime/call/route.ts",
    "../app/api/realtime/session/route.ts",
  ];
  for (const path of openAIFiles) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /fetchOpenAIBytes/);
    assert.doesNotMatch(source, /await (?:fetch|[A-Za-z]+\.fetch)\(/);
  }
});

test("recorded completion claims before one model call, falls back safely, and preserves strict replay", async () => {
  const completion = await readFile(new URL("../lib/recorded-interview-completion.ts", import.meta.url), "utf8");
  assert.ok(completion.indexOf("claimInterviewEvaluation") < completion.indexOf("evaluateInterviewTranscript({"));
  assert.match(completion, /buildDeferredHumanEvaluation\("recorded_fallback"\)/);
  assert.match(completion, /if \(session\.status === "completed"\)/);
  assert.match(completion, /RECORDED_COMPLETION_PROVENANCE_MISMATCH/);
  const service = await readFile(new URL("../lib/interview-evaluation-service.ts", import.meta.url), "utf8");
  assert.match(service, /const EVALUATION_TIMEOUT_MS = 85_000/);
  assert.match(service, /source: "realtime_or_text" \| "recorded_transcribed"/);
  assert.match(service, /RECORDED_TRANSCRIPT_EVALUATION_WARNING/);
  const route = await readFile(new URL("../app/api/interviews/recorded/complete/route.ts", import.meta.url), "utf8");
  assert.match(route, /automaticEvaluationDeferred: completion\.automaticEvaluationDeferred/);
});

test("staff Drive sync reports success only after completed integrity verification", async () => {
  const route = await readFile(new URL("../app/api/staff/google-drive/sync/route.ts", import.meta.url), "utf8");
  assert.match(route, /result\.status === "completed" && result\.integrity\?\.status === "verified"/);
  assert.doesNotMatch(route, /synced: result\.status === "completed"[,}]/);

  const staff = await readFile(new URL("../app/staff/page.tsx", import.meta.url), "utf8");
  const driftBranch = staff.indexOf('integrityStatus === "drift"');
  const unknownBranch = staff.indexOf('integrityStatus !== "verified"', driftBranch);
  const completedBranch = staff.indexOf('data.result.status === "completed"', unknownBranch);
  assert.ok(driftBranch >= 0 && driftBranch < unknownBranch && unknownBranch < completedBranch);
  assert.match(staff, /保存後差分を検出しました。格納完了とは扱わず/);
  assert.match(staff, /現在内容は照合未完です。格納完了とは扱わず/);
});
