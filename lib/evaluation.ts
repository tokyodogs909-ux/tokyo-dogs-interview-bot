import {
  EVALUATION_DIMENSIONS,
  type EvaluationDimension,
  type InterviewEvaluation,
  type TranscriptTurn,
} from "./interview";

export const evaluationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    recommendation: {
      type: "string",
      enum: [
        "job_related_evidence_complete",
        "human_review",
        "insufficient_information",
      ],
    },
    summary: { type: "string", maxLength: 800 },
    dimensions: {
      type: "array",
      minItems: 7,
      maxItems: 7,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", enum: [...EVALUATION_DIMENSIONS] },
          score: { type: "integer", minimum: 1, maximum: 5 },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          rationale: { type: "string", maxLength: 500 },
          evidence: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                quote: { type: "string", maxLength: 240 },
                turnId: { type: "string", maxLength: 120 },
                relevance: { type: "string", maxLength: 300 },
              },
              required: ["quote", "turnId", "relevance"],
            },
          },
        },
        required: ["name", "score", "confidence", "rationale", "evidence"],
      },
    },
    strengths: { type: "array", maxItems: 6, items: { type: "string", maxLength: 240 } },
    concerns: { type: "array", maxItems: 6, items: { type: "string", maxLength: 240 } },
    contradictions: { type: "array", maxItems: 6, items: { type: "string", maxLength: 240 } },
    missingTopics: { type: "array", maxItems: 10, items: { type: "string", maxLength: 160 } },
    conditions: { type: "array", maxItems: 10, items: { type: "string", maxLength: 240 } },
  },
  required: [
    "recommendation",
    "summary",
    "dimensions",
    "strengths",
    "concerns",
    "contradictions",
    "missingTopics",
    "conditions",
  ],
} as const;

function normalize(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

// Terms that must never justify a score. The evaluation prompt already forbids
// them, but a prompt is not a control: this list is the code-side detector that
// tells the recruiter which sentence to re-read. Detection only — the wording is
// never rewritten or removed, because silently editing an evaluator's text would
// hide the problem instead of surfacing it, and would also risk deleting a
// legitimate job-related sentence on a false match.
//
// Kept deliberately narrow to terms that have no ordinary job-related reading in
// this role, so an alert stays meaningful. Broad words that legitimately appear
// in dog-care answers (年齢, 歳, 家族 alone, …) are excluded on purpose.
const PROHIBITED_ATTRIBUTE_TERMS = [
  "本籍", "出生地", "出身地", "国籍", "人種", "民族",
  "宗教", "信仰", "支持政党", "思想信条", "労働組合", "学生運動",
  "購読新聞", "愛読書", "家族構成", "親の職業", "世帯収入",
  "配偶者", "既婚", "未婚", "婚姻", "妊娠", "出産予定",
  "病歴", "持病", "通院", "診断名", "障害者手帳",
  "前科", "犯罪歴", "資産", "持ち家", "生活保護",
  "性的指向", "性自認", "生年月日",
] as const;

// Conditions the interview must treat as "情報不足", never as a demerit.
const TECHNICAL_FAULT_TERMS = [
  "笑顔", "容姿", "顔立ち", "服装", "髪型", "表情", "声質", "訛り",
  "通信環境", "回線", "マイク", "カメラ", "音質", "画質", "文字起こしの不具合",
] as const;

function findTerms(text: string, terms: readonly string[]) {
  const normalized = normalize(text);
  return terms.filter((term) => normalized.includes(term));
}

function evaluatorFreeText(
  raw: Omit<InterviewEvaluation, "evidenceValidationWarnings" | "humanReviewRequired">,
) {
  return [
    raw.summary,
    ...raw.strengths,
    ...raw.concerns,
    ...raw.contradictions,
    ...raw.conditions,
    ...raw.dimensions.flatMap((dimension) => [
      dimension.rationale,
      ...dimension.evidence.flatMap((evidence) => [evidence.quote, evidence.relevance]),
    ]),
  ].filter((value) => typeof value === "string" && value.length > 0);
}

/**
 * Flags — never rewrites — evaluation prose that mentions a legally prohibited
 * attribute or blames a technical fault, so the recruiter is told exactly what
 * to re-check before using the evaluation.
 */
export function detectUnfairEvaluationLanguage(
  raw: Omit<InterviewEvaluation, "evidenceValidationWarnings" | "humanReviewRequired">,
) {
  const text = evaluatorFreeText(raw);
  const prohibited = [...new Set(text.flatMap((value) => findTerms(value, PROHIBITED_ATTRIBUTE_TERMS)))];
  const technical = [...new Set(text.flatMap((value) => findTerms(value, TECHNICAL_FAULT_TERMS)))];
  const warnings: string[] = [];
  if (prohibited.length > 0) {
    warnings.push(
      `評価本文に職務と無関係な属性の記述が含まれる可能性があります（${prohibited.join("、")}）。該当箇所を確認し、採用判断に使用しないでください。`,
    );
  }
  if (technical.length > 0) {
    warnings.push(
      `評価本文に機器・通信・外見に関する記述が含まれる可能性があります（${technical.join("、")}）。これらは不利益に扱わず、情報不足として確認してください。`,
    );
  }
  return warnings;
}

function findCandidateTurn(turns: TranscriptTurn[], turnId: string) {
  return turns.find((turn) => turn.speaker === "candidate" && turn.id === turnId);
}

function verifyDimensionEvidence(
  dimension: EvaluationDimension,
  turns: TranscriptTurn[],
  warnings: string[],
): EvaluationDimension {
  const evidence = dimension.evidence
    .map((item) => {
      const source = findCandidateTurn(turns, item.turnId);
      const verified = Boolean(
        source && normalize(source.text).includes(normalize(item.quote)),
      );
      if (!verified) {
        warnings.push(`${dimension.name}: 根拠引用を文字起こし内で照合できませんでした。`);
      }
      return { ...item, verified };
    })
    .filter((item) => item.verified);

  if (evidence.length > 0) return { ...dimension, evidence };

  warnings.push(`${dimension.name}: 有効な回答根拠がないため採点を保留しました。`);
  return {
    ...dimension,
    score: null,
    confidence: "low",
    evidence: [],
    rationale: `${dimension.rationale}（回答根拠の照合ができないため要確認）`,
  };
}

export function validateEvaluation(
  raw: Omit<InterviewEvaluation, "evidenceValidationWarnings" | "humanReviewRequired">,
  turns: TranscriptTurn[],
): InterviewEvaluation {
  const warnings: string[] = [];
  const byName = new Map(raw.dimensions.map((item) => [item.name, item]));
  const dimensions = EVALUATION_DIMENSIONS.map((name) => {
    const dimension = byName.get(name);
    if (!dimension) {
      warnings.push(`${name}: 評価項目が生成されなかったため採点を保留しました。`);
      return {
        name,
        score: null,
        confidence: "low" as const,
        rationale: "情報不足のため採点できません。",
        evidence: [],
      };
    }
    return verifyDimensionEvidence(dimension, turns, warnings);
  });

  const candidateCharacters = turns
    .filter((turn) => turn.speaker === "candidate")
    .reduce((total, turn) => total + normalize(turn.text).length, 0);
  const verifiedDimensionCount = dimensions.filter(
    (dimension) => dimension.score !== null && dimension.evidence.length > 0,
  ).length;

  // Scanned after evidence verification so only text that actually reaches the
  // recruiter's record is flagged.
  warnings.push(...detectUnfairEvaluationLanguage({ ...raw, dimensions }));

  let recommendation = raw.recommendation;
  if (candidateCharacters < 220 || verifiedDimensionCount < 4) {
    recommendation = "insufficient_information";
  } else if (
    raw.contradictions.length > 0 ||
    raw.missingTopics.length > 2 ||
    warnings.length > 0
  ) {
    recommendation = "human_review";
  }

  return {
    ...raw,
    recommendation,
    dimensions,
    evidenceValidationWarnings: [...new Set(warnings)],
    humanReviewRequired: true,
  };
}

export function extractResponseText(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return "";
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "output_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
    }
  }
  return "";
}
