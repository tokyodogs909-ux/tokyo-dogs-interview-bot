import {
  authorizeReviewerRequest,
  getInterviewRecording,
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
    const recording = await getInterviewRecording(sessionId, reviewer);
    if (!recording) {
      return noStoreJson({ error: "録画が見つかりません。" }, { status: 404 });
    }
    return new Response(recording.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": recording.contentType,
        "Content-Length": String(recording.byteSize),
        "X-Interview-Audio-Coverage": recording.audioCoverage,
        ...(recording.etag ? { ETag: recording.etag } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message === "INTERVIEW_REVIEW_AUTH_UNCONFIGURED" ||
      message === "INTERVIEW_RECORDING_STORAGE_UNAVAILABLE" ? 503 : 500;
    return noStoreJson({
      error: message === "INTERVIEW_REVIEW_AUTH_UNCONFIGURED"
        ? "採用担当者用の認証設定が完了していません。"
        : message === "INTERVIEW_RECORDING_STORAGE_UNAVAILABLE"
          ? "録画の保存領域へ接続できません。"
          : "録画を取得できませんでした。",
    }, { status });
  }
}
