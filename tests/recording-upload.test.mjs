import assert from "node:assert/strict";
import test from "node:test";

import {
  RECORDING_UPLOAD_PART_BYTES,
  uploadRecordingResumably,
} from "../lib/recording-upload.js";

class VirtualBlob {
  constructor(size, type = "video/mp4") {
    this.size = size;
    this.type = type;
  }

  slice(start, end) {
    return { size: Math.max(0, Math.min(this.size, end) - start), type: this.type };
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("a 27-minute-size recording is split, retries a failed part, and completes automatically", async () => {
  const blob = new VirtualBlob(90 * 1024 * 1024);
  const expectedParts = Math.ceil(blob.size / RECORDING_UPLOAD_PART_BYTES);
  const partAttempts = new Map();
  const acceptedParts = [];
  const progress = [];
  const fetcher = async (url, init) => {
    if (url.endsWith("/start")) return json({ stored: false, uploadedParts: [] });
    if (url.endsWith("/part")) {
      const index = Number(init.headers["X-Recording-Part-Index"]);
      const attempts = (partAttempts.get(index) ?? 0) + 1;
      partAttempts.set(index, attempts);
      if (index === 7 && attempts < 3) return json({ error: "temporary" }, 503);
      acceptedParts.push(index);
      assert.equal(Number(init.headers["X-Recording-Part-Bytes"]), init.body.size);
      return json({ stored: true });
    }
    if (url.endsWith("/complete")) return json({ stored: true });
    throw new Error(`unexpected ${url}`);
  };

  const result = await uploadRecordingResumably({
    blob,
    sessionId: "TD-LONG-MOBILE-TEST",
    accessToken: "candidate-token",
    audioCoverage: "both",
    fetcher,
    sleep: async () => undefined,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.stored, true);
  assert.equal(result.uploadedParts, expectedParts);
  assert.equal(partAttempts.get(7), 3);
  assert.deepEqual(acceptedParts, Array.from({ length: expectedParts }, (_, index) => index));
  assert.equal(progress.at(-1), 100);
});

test("a resumed upload skips server-acknowledged parts", async () => {
  const blob = new VirtualBlob(RECORDING_UPLOAD_PART_BYTES * 2 + 1234, "video/webm");
  const sent = [];
  const fetcher = async (url, init) => {
    if (url.endsWith("/start")) return json({ stored: false, uploadedParts: [0, 1] });
    if (url.endsWith("/part")) {
      sent.push(Number(init.headers["X-Recording-Part-Index"]));
      return json({ stored: true });
    }
    if (url.endsWith("/complete")) return json({ stored: true });
    throw new Error(`unexpected ${url}`);
  };
  const result = await uploadRecordingResumably({
    blob,
    sessionId: "TD-RESUME-MOBILE-TEST",
    accessToken: "candidate-token",
    audioCoverage: "unverified",
    fetcher,
    sleep: async () => undefined,
  });
  assert.deepEqual(sent, [2]);
  assert.equal(result.resumedParts, 2);
  assert.equal(result.uploadedParts, 1);
});

test("authorization errors fail immediately instead of retrying", async () => {
  let attempts = 0;
  await assert.rejects(
    uploadRecordingResumably({
      blob: new VirtualBlob(1024 * 1024),
      sessionId: "TD-AUTH-MOBILE-TEST",
      accessToken: "expired",
      audioCoverage: "unverified",
      fetcher: async () => {
        attempts += 1;
        return json({ error: "unauthorized" }, 401);
      },
      sleep: async () => undefined,
    }),
    /unauthorized/,
  );
  assert.equal(attempts, 1);
});
