import { authorizeInterviewRequest } from "@/lib/interview-persistence";
import { sealRecordedInterviewCompletion } from "@/lib/recorded-transcription";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const rawBody = await request.text();
    if (rawBody.length > 1_000) return noStoreJson({ error: "完了情報が長すぎます。" }, { status: 413 });
    const payload = JSON.parse(rawBody) as { sessionId?: unknown; expectedAnswerCount?: unknown };
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const expectedAnswerCount = Number(payload.expectedAnswerCount);
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) || !Number.isInteger(expectedAnswerCount)) {
      return noStoreJson({ error: "録画式面接の完了情報を確認できません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
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
    const conflict = code === "RECORDED_ANSWER_COUNT_MISMATCH";
    return noStoreJson({
      error: conflict
        ? "一度確定した回答数と一致しません。自動上書きは行いません。"
        : "録画式面接の完了準備を保存できませんでした。",
    }, { status: conflict ? 409 : 500 });
  }
}
