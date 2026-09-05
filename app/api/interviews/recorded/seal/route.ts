import {
  authorizeInterviewRequest,
  interviewSessionAllowsCameraMedia,
  interviewSessionHasCompletionHold,
} from "@/lib/interview-persistence";
import { sealRecordedInterviewCompletion } from "@/lib/recorded-transcription";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
import { readBoundedJsonBody } from "@/lib/http-body";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const body = await readBoundedJsonBody<{ sessionId?: unknown; expectedAnswerCount?: unknown }>(request, { maxBytes: 4_000 });
    if (!body.ok) return noStoreJson({ error: body.status === 413 ? "完了情報が長すぎます。" : "録画式面接の完了情報を確認できません。" }, { status: body.status });
    const payload = body.value;
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const expectedAnswerCount = Number(payload.expectedAnswerCount);
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) || !Number.isInteger(expectedAnswerCount)) {
      return noStoreJson({ error: "録画式面接の完了情報を確認できません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
    }
    if (!await interviewSessionAllowsCameraMedia(sessionId)) {
      return noStoreJson({ error: "この面接方式では録画式面接を完了できません。" }, { status: 409 });
    }
    if (interviewSessionHasCompletionHold(authorized.session)) {
      return noStoreJson({ error: "このオンライン一次面接は技術確認中のため完了準備できません。" }, { status: 409 });
    }
    if (!["in_progress", "evaluation_pending", "evaluation_processing"].includes(authorized.session.status)) {
      if (authorized.session.status === "completed") {
        const seal = await sealRecordedInterviewCompletion(sessionId, expectedAnswerCount);
        return noStoreJson({
          sealed: true,
          expectedAnswerCount: seal.expectedAnswerCount,
          alreadyCompleted: true,
        });
      }
      return noStoreJson({ error: "このオンライン一次面接は完了準備を受け付ける状態ではありません。" }, { status: 409 });
    }
    const seal = await sealRecordedInterviewCompletion(sessionId, expectedAnswerCount);
    return noStoreJson({ sealed: true, expectedAnswerCount: seal.expectedAnswerCount });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const held = code === "RECORDED_INTERVIEW_HELD";
    const conflict = code === "RECORDED_ANSWER_COUNT_MISMATCH" || held;
    return noStoreJson({
      error: held
        ? "このオンライン一次面接は技術確認中のため完了準備できません。"
        : conflict ? "一度確定した回答数と一致しません。自動上書きは行いません。"
        : "録画式面接の完了準備を保存できませんでした。",
    }, { status: conflict ? 409 : 500 });
  }
}
