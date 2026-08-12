import {
  EVALUATION_DIMENSIONS,
  INTERVIEW_TOPIC_IDS,
  type InterviewEvaluation,
} from "@/lib/interview";

export function buildDeferredHumanEvaluation(reason: "service_unavailable" | "recorded_fallback"): InterviewEvaluation {
  const recordedFallback = reason === "recorded_fallback";
  return {
    recommendation: "human_review",
    summary: recordedFallback
      ? "音声回線障害時の録画式予備面接です。回答音声の自動文字起こしは完了していますが、自動評価は行わず、権限を付与された採用担当者が録画と照合します。"
      : "面接記録は保存済みです。自動評価サービスを利用できなかったため、採用担当者が文字起こしと録画を直接確認します。",
    dimensions: EVALUATION_DIMENSIONS.map((name) => ({
      name,
      score: null,
      confidence: "low" as const,
      rationale: recordedFallback
        ? "録画式予備面接は自動評価の対象外のため、録画と文字起こしによる人の確認が必要です。"
        : "自動評価を完了できなかったため点数化せず、人による確認に回します。",
      evidence: [],
    })),
    strengths: [],
    concerns: [],
    contradictions: [],
    missingTopics: INTERVIEW_TOPIC_IDS.map((topicId) => `${topicId}: 人による確認待ち`),
    conditions: [],
    transcriptProvenance: "candidate_device_unverified",
    evidenceValidationWarnings: [
      recordedFallback
        ? "回答本文は応募者端末の回答音声から自動文字起こししたものです。必ず録画と照合してください。"
        : "自動評価サービスを利用できなかったため、点数や自動所見は作成していません。文字起こしと録画を直接確認してください。",
      "カメラ、マイク、音声回線、文字起こし、外部サービスの不具合は応募者の評価に使用しないでください。",
    ],
    humanReviewRequired: true,
  };
}
