import assert from "node:assert/strict";
import test from "node:test";

import {
  RECORDING_UPLOAD_PART_BYTES,
  createLiveRecordingUploader,
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

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

test("live recording makes exact 4 MiB parts durable before finalization, then seals before the final partial", async () => {
  const uploadId = "live-recording-upload-id-000001";
  const calls = [];
  const accepted = new Map();
  let sealed = false;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/start")) {
      const payload = JSON.parse(init.body);
      assert.deepEqual(payload, {
        sessionId: "TD-LIVE-STREAM-TEST",
        uploadId,
        contentType: "video/webm",
        partSize: RECORDING_UPLOAD_PART_BYTES,
        uploadVersion: 3,
      });
      return json({
        stored: false,
        uploadVersion: 3,
        uploadId,
        contentType: "video/webm",
        partSize: RECORDING_UPLOAD_PART_BYTES,
        sealed: false,
        uploadedParts: [],
        uploadedPartReceipts: [],
      });
    }
    if (url.endsWith("/part")) {
      const index = Number(init.headers["X-Recording-Part-Index"]);
      const bytes = new Uint8Array(await init.body.arrayBuffer());
      assert.equal(init.headers["X-Recording-Upload-Id"], uploadId);
      assert.equal(init.headers["X-Recording-Part-Sha256"], await recordingPartSha256(init.body));
      if (index === 1) assert.equal(sealed, true, "the final partial must be sent only after seal");
      accepted.set(index, bytes);
      return json({ stored: true, index });
    }
    if (url.endsWith("/seal")) {
      assert.deepEqual(JSON.parse(init.body), {
        sessionId: "TD-LIVE-STREAM-TEST",
        uploadId,
        byteSize: RECORDING_UPLOAD_PART_BYTES + 321,
        totalParts: 2,
        audioCoverage: "both",
      });
      assert.equal(accepted.has(0), true, "the full part must already be durable at seal");
      assert.equal(accepted.has(1), false);
      sealed = true;
      return json({ sealed: true });
    }
    if (url.endsWith("/complete")) {
      assert.equal(sealed, true);
      assert.deepEqual([...accepted.keys()], [0, 1]);
      return json({ stored: true });
    }
    throw new Error(`unexpected ${url}`);
  };
  const uploader = createLiveRecordingUploader({
    sessionId: "TD-LIVE-STREAM-TEST",
    accessToken: "candidate-token",
    uploadId,
    contentType: "video/webm;codecs=vp8,opus",
    fetcher,
    sleep: async () => undefined,
  });
  await uploader.start();
  uploader.append(new Blob([new Uint8Array(3 * 1024 * 1024).fill(1)]));
  uploader.append(new Blob([new Uint8Array(1024 * 1024 + 321).fill(2)]));
  await waitFor(
    () => uploader.snapshot().durableBytes === RECORDING_UPLOAD_PART_BYTES,
    "the first full part should upload while recording",
  );
  assert.deepEqual(uploader.snapshot(), {
    uploadId,
    totalBytes: RECORDING_UPLOAD_PART_BYTES + 321,
    durableBytes: RECORDING_UPLOAD_PART_BYTES,
    bufferedBytes: 321,
    pendingParts: 0,
    started: true,
    sealed: false,
    completed: false,
    failed: false,
  });
  const result = await uploader.finalize("both");
  assert.equal(result.stored, true);
  assert.equal(accepted.get(0).byteLength, RECORDING_UPLOAD_PART_BYTES);
  assert.equal(accepted.get(1).byteLength, 321);
  assert.equal(calls.at(-1).url.endsWith("/complete"), true);
  assert.equal(uploader.snapshot().bufferedBytes, 0);
});

test("a failed live part remains in RAM and retries on the same upload without opening a new session", async () => {
  const uploadId = "live-recording-upload-id-000002";
  let rejectPart = true;
  let startCalls = 0;
  const acceptedIndexes = [];
  const fetcher = async (url, init) => {
    if (url.endsWith("/start")) {
      startCalls += 1;
      return json({
        stored: false,
        uploadVersion: 3,
        uploadId,
        contentType: "audio/webm",
        partSize: RECORDING_UPLOAD_PART_BYTES,
        sealed: false,
        uploadedParts: [],
        uploadedPartReceipts: [],
      });
    }
    if (url.endsWith("/part")) {
      if (rejectPart) return json({ error: "offline" }, 503);
      const index = Number(init.headers["X-Recording-Part-Index"]);
      acceptedIndexes.push(index);
      return json({ stored: true, index });
    }
    if (url.endsWith("/seal")) return json({ sealed: true });
    if (url.endsWith("/complete")) return json({ stored: true });
    throw new Error(`unexpected ${url}`);
  };
  const uploader = createLiveRecordingUploader({
    sessionId: "TD-LIVE-RETRY-TEST",
    accessToken: "candidate-token",
    uploadId,
    contentType: "audio/webm",
    fetcher,
    attempts: 1,
    sleep: async () => undefined,
  });
  uploader.append(new Blob([new Uint8Array(RECORDING_UPLOAD_PART_BYTES).fill(7)]));
  await waitFor(() => uploader.snapshot().failed, "the failed part should become sticky");
  assert.equal(uploader.snapshot().durableBytes, 0);
  assert.equal(uploader.snapshot().bufferedBytes, RECORDING_UPLOAD_PART_BYTES);
  uploader.append(new Blob([new Uint8Array(99).fill(8)]));
  assert.equal(uploader.snapshot().bufferedBytes, RECORDING_UPLOAD_PART_BYTES + 99);

  rejectPart = false;
  const completed = await uploader.finalize("candidate-only");
  assert.equal(completed.stored, true);
  assert.deepEqual(acceptedIndexes, [0, 1]);
  assert.equal(startCalls, 1, "retry must keep the original v3 state and session");
  assert.equal(uploader.snapshot().bufferedBytes, 0);
});

test("an exact-multiple recording seals after all full parts with no synthetic final part", async () => {
  const uploadId = "live-recording-upload-id-000003";
  const partIndexes = [];
  let sealShape = null;
  const fetcher = async (url, init) => {
    if (url.endsWith("/start")) return json({
      stored: false,
      uploadVersion: 3,
      uploadId,
      contentType: "video/webm",
      partSize: RECORDING_UPLOAD_PART_BYTES,
      sealed: false,
      uploadedParts: [],
      uploadedPartReceipts: [],
    });
    if (url.endsWith("/part")) {
      const index = Number(init.headers["X-Recording-Part-Index"]);
      partIndexes.push(index);
      assert.equal(init.body.size, RECORDING_UPLOAD_PART_BYTES);
      return json({ stored: true, index });
    }
    if (url.endsWith("/seal")) {
      sealShape = JSON.parse(init.body);
      return json({ sealed: true });
    }
    if (url.endsWith("/complete")) return json({ stored: true });
    throw new Error(`unexpected ${url}`);
  };
  const uploader = createLiveRecordingUploader({
    sessionId: "TD-LIVE-EXACT-MULTIPLE",
    accessToken: "candidate-token",
    uploadId,
    contentType: "video/webm",
    fetcher,
    sleep: async () => undefined,
  });
  uploader.append(new Blob([new Uint8Array(RECORDING_UPLOAD_PART_BYTES * 2).fill(4)]));
  const result = await uploader.finalize("both");

  assert.equal(result.stored, true);
  assert.deepEqual(partIndexes, [0, 1]);
  assert.deepEqual(sealShape, {
    sessionId: "TD-LIVE-EXACT-MULTIPLE",
    uploadId,
    byteSize: RECORDING_UPLOAD_PART_BYTES * 2,
    totalParts: 2,
    audioCoverage: "both",
  });
  assert.equal(uploader.snapshot().bufferedBytes, 0);
});

test("a part appended after the pump loop empties is re-armed before finalization", async () => {
  const uploadId = "live-recording-upload-id-000004";
  const partIndexes = [];
  let uploader;
  let queuedSecond = false;
  const fetcher = async (url, init) => {
    if (url.endsWith("/start")) return json({
      stored: false,
      uploadVersion: 3,
      uploadId,
      contentType: "video/webm",
      partSize: RECORDING_UPLOAD_PART_BYTES,
      sealed: false,
      uploadedParts: [],
      uploadedPartReceipts: [],
    });
    if (url.endsWith("/part")) {
      const index = Number(init.headers["X-Recording-Part-Index"]);
      partIndexes.push(index);
      return json({ stored: true, index });
    }
    if (url.endsWith("/seal")) return json({ sealed: true });
    if (url.endsWith("/complete")) return json({ stored: true });
    throw new Error(`unexpected ${url}`);
  };
  uploader = createLiveRecordingUploader({
    sessionId: "TD-LIVE-PUMP-RACE",
    accessToken: "candidate-token",
    uploadId,
    contentType: "video/webm",
    fetcher,
    sleep: async () => undefined,
    onProgress: () => {
      if (!queuedSecond && uploader.snapshot().durableBytes === RECORDING_UPLOAD_PART_BYTES) {
        queuedSecond = true;
        // This microtask runs after pump observes its first part but before the
        // promise's finally handler clears activePump.
        queueMicrotask(() => {
          uploader.append(new Blob([new Uint8Array(RECORDING_UPLOAD_PART_BYTES).fill(6)]));
        });
      }
    },
  });
  uploader.append(new Blob([new Uint8Array(RECORDING_UPLOAD_PART_BYTES).fill(5)]));
  await waitFor(
    () => uploader.snapshot().durableBytes === RECORDING_UPLOAD_PART_BYTES * 2,
    "the finally re-arm must durably send the late full part",
  );
  await uploader.finalize("both");
  assert.deepEqual(partIndexes, [0, 1]);
});

test("a transient complete failure resumes the same sealed upload id", async () => {
  const uploadId = "live-recording-upload-id-000005";
  let startCalls = 0;
  let completeCalls = 0;
  let sealCalls = 0;
  const fetcher = async (url, init) => {
    if (url.endsWith("/start")) {
      startCalls += 1;
      return json({
        stored: false,
        uploadVersion: 3,
        uploadId,
        contentType: "video/webm",
        partSize: RECORDING_UPLOAD_PART_BYTES,
        sealed: false,
        uploadedParts: [],
        uploadedPartReceipts: [],
      });
    }
    if (url.endsWith("/part")) {
      return json({ stored: true, index: Number(init.headers["X-Recording-Part-Index"]) });
    }
    if (url.endsWith("/seal")) {
      sealCalls += 1;
      return json({ sealed: true });
    }
    if (url.endsWith("/complete")) {
      completeCalls += 1;
      return completeCalls === 1
        ? json({ error: "temporary" }, 503)
        : json({ stored: true });
    }
    throw new Error(`unexpected ${url}`);
  };
  const uploader = createLiveRecordingUploader({
    sessionId: "TD-LIVE-COMPLETE-RETRY",
    accessToken: "candidate-token",
    uploadId,
    contentType: "video/webm",
    fetcher,
    attempts: 1,
    sleep: async () => undefined,
  });
  uploader.append(new Blob([new Uint8Array(123).fill(9)]));
  await assert.rejects(uploader.finalize("candidate-only"), /temporary/);
  assert.equal(uploader.snapshot().sealed, true);
  assert.equal(uploader.snapshot().completed, false);
  const result = await uploader.finalize("candidate-only");
  assert.equal(result.stored, true);
  assert.equal(startCalls, 1);
  assert.equal(sealCalls, 2);
  assert.equal(completeCalls, 2);
  assert.equal(uploader.uploadId, uploadId);
});

test("a mismatched live part receipt keeps the exact bytes in RAM", async () => {
  const uploadId = "live-recording-upload-id-000006";
  const uploader = createLiveRecordingUploader({
    sessionId: "TD-LIVE-RECEIPT-MISMATCH",
    accessToken: "candidate-token",
    uploadId,
    contentType: "audio/webm",
    attempts: 1,
    sleep: async () => undefined,
    fetcher: async (url) => {
      if (url.endsWith("/start")) return json({
        stored: false,
        uploadVersion: 3,
        uploadId,
        contentType: "audio/webm",
        partSize: RECORDING_UPLOAD_PART_BYTES,
        sealed: false,
        uploadedParts: [],
        uploadedPartReceipts: [],
      });
      if (url.endsWith("/part")) return json({ stored: true, index: 9 });
      throw new Error(`unexpected ${url}`);
    },
  });
  uploader.append(new Blob([new Uint8Array(RECORDING_UPLOAD_PART_BYTES).fill(10)]));
  await waitFor(() => uploader.snapshot().failed, "the mismatched receipt must fail closed");
  assert.equal(uploader.snapshot().durableBytes, 0);
  assert.equal(uploader.snapshot().bufferedBytes, RECORDING_UPLOAD_PART_BYTES);
  assert.equal(uploader.snapshot().pendingParts, 1);
});

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

test("immutable 409 upload conflicts fail immediately instead of blind retrying", async () => {
  let attempts = 0;
  await assert.rejects(
    uploadRecordingResumably({
      blob: new VirtualBlob(1024 * 1024),
      sessionId: "TD-CONFLICT-FAIL-FAST",
      accessToken: "candidate-token",
      audioCoverage: "unverified",
      fetcher: async () => {
        attempts += 1;
        return json({ error: "録画の再開情報が一致しません。" }, 409);
      },
      sleep: async () => undefined,
    }),
    /録画の再開情報が一致しません/,
  );
  assert.equal(attempts, 1);
});

test("recording upload bounds both a hung request and a stalled response body", async () => {
  for (const fetcher of [
    async () => await new Promise(() => undefined),
    async () => ({
      ok: true,
      status: 200,
      json: async () => await new Promise(() => undefined),
    }),
  ]) {
    let attempts = 0;
    await assert.rejects(
      uploadRecordingResumably({
        blob: new VirtualBlob(1024),
        sessionId: "TD-TIMEOUT-BOUNDED-TEST",
        accessToken: "candidate-token",
        audioCoverage: "unverified",
        fetcher: async (...args) => {
          attempts += 1;
          return await fetcher(...args);
        },
        attempts: 1,
        requestTimeoutMs: 10,
        sleep: async () => undefined,
      }),
      /RECORDING_UPLOAD_REQUEST_TIMEOUT/,
    );
    assert.equal(attempts, 1);
  }
});
