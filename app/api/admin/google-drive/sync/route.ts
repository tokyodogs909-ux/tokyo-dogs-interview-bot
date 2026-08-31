import { authorizeInterviewAdmin } from "@/lib/admin-auth";
import { stepInterviewToGoogleDrive } from "@/lib/google-drive-sync";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
import { readBoundedJsonBody } from "@/lib/http-body";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    if (!await authorizeInterviewAdmin(request)) {
      return noStoreJson({ error: "管理者認証を確認できません。" }, { status: 401 });
    }
    const body = await readBoundedJsonBody<{ sessionId?: unknown }>(request, { maxBytes: 4_000 });
    if (!body.ok) return noStoreJson({ error: body.status === 413 ? "入力内容が長すぎます。" : "入力内容を確認できませんでした。" }, { status: body.status });
    const payload = body.value;
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim().toUpperCase() : "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "面接IDを確認してください。" }, { status: 400 });
    }
    const result = await stepInterviewToGoogleDrive(sessionId);
    return noStoreJson({
      synced: result.status === "completed" && result.integrity?.status === "verified",
      result,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const archiveNotReady = code === "INTERVIEW_NOT_READY_FOR_DRIVE_SYNC" ||
      code === "INTERVIEW_RECORDING_NOT_READY_FOR_DRIVE_SYNC" ||
      code === "INTERVIEW_RECORDING_ARTIFACT_MISSING" ||
      code === "INTERVIEW_TRANSCRIPT_NOT_READY_FOR_DRIVE_SYNC";
    const integrityDrift = code === "GOOGLE_DRIVE_ARCHIVE_INTEGRITY_DRIFT";
    const integrityUnknown = code === "GOOGLE_DRIVE_ARCHIVE_INTEGRITY_UNCONFIRMED";
    const recordingConfirmationRequired =
      code === "GOOGLE_DRIVE_RECORDING_REPAIR_CONFIRMATION_REQUIRED";
    const status = code === "INTERVIEW_NOT_FOUND" ? 404
      : code.includes("CONFIGURATION") || code.includes("AUTH_UNCONFIGURED") ? 503
        : integrityUnknown ? 503
          : archiveNotReady || integrityDrift || recordingConfirmationRequired ? 409
          : 502;
    return noStoreJson({
      error: code === "INTERVIEW_NOT_FOUND"
        ? "該当するオンライン一次面接記録がありません。"
        : archiveNotReady
          ? "評価と録画の保存完了後にGoogle Driveへ格納できます。"
          : recordingConfirmationRequired
            ? "録画の後発欠落を検出しました。重複防止のため、採用担当者画面でDrive全体を確認してから動画のみ復旧してください。"
          : integrityDrift
            ? "Google Driveの保存内容に差異があります。自動更新せず担当者確認へ停止しました。"
          : integrityUnknown
            ? "Google Driveの保存内容を現在確認できません。確認できるまで完了扱いにしません。"
          : code.includes("CONFIGURATION")
            ? "Google Driveの認証設定が完了していません。"
            : "Google Driveへの格納を完了できませんでした。",
    }, { status });
  }
}
