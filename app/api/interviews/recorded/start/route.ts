import {
  authorizeInterviewRequest,
  interviewSessionHasCompletionHold,
  markRecordedFallbackStarted,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const sessionId = request.headers.get("X-Interview-Session")?.trim() ?? "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "オンライン一次面接の接続情報が正しくありません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
    }
    if (interviewSessionHasCompletionHold(authorized.session)) {
      return noStoreJson({ error: "このオンライン一次面接は技術確認中のため開始できません。" }, { status: 409 });
    }
    if (!["created", "in_progress"].includes(authorized.session.status)) {
      return noStoreJson({ error: "このオンライン一次面接は開始できません。" }, { status: 409 });
    }
    await markRecordedFallbackStarted(sessionId);
    return noStoreJson({ started: true });
  } catch (error) {
    if (error instanceof Error && error.message === "RECORDED_INTERVIEW_HELD") {
      return noStoreJson({ error: "このオンライン一次面接は技術確認中のため開始できません。" }, { status: 409 });
    }
    return noStoreJson({ error: "録画式のオンライン一次面接を開始できませんでした。" }, { status: 500 });
  }
}
