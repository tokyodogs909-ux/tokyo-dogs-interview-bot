import assert from "node:assert/strict";
import test from "node:test";

import {
  RECORDING_UPLOAD_PART_BYTES,
  recordingPartSha256,
  uploadRecordingResumably,
} from "../lib/recording-upload.js";

class VirtualBlob {
  constructor(size, type = "video/mp4") {
    this.size = size;
    this.type = type;
  }

  slice(start, end) {
    const size = Math.max(0, Math.min(this.size, end) - start);
    const fill = Math.floor(start / RECORDING_UPLOAD_PART_BYTES) % 251;
    return {
      size,
      type: this.type,
      arrayBuffer: async () => new Uint8Array(size).fill(fill).buffer,
    };
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
    if (url.endsWith("/start")) {
      assert.equal(JSON.parse(init.body).uploadVersion, 2);
      return json({ stored: false, uploadVersion: 2, uploadedParts: [], uploadedPartReceipts: [] });
    }
    if (url.endsWith("/part")) {
      const index = Number(init.headers["X-Recording-Part-Index"]);
      const attempts = (partAttempts.get(index) ?? 0) + 1;
      partAttempts.set(index, attempts);
      if (index === 7 && attempts < 3) return json({ error: "temporary" }, 503);
      acceptedParts.push(index);
      assert.equal(Number(init.headers["X-Recording-Part-Bytes"]), init.body.size);
      assert.match(init.headers["X-Recording-Part-Sha256"], /^[a-f0-9]{64}$/);
      assert.equal(init.headers["X-Recording-Part-Sha256"], await recordingPartSha256(init.body));
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

test("part SHA-256 is deterministic for the exact bytes", async () => {
  const bytes = new TextEncoder().encode("same-size-content-a");
  const part = new Blob([bytes]);
  assert.equal(
    await recordingPartSha256(part),
    "5c0370a63d3a55ce779a4832b85162626c7da5e2e5fa77c85469c8adcd8b75a9",
  );
  assert.notEqual(
    await recordingPartSha256(new Blob([new TextEncoder().encode("same-size-content-b")])),
    await recordingPartSha256(part),
  );
});

test("a resumed upload skips server-acknowledged parts", async () => {
  const blob = new VirtualBlob(RECORDING_UPLOAD_PART_BYTES * 2 + 1234, "video/webm");
  const firstDigest = await recordingPartSha256(blob.slice(0, RECORDING_UPLOAD_PART_BYTES));
  const secondDigest = await recordingPartSha256(blob.slice(RECORDING_UPLOAD_PART_BYTES, RECORDING_UPLOAD_PART_BYTES * 2));
  const sent = [];
  const fetcher = async (url, init) => {
    if (url.endsWith("/start")) return json({
      stored: false,
      uploadVersion: 2,
      uploadedParts: [0, 1],
      uploadedPartReceipts: [
        { index: 0, sha256: firstDigest },
        { index: 1, sha256: secondDigest },
      ],
    });
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

test("a resumed upload rejects same-size local bytes that differ from stored parts", async () => {
  const blob = new VirtualBlob(RECORDING_UPLOAD_PART_BYTES + 1234, "video/webm");
  await assert.rejects(
    uploadRecordingResumably({
      blob,
      sessionId: "TD-RESUME-CONFLICT-TEST",
      accessToken: "candidate-token",
      audioCoverage: "both",
      fetcher: async (url) => {
        if (!url.endsWith("/start")) assert.fail("no new part may be sent after a digest mismatch");
        return json({
          stored: false,
          uploadVersion: 2,
          uploadedParts: [0],
          uploadedPartReceipts: [{ index: 0, sha256: "f".repeat(64) }],
        });
      },
      sleep: async () => undefined,
    }),
    /端末上の録画と保存済みデータが一致しません/,
  );
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
