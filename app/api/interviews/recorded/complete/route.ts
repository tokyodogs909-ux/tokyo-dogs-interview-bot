import {
  authorizeInterviewRequest,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
import {
  RECORDED_ANSWER_COUNT,
} from "@/lib/recorded-transcription";
import { finalizeRecordedInterview } from "@/lib/recorded-interview-completion";

export async function POST(request: Request) {
  let sessionId = "";
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const rawBody = await request.text();
    if (rawBody.length > 2_000) {
      return noStoreJson({ error: "完了情報が長すぎます。" }, { status: 413 });
    }
    const payload = JSON.parse(rawBody) as { sessionId?: string; questionCount?: number };
    sessionId = payload.sessionId?.trim() ?? "";
    const questionCount = Number(payload.questionCount);
    if (
      !/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) ||
      !Number.isInteger(questionCount) ||
      questionCount < 1 ||
      questionCount > RECORDED_ANSWER_COUNT
    ) {
      return noStoreJson({ error: "録画式面接の完了情報を確認できません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
    }
    // A lost HTTP response must not make a successfully completed interview look
    // failed on the candidate's retry. The completed D1 state is the receipt.
    if (authorized.session.status === "completed") {
      return noStoreJson({ stored: true, humanReviewRequired: true, alreadyCompleted: true });
    }
    if (!["in_progress", "evaluation_pending", "evaluation_processing"].includes(authorized.session.status)) {
      return noStoreJson({ error: "このオンライン一次面接の受付は完了しています。" }, { status: 409 });
    }
    const completion = await finalizeRecordedInterview(sessionId, questionCount);
    if (completion.state === "pending") {
      return noStoreJson({
        stored: false,
        transcriptionPending: true,
        completedAnswerCount: completion.completedAnswerCount,
        missingAnswerIndexes: completion.missingAnswerIndexes,
        error: "回答音声の文字起こしが完了していません。自動再試行後に面接を受領します。",
      }, { status: 409 });
    }
    if (completion.state === "busy") {
      return noStoreJson({ error: "このオンライン一次面接の受付は進行中、または完了しています。" }, { status: 409 });
    }
    return noStoreJson({ stored: true, humanReviewRequired: true });
  } catch (error) {
    if (error instanceof Error && error.message === "RECORDED_ANSWER_COUNT_MISMATCH") {
      return noStoreJson({ error: "実際に保存された回答数と完了情報が一致しません。" }, { status: 409 });
    }
    if (error instanceof Error && [
      "RECORDED_COMPLETION_NOT_SEALED",
      "INTERVIEW_RECORDING_NOT_READY_FOR_COMPLETION",
      "INTERVIEW_NOT_READY_FOR_COMPLETION",
    ].includes(error.message)) {
      return noStoreJson({ error: "録画と回答数の完了確認がまだ揃っていません。" }, { status: 409 });
    }
    return noStoreJson({ error: "録画式面接の受付を完了できませんでした。" }, { status: 500 });
  }
}
