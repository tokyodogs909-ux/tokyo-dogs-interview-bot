import {
  EVALUATION_DIMENSIONS,
  INTERVIEW_TOPIC_IDS,
  RECORDED_FALLBACK_QUESTIONS,
  type InterviewEvaluation,
  type TranscriptTurn,
} from "@/lib/interview";
import {
  authorizeInterviewRequest,
  claimInterviewEvaluation,
  failInterviewEvaluation,
  saveInterviewEvaluation,
} from "@/lib/interview-persistence";
import { scheduleGoogleDriveSync } from "@/lib/google-drive-sync";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

function canonicalRecordedTranscript(): TranscriptTurn[] {
  const now = new Date().toISOString();
  return RECORDED_FALLBACK_QUESTIONS.flatMap((question, index) => [
    {
      id: `recorded-fallback-question-${index + 1}`,
      speaker: "interviewer" as const,
      text: question,
      createdAt: now,
    },
    {
      id: `recorded-fallback-answer-${index + 1}`,
      speaker: "candidate" as const,
      text: `回答${index + 1}の発言内容は録画音声に記録されています。自動文字起こしではないため、採用担当者が録画を確認します。`,
      createdAt: now,
    },
  ]);
}

function recordedFallbackEvaluation(): InterviewEvaluation {
  return {
    recommendation: "insufficient_information",
    summary: "音声回線障害時の録画式予備面接です。回答本文の自動文字起こしと自動評価は未実施のため、権限を付与された採用担当者が録画を確認します。",
    dimensions: EVALUATION_DIMENSIONS.map((name) => ({
      name,
      score: null,
      confidence: "low" as const,
      rationale: "自動文字起こしのない予備面接のため、録画による人の確認が必要です。",
      evidence: [],
    })),
    strengths: [],
    concerns: [],
    contradictions: [],
    missingTopics: INTERVIEW_TOPIC_IDS.map((topicId) => `${topicId}: 録画確認待ち`),
    conditions: [],
    transcriptProvenance: "candidate_device_unverified",
    evidenceValidationWarnings: [
      "応募者の回答本文は自動文字起こしされていません。録画を確認してください。",
      "カメラ、マイク、音声回線の不具合は応募者の評価に使用しないでください。",
    ],
    humanReviewRequired: true,
  };
}

export async function POST(request: Request) {
  let claimId = "";
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
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) || payload.questionCount !== RECORDED_FALLBACK_QUESTIONS.length) {
      return noStoreJson({ error: "録画式面接の完了情報を確認できません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
    }
    if (!["in_progress", "evaluation_pending"].includes(authorized.session.status)) {
      return noStoreJson({ error: "このオンライン一次面接の受付は完了しています。" }, { status: 409 });
    }
    const transcript = canonicalRecordedTranscript();
    claimId = await claimInterviewEvaluation({ sessionId, transcript }) ?? "";
    if (!claimId) {
      return noStoreJson({ error: "このオンライン一次面接の受付は進行中、または完了しています。" }, { status: 409 });
    }
    const saved = await saveInterviewEvaluation({
      sessionId,
      transcript,
      evaluation: recordedFallbackEvaluation(),
      claimId,
    });
    if (!saved) {
      return noStoreJson({ error: "録画式面接の受付を完了できませんでした。" }, { status: 409 });
    }
    scheduleGoogleDriveSync(sessionId);
    return noStoreJson({ stored: true, humanReviewRequired: true });
  } catch {
    if (claimId && sessionId) await failInterviewEvaluation(sessionId, claimId);
    return noStoreJson({ error: "録画式面接の受付を完了できませんでした。" }, { status: 500 });
  }
}
