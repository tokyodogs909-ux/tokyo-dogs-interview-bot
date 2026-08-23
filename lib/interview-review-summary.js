export const INTERVIEW_REPORT_PRESENTATION_VERSION = "2026-08-23-v1";

const VALUE_DIMENSION_LABELS = new Map([
  ["理念・志望動機", "志望理由・仕事観"],
  ["素直さ・改善行動", "問題への向き合い方"],
  ["責任感・誠実性", "責任感・誠実さ"],
  ["接客・対話力", "人との関わり方"],
  ["学習意欲・継続力", "学び方・続け方"],
  ["犬と人への安全配慮", "安全への考え方"],
  ["勤務条件の適合性", "働き方・勤務条件"],
]);

function normalizedText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim()
    : "";
}

function conciseSentence(value, maximumLength = 220) {
  const text = normalizedText(value);
  if (!text) return "";
  const firstSentence = text.match(/^.*?[。！？]/)?.[0]?.trim() ?? text;
  if (firstSentence.length <= maximumLength) return firstSentence;
  return `${firstSentence.slice(0, maximumLength - 1).trim()}…`;
}

/**
 * Converts a chronological transcript into recruiter-friendly question and
 * answer groups without inventing topics or rewriting candidate statements.
 * Consecutive interviewer turns stay together, as do consecutive candidate
 * turns. Placeholder-only legacy recordings never become apparent answers.
 *
 * @param {Array<{id?: unknown, speaker?: unknown, text?: unknown, createdAt?: unknown}> | null | undefined} transcript
 */
export function buildInterviewQuestionAnswers(transcript) {
  if (!Array.isArray(transcript)) return [];
  if (transcript.some((turn) =>
    turn?.speaker === "candidate" &&
    typeof turn?.id === "string" &&
    turn.id.startsWith("recorded-fallback-answer-"))) return [];

  const turns = transcript.slice(0, 300).flatMap((turn) => {
    const text = normalizedText(turn?.text);
    if (!text || (turn?.speaker !== "candidate" && turn?.speaker !== "interviewer")) return [];
    return [{
      id: typeof turn?.id === "string" ? turn.id.slice(0, 120) : "",
      speaker: turn.speaker,
      text,
      createdAt: typeof turn?.createdAt === "string" ? turn.createdAt.slice(0, 40) : "",
    }];
  });

  /** @type {Array<{number: number, question: string, answer: string, questionTurnIds: string[], answerTurnIds: string[]}>} */
  const groups = [];
  /** @type {Array<{id: string, text: string}>} */
  let questions = [];
  /** @type {Array<{id: string, text: string}>} */
  let answers = [];

  const flush = () => {
    if (answers.length === 0) {
      questions = [];
      return;
    }
    groups.push({
      number: groups.length + 1,
      question: questions.length > 0
        ? questions.map((turn) => turn.text).join("\n")
        : "直前の質問（質問文の記録なし）",
      answer: answers.map((turn) => turn.text).join("\n"),
      questionTurnIds: questions.map((turn) => turn.id).filter(Boolean),
      answerTurnIds: answers.map((turn) => turn.id).filter(Boolean),
    });
    questions = [];
    answers = [];
  };

  for (const turn of turns) {
    if (turn.speaker === "interviewer") {
      if (answers.length > 0) flush();
      questions.push({ id: turn.id, text: turn.text });
    } else {
      answers.push({ id: turn.id, text: turn.text });
    }
  }
  flush();
  return groups;
}

/**
 * Produces short, evidence-bound headings from the stored evaluation. It does
 * not infer personality, protected characteristics, or a hiring outcome.
 * Dimensions without verified transcript evidence remain visibly unconfirmed.
 *
 * @param {Record<string, unknown> | null | undefined} evaluation
 */
export function buildCandidateValueHighlights(evaluation) {
  if (!evaluation || typeof evaluation !== "object") return [];
  const dimensions = Array.isArray(evaluation.dimensions) ? evaluation.dimensions : [];
  const highlights = dimensions.flatMap((dimension) => {
    if (!dimension || typeof dimension !== "object") return [];
    const label = VALUE_DIMENSION_LABELS.get(String(dimension.name ?? ""));
    const rationale = conciseSentence(dimension.rationale);
    const evidenceCount = Array.isArray(dimension.evidence)
      ? dimension.evidence.filter((item) => normalizedText(item?.quote)).length
      : 0;
    if (!label || !rationale || dimension.score === null || evidenceCount === 0) return [];
    return [{ label, text: rationale, evidenceCount }];
  });

  const conditions = Array.isArray(evaluation.conditions)
    ? evaluation.conditions.map(normalizedText).filter(Boolean)
    : [];
  if (conditions.length > 0) {
    highlights.push({
      label: "希望条件・確認事項",
      text: conciseSentence(conditions.join(" / ")),
      evidenceCount: 0,
    });
  }
  return highlights.slice(0, 7);
}

/** @param {Record<string, unknown> | null | undefined} evaluation */
export function buildCandidateReviewOutline(evaluation) {
  if (!evaluation || typeof evaluation !== "object") {
    return { summary: "回答分析は未作成です。", strengths: [], concerns: [], missingTopics: [], conditions: [] };
  }
  const list = (value) => Array.isArray(value) ? value.map(normalizedText).filter(Boolean).slice(0, 12) : [];
  return {
    summary: conciseSentence(evaluation.summary, 360) || "回答分析は未作成です。",
    strengths: list(evaluation.strengths),
    concerns: list(evaluation.concerns),
    missingTopics: list(evaluation.missingTopics),
    conditions: list(evaluation.conditions),
  };
}
