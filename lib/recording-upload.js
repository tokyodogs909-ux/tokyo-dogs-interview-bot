export const RECORDING_UPLOAD_PART_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

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
    }),
  }), retryOptions);
  if (started.payload.stored === true) {
    input.onProgress?.(100);
    return { stored: true, resumedParts: totalParts, uploadedParts: 0 };
  }

  const previouslyUploaded = new Set(
    Array.isArray(started.payload.uploadedParts)
      ? started.payload.uploadedParts.filter((value) => Number.isInteger(value) && value >= 0 && value < totalParts)
      : [],
  );
  input.onProgress?.(Math.floor((previouslyUploaded.size / totalParts) * 100));
  let uploadedParts = 0;
  for (let index = 0; index < totalParts; index += 1) {
    if (previouslyUploaded.has(index)) continue;
    const part = input.blob.slice(index * partSize, Math.min(input.blob.size, (index + 1) * partSize));
    await requestWithRetry(() => fetcher("/api/interviews/recording/upload/part", {
      method: "PUT",
      headers: {
        ...commonHeaders,
        "Content-Type": "application/octet-stream",
        "X-Recording-Part-Index": String(index),
        "X-Recording-Part-Bytes": String(part.size),
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
