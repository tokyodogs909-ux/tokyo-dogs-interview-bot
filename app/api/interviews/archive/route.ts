import { syncInterviewToGoogleDrive } from "@/lib/google-drive-sync";
import { authorizeInterviewRequest } from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

/**
 * Completes the applicant's own Drive archive in the foreground. Cloudflare
 * cancels waitUntil work 30 seconds after a response; a full interview video
 * can take longer than that to stream from R2 to Drive, so the browser keeps
 * this request open until Drive read-back has succeeded.
 */
export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const rawBody = await request.text();
    if (rawBody.length > 1_000) return noStoreJson({ error: "入力内容が長すぎます。" }, { status: 413 });
    const payload = JSON.parse(rawBody) as { sessionId?: unknown };
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim().toUpperCase() : "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "オンライン一次面接の接続情報が正しくありません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
    }
    const result = await syncInterviewToGoogleDrive(sessionId);
    return noStoreJson({ stored: result.status === "completed", recordingIncluded: result.recordingIncluded });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const archiveNotReady = code === "INTERVIEW_NOT_READY_FOR_DRIVE_SYNC" ||
      code === "INTERVIEW_RECORDING_NOT_READY_FOR_DRIVE_SYNC" ||
      code === "INTERVIEW_RECORDING_ARTIFACT_MISSING";
    return noStoreJson({
      error: archiveNotReady
        ? "録画と面接記録の保存完了後に社内格納できます。"
        : "面接記録の社内格納を完了できませんでした。採用担当者が保存状態を確認します。",
    }, { status: archiveNotReady ? 409 : 502 });
  }
}
