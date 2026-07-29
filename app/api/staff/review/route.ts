import { VIDEO_REVIEW_DIMENSIONS } from "@/lib/interview";
import {
  authorizeReviewerRequest,
  saveHumanVideoReview,
  type VideoReviewScore,
} from "@/lib/interview-persistence";
import { noStoreJson } from "@/lib/openai-server";

function cleanScores(value: unknown): VideoReviewScore[] | null {
  if (!Array.isArray(value) || value.length !== VIDEO_REVIEW_DIMENSIONS.length) return null;
  const clean = VIDEO_REVIEW_DIMENSIONS.map((dimension) => {
    const raw = value.find((item) => item && typeof item === "object" && item.name === dimension.name) as {
      score?: unknown;
      note?: unknown;
    } | undefined;
    if (!raw) return null;
    const score = raw.score === null ? null : Number(raw.score);
    if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) return null;
    return {
      name: dimension.name,
      score,
      note: typeof raw.note === "string" ? raw.note.replace(/\0/g, "").trim().slice(0, 1000) : "",
    };
  });
  return clean.every(Boolean) ? clean as VideoReviewScore[] : null;
}

export async function POST(request: Request) {
  try {
    const reviewer = await authorizeReviewerRequest(request);
    if (!reviewer) {
      return noStoreJson({ error: "採用担当者の認証を確認できませんでした。" }, { status: 401 });
    }
    const rawBody = await request.text();
    if (rawBody.length > 10_000) {
      return noStoreJson({ error: "評価内容が長すぎます。" }, { status: 413 });
    }
    const payload = JSON.parse(rawBody) as {
      sessionId?: string;
      scores?: unknown;
      overallNote?: unknown;
    };
    const sessionId = payload.sessionId?.trim() ?? "";
    const scores = cleanScores(payload.scores);
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) || !scores) {
      return noStoreJson({ error: "面接IDまたは映像評価を確認してください。" }, { status: 400 });
    }
    const saved = await saveHumanVideoReview({
      sessionId,
      reviewer,
      scores,
      overallNote: typeof payload.overallNote === "string"
        ? payload.overallNote.replace(/\0/g, "").trim().slice(0, 3000)
        : "",
    });
    if (!saved) {
      return noStoreJson({ error: "該当するオンライン一次面接記録がありません。" }, { status: 404 });
    }
    return noStoreJson({ stored: true, reviewer });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message === "INTERVIEW_REVIEW_AUTH_UNCONFIGURED" ||
      message === "INTERVIEW_DATABASE_UNAVAILABLE" ? 503 : 500;
    return noStoreJson({
      error: message === "INTERVIEW_REVIEW_AUTH_UNCONFIGURED"
        ? "採用担当者用の認証設定が完了していません。"
        : "映像評価を保存できませんでした。",
    }, { status });
  }
}
