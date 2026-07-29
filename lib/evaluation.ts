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
        "next_interview_recommended",
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

