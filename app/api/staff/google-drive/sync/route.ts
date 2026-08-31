import { stepInterviewToGoogleDrive } from "@/lib/google-drive-sync";
import { authorizeReviewerRequest } from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
import { readBoundedJsonBody } from "@/lib/http-body";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const reviewer = await authorizeReviewerRequest(request);
    if (!reviewer) {
      return noStoreJson({ error: "採用担当者の認証を確認できませんでした。" }, { status: 401 });
    }
    const body = await readBoundedJsonBody<{
      sessionId?: unknown;
      confirmMissingRecordingAcrossDrive?: unknown;
    }>(request, { maxBytes: 4_000 });
    if (!body.ok) return noStoreJson({ error: body.status === 413 ? "入力内容が長すぎます。" : "入力内容を確認できませんでした。" }, { status: body.status });
    const payload = body.value;
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim().toUpperCase() : "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "面接IDを確認してください。" }, { status: 400 });
    }
    const confirmedMissingRecordingAcrossDrive =
      payload.confirmMissingRecordingAcrossDrive === true;
    const result = await stepInterviewToGoogleDrive(sessionId, {
      confirmMissingRecordingAcrossDrive: confirmedMissingRecordingAcrossDrive,
      missingRecordingRepairReviewer: confirmedMissingRecordingAcrossDrive
        ? reviewer
        : undefined,
    });
    const synced = result.status === "completed" && result.integrity?.status === "verified";
    return noStoreJson({ synced, result, reviewer });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const archiveNotReady = code === "INTERVIEW_NOT_READY_FOR_DRIVE_SYNC" ||
      code === "INTERVIEW_RECORDING_NOT_READY_FOR_DRIVE_SYNC" ||
      code === "INTERVIEW_RECORDING_ARTIFACT_MISSING" ||
      code === "INTERVIEW_TRANSCRIPT_NOT_READY_FOR_DRIVE_SYNC";
    const manualAttention = code === "GOOGLE_DRIVE_SYNC_MANUAL_ATTENTION_REQUIRED";
    const integrityDrift = code === "GOOGLE_DRIVE_ARCHIVE_INTEGRITY_DRIFT";
    const integrityUnknown = code === "GOOGLE_DRIVE_ARCHIVE_INTEGRITY_UNCONFIRMED";
    const recordingConfirmationRequired =
      code === "GOOGLE_DRIVE_RECORDING_REPAIR_CONFIRMATION_REQUIRED";
    const recordingMoved =
      code === "GOOGLE_DRIVE_ARCHIVE_RECORDING_MOVED_MANUAL_ATTENTION";
    const recordingTrashed =
      code === "GOOGLE_DRIVE_ARCHIVE_RECORDING_TRASHED_RESTORE_REQUIRED";
    const status = code === "INTERVIEW_NOT_FOUND" ? 404
      : code.includes("CONFIGURATION") || code.includes("AUTH_UNCONFIGURED") ? 503
        : integrityUnknown ? 503
          : archiveNotReady || manualAttention || integrityDrift ||
            recordingConfirmationRequired || recordingMoved || recordingTrashed ? 409
          : 502;
    return noStoreJson({
      error: code === "INTERVIEW_NOT_FOUND"
        ? "該当するオンライン一次面接記録がありません。"
        : manualAttention
          ? "この記録は重複防止のため自動再試行を停止しています。既存のDriveフォルダと保存失敗通知を確認してください。"
        : recordingConfirmationRequired
          ? "Drive全体とゴミ箱に同じ面接IDの動画がないことを確認後、動画のみ復旧を実行してください。"
        : recordingMoved
          ? "動画が別の場所に残っている可能性があるため、新規作成せず停止しました。Drive全体を確認してください。"
        : recordingTrashed
          ? "元の動画がGoogle Driveのゴミ箱にあります。重複防止のため新規作成せず、元の動画を復元してください。"
        : integrityDrift
          ? "Google Driveの保存内容に差異があります。自動更新せず担当者確認へ停止しました。"
        : integrityUnknown
          ? "Google Driveの保存内容を現在確認できません。確認できるまで完了扱いにしません。"
        : archiveNotReady
          ? "評価と録画の保存完了後にGoogle Driveへ格納できます。"
          : code.includes("CONFIGURATION")
            ? "Google Driveの認証設定が完了していません。"
            : "Google Driveへの格納を完了できませんでした。再実行するか管理者へ連絡してください。",
    }, { status });
  }
}
