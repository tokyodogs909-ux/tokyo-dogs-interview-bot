import {
  authorizeReviewerRequest,
  getInterviewReview,
} from "@/lib/interview-persistence";
import { noStoreJson } from "@/lib/openai-server";

export async function GET(request: Request) {
  try {
    const reviewer = await authorizeReviewerRequest(request);
    if (!reviewer) {
      return noStoreJson({ error: "採用担当者の認証を確認できませんでした。" }, { status: 401 });
    }
    const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() ?? "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "面接IDを確認してください。" }, { status: 400 });
    }
    const review = await getInterviewReview(sessionId, reviewer);
    if (!review) {
      return noStoreJson({ error: "該当するオンライン一次面接記録がありません。" }, { status: 404 });
    }
    return noStoreJson({ review });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message === "INTERVIEW_REVIEW_AUTH_UNCONFIGURED" ||
      message === "INTERVIEW_DATABASE_UNAVAILABLE" ? 503 : 500;
    return noStoreJson({
      error: message === "INTERVIEW_REVIEW_AUTH_UNCONFIGURED"
        ? "採用担当者用の認証設定が完了していません。"
        : message === "INTERVIEW_DATABASE_UNAVAILABLE"
          ? "オンライン一次面接記録の保存領域へ接続できません。"
          : "オンライン一次面接記録を取得できませんでした。",
    }, { status });
  }
}
