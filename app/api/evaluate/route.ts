import {
  normalizePreferredLocation,
  type TranscriptTurn,
} from "@/lib/interview";
import {
  noStoreJson,
  hasTrustedRequestOrigin,
} from "@/lib/openai-server";
import {
  authorizeInterviewRequest,
  claimInterviewEvaluation,
  failInterviewEvaluation,
  saveInterviewEvaluation,
} from "@/lib/interview-persistence";
import { buildDeferredHumanEvaluation } from "@/lib/interview-evaluation-fallback";
import { evaluateInterviewTranscript } from "@/lib/interview-evaluation-service";
import { readBoundedJsonBody } from "@/lib/http-body";

function cleanTurns(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 300).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const turn = item as Partial<TranscriptTurn>;
    if (
      typeof turn.id !== "string" ||
      (turn.speaker !== "candidate" && turn.speaker !== "interviewer") ||
      typeof turn.text !== "string"
    ) {
      return [];
    }
    const text = turn.text.replace(/\0/g, "").trim().slice(0, 5000);
    if (!text) return [];
    return [{
      id: turn.id.slice(0, 120),
      speaker: turn.speaker,
      text,
      createdAt: typeof turn.createdAt === "string" ? turn.createdAt.slice(0, 40) : "",
    }];
  });
}

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const body = await readBoundedJsonBody<{
      sessionId?: string;
      employment?: string;
      location?: string;
      transcript?: unknown;
    }>(request, { maxBytes: 600_000 });
    if (!body.ok) {
      return noStoreJson({
        error: body.status === 413 ? "文字起こしが長すぎます。" : "評価情報を確認できませんでした。",
      }, { status: body.status });
    }
    const payload = body.value;
    const sessionId = payload.sessionId?.trim() ?? "";
    const location = normalizePreferredLocation(payload.location);
    const transcript = cleanTurns(payload.transcript);
    const hasCandidateAnswer = transcript.some(
      (turn) => turn.speaker === "candidate" && turn.text.trim().length > 0,
    );
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) || !hasCandidateAnswer) {
      return noStoreJson({ error: "評価に必要なオンライン一次面接記録がありません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized) {
      return noStoreJson(
        { error: "オンライン一次面接の有効期限または認証を確認してください。" },
        { status: 401 },
      );
    }
    if (
      authorized.session &&
      (authorized.session.employment !== payload.employment ||
        authorized.session.preferred_location !== location)
    ) {
      return noStoreJson({ error: "応募条件とオンライン一次面接の接続情報が一致しません。" }, { status: 409 });
    }
    if (
      Number(authorized.session.candidate_requested_stop ?? 0) === 1 ||
      Number(authorized.session.safety_escalation ?? 0) === 1 ||
      Number(authorized.session.completion_reason_invalid ?? 0) === 1
    ) {
      return noStoreJson({ error: "中止または技術保留となった面接は自動評価・受付完了に進めません。" }, { status: 409 });
    }
    if (Number(authorized.session.candidate_transcription_failed ?? 0) === 1) {
      return noStoreJson({ error: "最終文字起こしが未確定の面接は自動評価・受付完了に進めません。" }, { status: 409 });
    }
    // The model result may have been committed even if the browser never received
    // the HTTP response. Return the durable receipt without paying for or writing
    // a second evaluation so the candidate can safely resume final archiving.
    if (authorized.session.status === "completed") {
      return noStoreJson({ stored: true, alreadyStored: true });
    }
    if (!["in_progress", "evaluation_pending", "evaluation_processing"].includes(authorized.session.status)) {
      return noStoreJson({ error: "このオンライン一次面接の評価受付は完了しています。" }, { status: 409 });
    }

    const evaluationClaimId = await claimInterviewEvaluation({ sessionId, transcript });
    if (!evaluationClaimId) {
      return noStoreJson({ error: "このオンライン一次面接の評価処理は進行中、または完了しています。" }, { status: 409 });
    }

    const automatic = await evaluateInterviewTranscript({
      sessionId,
      employment: payload.employment ?? "未確認",
      preferredLocation: location || "未確認",
      transcript,
      source: "realtime_or_text",
    });

    try {
      const saved = await saveInterviewEvaluation({
        sessionId,
        transcript,
        evaluation: automatic.evaluation ?? buildDeferredHumanEvaluation("service_unavailable"),
        claimId: evaluationClaimId,
      });
      if (!saved) {
        await failInterviewEvaluation(sessionId, evaluationClaimId);
        return noStoreJson({ error: "このオンライン一次面接の評価受付は完了しています。" }, { status: 409 });
      }
      return noStoreJson({
        stored: true,
        humanReviewRequired: true,
        automaticEvaluationDeferred: automatic.automaticEvaluationDeferred,
      });
    } catch (error) {
      await failInterviewEvaluation(sessionId, evaluationClaimId);
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const draftConflict = message.startsWith("TRANSCRIPT_DRAFT_");
    const status = message.includes("OPENAI_API_KEY") ? 503 : draftConflict ? 409 : 500;
    return noStoreJson(
      { error: status === 503
        ? "評価処理のサーバー設定が完了していません。"
        : draftConflict
          ? "保存済みの回答記録と一致しないため、評価を開始できません。"
          : "評価処理を完了できませんでした。" },
      { status },
    );
  }
}
