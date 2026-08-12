import {
  authorizeReviewerRequest,
  listInterviewSummaries,
} from "@/lib/interview-persistence";
import { planDriveRecovery, planRecordingRecovery, summarizeDriveArchives } from "@/lib/drive-recovery.js";
import { scheduleGoogleDriveSync } from "@/lib/google-drive-sync";
import { scheduleInterruptedInterviewRecovery } from "@/lib/interview-recovery";
import { noStoreJson } from "@/lib/openai-server";

export async function GET(request: Request) {
  try {
    const reviewer = await authorizeReviewerRequest(request);
    if (!reviewer) {
      return noStoreJson({ error: "採用担当者の認証を確認できませんでした。" }, { status: 401 });
    }
    const polling = new URL(request.url).searchParams.get("poll") === "1";
    const interviews = await listInterviewSummaries(reviewer, 50, { audit: !polling });
    const recordingRecoverySessionIds = planRecordingRecovery(interviews) as string[];
    recordingRecoverySessionIds.forEach((sessionId) => scheduleInterruptedInterviewRecovery(sessionId));
    const recoverySessionIds = planDriveRecovery(interviews) as string[];
    recoverySessionIds.forEach((sessionId) => scheduleGoogleDriveSync(sessionId));
    return noStoreJson({
      interviews,
      archiveHealth: summarizeDriveArchives(interviews, [
        ...recordingRecoverySessionIds,
        ...recoverySessionIds,
      ]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message === "INTERVIEW_REVIEW_AUTH_UNCONFIGURED" ||
      message === "INTERVIEW_DATABASE_UNAVAILABLE" ? 503 : 500;
    return noStoreJson({
      error: message === "INTERVIEW_REVIEW_AUTH_UNCONFIGURED"
        ? "採用担当者用の認証設定が完了していません。"
        : message === "INTERVIEW_DATABASE_UNAVAILABLE"
          ? "オンライン一次面接記録の保存領域へ接続できません。"
          : "候補者一覧を取得できませんでした。",
    }, { status });
  }
}
