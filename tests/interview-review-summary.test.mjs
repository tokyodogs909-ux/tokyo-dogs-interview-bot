import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERVIEW_REPORT_PRESENTATION_VERSION,
  buildCandidateReviewOutline,
  buildCandidateValueHighlights,
  buildInterviewQuestionAnswers,
} from "../lib/interview-review-summary.js";

test("groups interviewer prompts with the following candidate response without rewriting either", () => {
  const transcript = [
    { id: "q1a", speaker: "interviewer", text: "これまでの仕事を教えてください。", createdAt: "2026-08-23T00:00:00Z" },
    { id: "q1b", speaker: "interviewer", text: "担当業務もお願いします。", createdAt: "2026-08-23T00:00:01Z" },
    { id: "a1a", speaker: "candidate", text: "接客を担当しました。", createdAt: "2026-08-23T00:00:02Z" },
    { id: "a1b", speaker: "candidate", text: "新人研修も行いました。", createdAt: "2026-08-23T00:00:03Z" },
    { id: "q2", speaker: "interviewer", text: "大切にしていることは何ですか。", createdAt: "2026-08-23T00:00:04Z" },
    { id: "a2", speaker: "candidate", text: "報告を早くすることです。", createdAt: "2026-08-23T00:00:05Z" },
  ];
  assert.deepEqual(buildInterviewQuestionAnswers(transcript), [
    {
      number: 1,
      question: "これまでの仕事を教えてください。\n担当業務もお願いします。",
      answer: "接客を担当しました。\n新人研修も行いました。",
      questionTurnIds: ["q1a", "q1b"],
      answerTurnIds: ["a1a", "a1b"],
    },
    {
      number: 2,
      question: "大切にしていることは何ですか。",
      answer: "報告を早くすることです。",
      questionTurnIds: ["q2"],
      answerTurnIds: ["a2"],
    },
  ]);
});

test("never presents legacy placeholder answers as an actual question-and-answer record", () => {
  assert.deepEqual(buildInterviewQuestionAnswers([
    { id: "recorded-fallback-question-1", speaker: "interviewer", text: "質問", createdAt: "" },
    { id: "recorded-fallback-answer-1", speaker: "candidate", text: "固定記録", createdAt: "" },
  ]), []);
});

test("shows only evidence-backed value highlights and keeps unconfirmed dimensions out", () => {
  const evaluation = {
    summary: "報告と安全確認を大切にしています。二文目は詳細です。",
    strengths: ["早めの報告"],
    concerns: ["勤務開始日は再確認"],
    missingTopics: ["送迎範囲"],
    conditions: ["土日勤務は相談可能"],
    dimensions: [
      { name: "責任感・誠実性", score: 4, rationale: "問題発生時にすぐ報告すると説明しています。追加説明。", evidence: [{ quote: "すぐ報告します" }] },
      { name: "学習意欲・継続力", score: null, rationale: "根拠不足です。", evidence: [] },
    ],
  };
  assert.deepEqual(buildCandidateValueHighlights(evaluation), [
    { label: "責任感・誠実さ", text: "問題発生時にすぐ報告すると説明しています。", evidenceCount: 1 },
  ]);
  assert.deepEqual(buildCandidateReviewOutline(evaluation), {
    summary: "報告と安全確認を大切にしています。",
    strengths: ["早めの報告"],
    concerns: ["勤務開始日は再確認"],
    missingTopics: ["送迎範囲"],
    conditions: ["土日勤務は相談可能"],
  });
  assert.match(INTERVIEW_REPORT_PRESENTATION_VERSION, /^\d{4}-\d{2}-\d{2}-v\d+$/);
});
