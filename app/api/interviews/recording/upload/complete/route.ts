import {
  authorizeInterviewRequest,
  completeResumableInterviewRecording,
  failInterviewRecordingUpload,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  let sessionId = "";
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    sessionId = request.headers.get("X-Interview-Session")?.trim() ?? "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "オンライン一次面接の接続情報が正しくありません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
    }
    if (authorized.session.recording_status === "stored") return noStoreJson({ stored: true, alreadyStored: true });
    const result = await completeResumableInterviewRecording(authorized.session);
    return noStoreJson(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (sessionId && !code.includes("PART_MISSING")) await failInterviewRecordingUpload(sessionId);
    const status = code.includes("PART_MISSING") ? 409 : 500;
    return noStoreJson({ error: status === 409 ? "録画データの受信が途中です。自動再送します。" : "録画を確定できませんでした。自動再送します。" }, { status });
  }
}
