import { RECORDED_FALLBACK_QUESTIONS, type TranscriptTurn } from "@/lib/interview";
import { buildDeferredHumanEvaluation } from "@/lib/interview-evaluation-fallback";
import {
  claimInterviewEvaluation,
  failInterviewEvaluation,
  getInterviewSessionState,
  saveInterviewEvaluation,
} from "@/lib/interview-persistence";
import {
  getCompletedRecordedAnswerTranscripts,
  getRecordedInterviewCompletionSeal,
} from "@/lib/recorded-transcription";

function recordedTranscript(
  answers: Array<{ answerIndex: number; text: string }>,
): TranscriptTurn[] {
  const now = new Date().toISOString();
  return RECORDED_FALLBACK_QUESTIONS.slice(0, answers.length).flatMap((question, index) => [
    {
      id: `recorded-transcribed-question-${index + 1}`,
      speaker: "interviewer" as const,
      text: question,
      createdAt: now,
    },
    {
      id: `recorded-transcribed-answer-${index + 1}`,
      speaker: "candidate" as const,
      text: answers[index].text,
      createdAt: now,
    },
  ]);
}

export type RecordedInterviewCompletionResult =
  | { state: "completed" }
  | { state: "pending"; completedAnswerCount: number; missingAnswerIndexes: number[] }
  | { state: "busy" };

export async function finalizeRecordedInterview(
  sessionId: string,
  questionCount: number,
): Promise<RecordedInterviewCompletionResult> {
  const session = await getInterviewSessionState(sessionId);
  if (!session) throw new Error("INTERVIEW_NOT_FOUND");
  if (session.recording_status !== "stored") {
    throw new Error("INTERVIEW_RECORDING_NOT_READY_FOR_COMPLETION");
  }
  if (!["in_progress", "evaluation_pending", "evaluation_processing"].includes(session.status)) {
    if (session.status === "completed") return { state: "completed" };
    throw new Error("INTERVIEW_NOT_READY_FOR_COMPLETION");
  }
  const seal = await getRecordedInterviewCompletionSeal(sessionId);
  if (!seal) throw new Error("RECORDED_COMPLETION_NOT_SEALED");
  if (seal.expectedAnswerCount !== questionCount) {
    throw new Error("RECORDED_ANSWER_COUNT_MISMATCH");
  }
  const completedAnswers = await getCompletedRecordedAnswerTranscripts(sessionId, questionCount);
  const missingAnswerIndexes = completedAnswers
    .map((answer, index) => answer ? null : index + 1)
    .filter((index): index is number => index !== null);
  if (missingAnswerIndexes.length > 0) {
    return {
      state: "pending",
      completedAnswerCount: questionCount - missingAnswerIndexes.length,
      missingAnswerIndexes,
    };
  }
  const transcript = recordedTranscript(completedAnswers as Array<{ answerIndex: number; text: string }>);
  const claimId = await claimInterviewEvaluation({ sessionId, transcript }) ?? "";
  if (!claimId) return { state: "busy" };
  try {
    const saved = await saveInterviewEvaluation({
      sessionId,
      transcript,
      evaluation: buildDeferredHumanEvaluation("recorded_fallback"),
      claimId,
    });
    if (!saved) return { state: "busy" };
    return { state: "completed" };
  } catch (error) {
    await failInterviewEvaluation(sessionId, claimId);
    throw error;
  }
}
