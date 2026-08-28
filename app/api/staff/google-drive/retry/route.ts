import { stepInterviewToGoogleDrive } from "@/lib/google-drive-sync";
import {
  authorizeReviewerRequest,
  releaseExternalSyncRetryHold,
} from "@/lib/interview-persistence";
import { readBoundedJsonBody } from "@/lib/http-body";
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
    const body = await readBoundedJsonBody<{ sessionId?: unknown }>(request, { maxBytes: 4_000 });
    if (!body.ok) {
      return noStoreJson({ error: "入力内容を確認できませんでした。" }, { status: body.status });
    }
    const sessionId = typeof body.value.sessionId === "string"
      ? body.value.sessionId.trim().toUpperCase()
      : "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "面接IDを確認してください。" }, { status: 400 });
    }
    const released = await releaseExternalSyncRetryHold({ sessionId, reviewer });
    if (!released) {
      return noStoreJson({ error: "再試行停止中の記録ではないか、すでに再開されています。" }, { status: 409 });
    }
    const result = await stepInterviewToGoogleDrive(sessionId);
    return noStoreJson({
      released: true,
      synced: result.status === "completed" && result.integrity?.status === "verified",
      result,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return noStoreJson({
      released: true,
      error: code === "GOOGLE_DRIVE_SYNC_MANUAL_ATTENTION_REQUIRED"
        ? "安全な1回再試行が失敗し、再び自動停止しました。既存のDriveフォルダを確認してください。"
        : "安全な1回再試行を完了できませんでした。自動連続再試行は行いません。",
    }, { status: 502 });
  }
}
