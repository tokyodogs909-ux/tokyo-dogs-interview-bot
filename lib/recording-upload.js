export const RECORDING_UPLOAD_PART_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
// A 409 is an immutable session/upload-id/part-digest conflict in both v2 and
// v3. Replaying the same request cannot resolve it and risks five blind writes.
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responsePayload(response) {
  return await response.json().catch(() => ({}));
}

async function requestWithRetry(run, options = {}) {
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  const sleep = options.sleep ?? wait;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await run();
      const payload = await responsePayload(response);
      if (response.ok) return { response, payload };
      const error = new Error(payload.error || `HTTP_${response.status}`);
      error.status = response.status;
      if (!RETRYABLE_STATUSES.has(response.status)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error?.status && !RETRYABLE_STATUSES.has(error.status)) throw error;
    }
    if (attempt < attempts - 1) {
      await sleep(Math.min(8_000, 700 * (2 ** attempt)));
    }
  }
  throw lastError ?? new Error("録画を送信できませんでした。");
}

function authorizationHeaders(sessionId, accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Interview-Session": sessionId,
  };
}

export async function recordingPartSha256(part) {
  if (!globalThis.crypto?.subtle || typeof part?.arrayBuffer !== "function") {
    throw new Error("録画データの完全性を確認できません。");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await part.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createRecordingUploadId(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.getRandomValues) throw new Error("録画の保存識別情報を作成できません。");
  const bytes = new Uint8Array(20);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedRecordingContentType(value) {
  const contentType = String(value || "video/webm").split(";")[0].toLowerCase();
  if (!["video/webm", "audio/webm", "video/mp4", "audio/mp4"].includes(contentType)) {
    throw new Error("録画形式を確認できません。");
  }
  return contentType;
}

function takeBlobPrefix(chunks, byteSize, contentType) {
  const parts = [];
  let remaining = byteSize;
  while (remaining > 0) {
    const chunk = chunks[0];
    if (!chunk) throw new Error("録画データの分割状態が一致しません。");
    if (chunk.size <= remaining) {
      chunks.shift();
      parts.push(chunk);
      remaining -= chunk.size;
    } else {
      parts.push(chunk.slice(0, remaining));
      chunks[0] = chunk.slice(remaining);
      remaining = 0;
    }
  }
  return new Blob(parts, { type: contentType });
}

/**
 * Streams a MediaRecorder byte stream to deterministic Version 3 parts. Only
 * exact, server-acknowledged full parts leave RAM. Failed and not-yet-full
 * bytes remain attached to this same upload/session for an explicit retry.
 */
export function createLiveRecordingUploader(input) {
  const fetcher = input.fetcher ?? fetch;
  const sleep = input.sleep;
  const attempts = input.attempts;
  const sessionId = input.sessionId;
  const accessToken = input.accessToken;
  const uploadId = input.uploadId ?? createRecordingUploadId();
  const contentType = normalizedRecordingContentType(input.contentType);
  const partSize = RECORDING_UPLOAD_PART_BYTES;
  const commonHeaders = {
    ...authorizationHeaders(sessionId, accessToken),
    "X-Recording-Upload-Id": uploadId,
  };
  const retryOptions = { attempts, sleep };
  const chunks = [];
  const fullParts = [];
  const acknowledged = new Map();
  let bufferedChunkBytes = 0;
  let totalBytes = 0;
  let durableBytes = 0;
  let nextPartIndex = 0;
  let started = false;
  let sealed = false;
  let completed = false;
  let finalizing = false;
  let activePump = null;
  let failure = null;
  let sealedShape = null;
  let finalPart = null;

  const notifyProgress = () => {
    const progress = totalBytes > 0 ? Math.min(99, Math.floor((durableBytes / totalBytes) * 100)) : 0;
    input.onProgress?.(completed ? 100 : progress);
  };

  const rememberFailure = (error) => {
    failure = error instanceof Error ? error : new Error("録画を送信できませんでした。");
    input.onError?.(failure);
  };

  const localPart = (index) => {
    if (finalPart?.index === index) return finalPart;
    return fullParts.find((part) => part.index === index) ?? null;
  };

  const validateStartReceipt = async (payload) => {
    if (
      payload.uploadVersion !== 3 ||
      payload.uploadId !== uploadId ||
      payload.contentType !== contentType ||
      payload.partSize !== partSize
    ) {
      throw new Error("録画の再開情報を確認できませんでした。");
    }
    const receipts = Array.isArray(payload.uploadedPartReceipts) ? payload.uploadedPartReceipts : [];
    const indexes = Array.isArray(payload.uploadedParts) ? payload.uploadedParts : [];
    if (receipts.length !== indexes.length) {
      throw new Error("録画の再開情報を確認できませんでした。");
    }
    for (let offset = 0; offset < receipts.length; offset += 1) {
      const receipt = receipts[offset];
      if (
        receipt?.index !== offset ||
        indexes[offset] !== offset ||
        !/^[a-f0-9]{64}$/.test(receipt?.sha256 ?? "")
      ) {
        throw new Error("録画の再開情報を確認できませんでした。");
      }
      const knownDigest = acknowledged.get(receipt.index);
      const pending = localPart(receipt.index);
      const localDigest = knownDigest ?? (pending ? await recordingPartSha256(pending.blob) : "");
      if (localDigest !== receipt.sha256) {
        throw new Error("端末上の録画と保存済みデータが一致しません。自動上書きは行いません。");
      }
      acknowledged.set(receipt.index, receipt.sha256);
      const pendingIndex = fullParts.findIndex((part) => part.index === receipt.index);
      if (pendingIndex >= 0) {
        durableBytes += fullParts[pendingIndex].blob.size;
        fullParts.splice(pendingIndex, 1);
      }
      if (finalPart?.index === receipt.index) {
        durableBytes += finalPart.blob.size;
        finalPart = null;
      }
    }
    if (payload.stored === true) {
      if (finalizing && sealedShape && receipts.length !== sealedShape.totalParts) {
        throw new Error("録画の再開情報を確認できませんでした。");
      }
      completed = true;
      sealed = true;
      input.onProgress?.(100);
    }
    if (payload.sealed === true) sealed = true;
  };

  const ensureStarted = async () => {
    if (started) return;
    const response = await requestWithRetry(() => fetcher("/api/interviews/recording/upload/start", {
      method: "POST",
      headers: { ...commonHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        uploadId,
        contentType,
        partSize,
        uploadVersion: 3,
      }),
    }), retryOptions);
    await validateStartReceipt(response.payload);
    started = true;
  };

  const sendPart = async (part) => {
    const digest = part.sha256 ?? await recordingPartSha256(part.blob);
    part.sha256 = digest;
    const knownDigest = acknowledged.get(part.index);
    if (knownDigest) {
      if (knownDigest !== digest) {
        throw new Error("端末上の録画と保存済みデータが一致しません。自動上書きは行いません。");
      }
      return;
    }
    const response = await requestWithRetry(() => fetcher("/api/interviews/recording/upload/part", {
      method: "PUT",
      headers: {
        ...commonHeaders,
        "Content-Type": "application/octet-stream",
        "X-Recording-Part-Index": String(part.index),
        "X-Recording-Part-Bytes": String(part.blob.size),
        "X-Recording-Part-Sha256": digest,
      },
      body: part.blob,
    }), retryOptions);
    if (response.payload.stored !== true || response.payload.index !== part.index) {
      throw new Error("録画データの受領情報が一致しません。未送信データは端末に保持します。");
    }
    acknowledged.set(part.index, digest);
  };

  const pump = async () => {
    await ensureStarted();
    while (fullParts.length > 0) {
      const part = fullParts[0];
      await sendPart(part);
      if (fullParts[0] === part) fullParts.shift();
      durableBytes += part.blob.size;
      notifyProgress();
    }
  };

  const schedulePump = () => {
    if (activePump || failure || completed) return;
    activePump = pump()
      .catch(rememberFailure)
      .finally(() => {
        activePump = null;
        // A MediaRecorder dataavailable event can enqueue another complete
        // part after pump observed an empty queue but before this finally runs.
        // Re-arm immediately so that part is not stranded until end-of-call.
        if (fullParts.length > 0 && !failure && !completed) schedulePump();
      });
  };

  const partitionFullParts = () => {
    while (bufferedChunkBytes >= partSize) {
      const blob = takeBlobPrefix(chunks, partSize, contentType);
      bufferedChunkBytes -= partSize;
      fullParts.push({ index: nextPartIndex, blob, sha256: null });
      nextPartIndex += 1;
    }
  };

  return {
    uploadId,
    start() {
      if (completed) return Promise.resolve();
      if (!activePump && !failure) schedulePump();
      return activePump ?? Promise.resolve();
    },
    append(blob) {
      if (!(blob instanceof Blob) || blob.size <= 0) return;
      if (finalizing || completed) throw new Error("録画の確定後にデータは追加できません。");
      chunks.push(blob);
      bufferedChunkBytes += blob.size;
      totalBytes += blob.size;
      partitionFullParts();
      schedulePump();
      notifyProgress();
    },
    async retry() {
      if (completed) return { stored: true };
      failure = null;
      await ensureStarted();
      await pump();
      return { stored: completed, pendingParts: fullParts.length };
    },
    async finalize(audioCoverage) {
      if (completed) return { stored: true, alreadyStored: true };
      if (!["both", "candidate-only", "unverified"].includes(audioCoverage)) {
        throw new Error("録画の音声確認情報が正しくありません。");
      }
      finalizing = true;
      if (activePump) await activePump;
      if (failure) {
        failure = null;
        await pump().catch((error) => {
          rememberFailure(error);
          throw error;
        });
      } else {
        await pump();
      }
      if (totalBytes <= 0) throw new Error("完全な録画データを生成できませんでした。");
      const totalParts = Math.ceil(totalBytes / partSize);
      const shape = { byteSize: totalBytes, totalParts, audioCoverage };
      if (sealedShape && (
        sealedShape.byteSize !== shape.byteSize ||
        sealedShape.totalParts !== shape.totalParts ||
        sealedShape.audioCoverage !== shape.audioCoverage
      )) {
        throw new Error("録画の確定情報が一致しません。");
      }
      sealedShape = shape;
      const sealResponse = await requestWithRetry(() => fetcher("/api/interviews/recording/upload/seal", {
        method: "POST",
        headers: { ...commonHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, uploadId, ...shape }),
      }), retryOptions);
      if (sealResponse.payload.sealed !== true) {
        throw new Error(sealResponse.payload.error || "録画を確定できませんでした。");
      }
      sealed = true;

      if (bufferedChunkBytes > 0 && !finalPart) {
        finalPart = {
          index: totalParts - 1,
          blob: takeBlobPrefix(chunks, bufferedChunkBytes, contentType),
          sha256: null,
        };
        bufferedChunkBytes = 0;
      }
      if (finalPart) {
        await sendPart(finalPart);
        durableBytes += finalPart.blob.size;
        finalPart = null;
        notifyProgress();
      }
      const completedResponse = await requestWithRetry(() => fetcher("/api/interviews/recording/upload/complete", {
        method: "POST",
        headers: commonHeaders,
      }), retryOptions);
      if (completedResponse.payload.stored !== true) {
        throw new Error(completedResponse.payload.error || "録画を確定できませんでした。");
      }
      completed = true;
      failure = null;
      input.onProgress?.(100);
      return { stored: true, byteSize: totalBytes, totalParts, uploadId };
    },
    snapshot() {
      return {
        uploadId,
        totalBytes,
        durableBytes,
        bufferedBytes: bufferedChunkBytes + fullParts.reduce((sum, part) => sum + part.blob.size, 0) + (finalPart?.blob.size ?? 0),
        pendingParts: fullParts.length + (finalPart ? 1 : 0),
        started,
        sealed,
        completed,
        failed: failure !== null,
      };
    },
  };
}

/**
 * Uploads a finalized MediaRecorder Blob in independently retried pieces. The
 * server keeps every accepted piece, so restarting this function resumes at the
 * first missing piece instead of sending the whole recording again.
 */
export async function uploadRecordingResumably(input) {
  const fetcher = input.fetcher ?? fetch;
  const partSize = input.partSize ?? RECORDING_UPLOAD_PART_BYTES;
  const totalParts = Math.ceil(input.blob.size / partSize);
  const contentType = input.blob.type.split(";")[0] || "video/webm";
  const commonHeaders = authorizationHeaders(input.sessionId, input.accessToken);
  const retryOptions = { attempts: input.attempts, sleep: input.sleep };

  const started = await requestWithRetry(() => fetcher("/api/interviews/recording/upload/start", {
    method: "POST",
    headers: { ...commonHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId,
      contentType,
      byteSize: input.blob.size,
      partSize,
      totalParts,
      audioCoverage: input.audioCoverage,
      uploadVersion: 2,
    }),
  }), retryOptions);
  const previouslyUploaded = new Set(
    Array.isArray(started.payload.uploadedParts)
      ? started.payload.uploadedParts.filter((value) => Number.isInteger(value) && value >= 0 && value < totalParts)
      : [],
  );
  // A stored receipt without resumable state is a legacy single-object upload.
  // New Version 2 state always returns its per-part receipts, including after
  // finalization, so it can be compared to the current local Blob first.
  if (
    started.payload.uploadVersion !== 1 &&
    started.payload.uploadVersion !== 2 &&
    !(started.payload.stored === true && started.payload.uploadVersion === undefined)
  ) {
    throw new Error("録画の再開情報を確認できませんでした。");
  }
  if (started.payload.uploadVersion === 2) {
    const receipts = new Map(
      Array.isArray(started.payload.uploadedPartReceipts)
        ? started.payload.uploadedPartReceipts
          .filter((receipt) => Number.isInteger(receipt?.index) && /^[a-f0-9]{64}$/.test(receipt?.sha256 ?? ""))
          .map((receipt) => [receipt.index, receipt.sha256])
        : [],
    );
    if (receipts.size !== previouslyUploaded.size) {
      throw new Error("録画の再開情報を確認できませんでした。");
    }
    for (const index of previouslyUploaded) {
      const part = input.blob.slice(index * partSize, Math.min(input.blob.size, (index + 1) * partSize));
      if (receipts.get(index) !== await recordingPartSha256(part)) {
        throw new Error("端末上の録画と保存済みデータが一致しません。自動上書きは行いません。");
      }
    }
  }
  if (started.payload.stored === true) {
    if (started.payload.uploadVersion === 2 && previouslyUploaded.size !== totalParts) {
      throw new Error("録画の再開情報を確認できませんでした。");
    }
    input.onProgress?.(100);
    return { stored: true, resumedParts: totalParts, uploadedParts: 0 };
  }
  input.onProgress?.(Math.floor((previouslyUploaded.size / totalParts) * 100));
  let uploadedParts = 0;
  for (let index = 0; index < totalParts; index += 1) {
    if (previouslyUploaded.has(index)) continue;
    const part = input.blob.slice(index * partSize, Math.min(input.blob.size, (index + 1) * partSize));
    // Compute once outside the retry callback. Every retry sends the exact same
    // bytes and digest, allowing the server to reject a same-size replacement.
    const partSha256 = await recordingPartSha256(part);
    await requestWithRetry(() => fetcher("/api/interviews/recording/upload/part", {
      method: "PUT",
      headers: {
        ...commonHeaders,
        "Content-Type": "application/octet-stream",
        "X-Recording-Part-Index": String(index),
        "X-Recording-Part-Bytes": String(part.size),
        "X-Recording-Part-Sha256": partSha256,
      },
      body: part,
    }), retryOptions);
    uploadedParts += 1;
    input.onProgress?.(Math.floor(((previouslyUploaded.size + uploadedParts) / totalParts) * 100));
  }

  const completed = await requestWithRetry(() => fetcher("/api/interviews/recording/upload/complete", {
    method: "POST",
    headers: commonHeaders,
  }), retryOptions);
  if (completed.payload.stored !== true) throw new Error(completed.payload.error || "録画を確定できませんでした。");
  input.onProgress?.(100);
  return { stored: true, resumedParts: previouslyUploaded.size, uploadedParts };
}
