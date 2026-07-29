import { syncInterviewToGoogleDrive } from "@/lib/google-drive-sync";
import { authorizeReviewerRequest } from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const reviewer = await authorizeReviewerRequest(request);
    if (!reviewer) {
      return noStoreJson({ error: "採用担当者の認証を確認できませんでした。" }, { status: 401 });
    }
    const rawBody = await request.text();
    if (rawBody.length > 1_000) return noStoreJson({ error: "入力内容が長すぎます。" }, { status: 413 });
    const payload = JSON.parse(rawBody) as { sessionId?: unknown };
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim().toUpperCase() : "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "面接IDを確認してください。" }, { status: 400 });
    }
    const result = await syncInterviewToGoogleDrive(sessionId);
    return noStoreJson({ synced: result.status === "completed", result, reviewer });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code === "INTERVIEW_NOT_FOUND" ? 404
      : code.includes("CONFIGURATION") || code.includes("AUTH_UNCONFIGURED") ? 503
        : code === "INTERVIEW_NOT_READY_FOR_DRIVE_SYNC" ? 409
          : 502;
    return noStoreJson({
      error: code === "INTERVIEW_NOT_FOUND"
        ? "該当するオンライン一次面接記録がありません。"
        : code === "INTERVIEW_NOT_READY_FOR_DRIVE_SYNC"
          ? "評価完了後にGoogle Driveへ格納できます。"
          : code.includes("CONFIGURATION")
            ? "Google Driveの認証設定が完了していません。"
            : "Google Driveへの格納を完了できませんでした。再実行するか管理者へ連絡してください。",
    }, { status });
  }
}
