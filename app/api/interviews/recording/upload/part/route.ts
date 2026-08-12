import {
  authorizeInterviewRequest,
  saveResumableInterviewRecordingPart,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

const MAX_PART_BYTES = 8 * 1024 * 1024;

async function readExactPartBytes(body: ReadableStream<Uint8Array>, expectedBytes: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > expectedBytes) {
        await reader.cancel("recording part exceeds its declared size").catch(() => undefined);
        throw new Error("INTERVIEW_RECORDING_PART_SIZE_INVALID");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedBytes) throw new Error("INTERVIEW_RECORDING_PART_SIZE_INVALID");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function partSha256(bytes: Uint8Array) {
  const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", exact);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function PUT(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const sessionId = request.headers.get("X-Interview-Session")?.trim() ?? "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "オンライン一次面接の接続情報が正しくありません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
    }
    const index = Number(request.headers.get("X-Recording-Part-Index"));
    const byteSize = Number(request.headers.get("X-Recording-Part-Bytes"));
    const sha256Header = request.headers.get("X-Recording-Part-Sha256");
    const sha256 = sha256Header?.trim().toLowerCase();
    // A missing digest is passed to persistence only so an upload that started
    // as legacy Version 1 before this release can finish. New Version 2 state
    // rejects it there; any supplied value must always be an exact SHA-256.
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_PART_BYTES || (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) || !request.body) {
      return noStoreJson({ error: "録画データの一部を確認できません。" }, { status: 400 });
    }
    // Buffer at most one validated 8 MiB part. This prevents a truncated body
    // from creating an immutable deterministic R2 object that every later retry
    // would have to reject as a conflicting upload.
    const body = await readExactPartBytes(request.body, byteSize);
    const actualSha256 = await partSha256(body);
    if (sha256 && actualSha256 !== sha256) {
      return noStoreJson({ error: "録画データの一部を確認できません。" }, { status: 400 });
    }
    // Even a pre-deploy client without a digest header gets a server-computed
    // checksum. This preserves rollout compatibility without allowing a caller
    // to downgrade same-size content verification by omitting uploadVersion/SHA.
    const result = await saveResumableInterviewRecordingPart({
      sessionId,
      index,
      byteSize,
      sha256: actualSha256,
      digestDeclared: sha256 !== undefined,
      body,
    });
    // Echo only the already authenticated and range-validated index. This gives
    // resumable clients an unambiguous receipt without exposing upload state to
    // an unauthenticated caller.
    return noStoreJson({ ...result, index });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code.includes("PART_DIGEST_CONFLICT")
      ? 409
      : code.includes("PART_")
        ? 400
        : code.includes("NOT_STARTED")
          ? 409
          : 500;
    return noStoreJson({ error: status === 500 ? "録画データの一部を保存できませんでした。" : "録画の再開情報を確認できませんでした。" }, { status });
  }
}
