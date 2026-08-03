import {
  authorizeInterviewRequest,
  saveResumableInterviewRecordingPart,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

const MAX_PART_BYTES = 8 * 1024 * 1024;

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
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_PART_BYTES || !request.body) {
      return noStoreJson({ error: "録画データの一部を確認できません。" }, { status: 400 });
    }
    const result = await saveResumableInterviewRecordingPart({ sessionId, index, byteSize, body: request.body });
    return noStoreJson(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code.includes("PART_") ? 400 : code.includes("NOT_STARTED") ? 409 : 500;
    return noStoreJson({ error: status === 500 ? "録画データの一部を保存できませんでした。" : "録画の再開情報を確認できませんでした。" }, { status });
  }
}
