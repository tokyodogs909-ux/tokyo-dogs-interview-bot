import { RECORDED_FALLBACK_QUESTIONS, type TranscriptTurn } from "@/lib/interview";
import { buildDeferredHumanEvaluation } from "@/lib/interview-evaluation-fallback";
import { evaluateInterviewTranscript } from "@/lib/interview-evaluation-service";
import { RECORDED_TRANSCRIPT_EVALUATION_WARNING } from "@/lib/recorded-evaluation-marker";
import {
  claimInterviewEvaluation,
  failInterviewEvaluation,
  getInterviewSessionState,
  interviewSessionHasCompletionHold,
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
  | { state: "completed"; alreadyCompleted: boolean; automaticEvaluationDeferred: boolean }
  | { state: "pending"; completedAnswerCount: number; missingAnswerIndexes: number[] }
  | { state: "busy" };

export async function finalizeRecordedInterview(
  sessionId: string,
  questionCount: number,
): Promise<RecordedInterviewCompletionResult> {
  const session = await getInterviewSessionState(sessionId);
  if (!session) throw new Error("INTERVIEW_NOT_FOUND");
  if (interviewSessionHasCompletionHold(session)) throw new Error("RECORDED_INTERVIEW_HELD");
  if (session.recording_status !== "stored") {
    throw new Error("INTERVIEW_RECORDING_NOT_READY_FOR_COMPLETION");
  }
  if (!["in_progress", "evaluation_pending", "evaluation_processing", "completed"].includes(session.status)) {
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
  if (session.status === "completed") {
    let storedTranscript: TranscriptTurn[] = [];
    try {
      const parsed = JSON.parse(session.transcript_json ?? "[]") as unknown;
      if (Array.isArray(parsed)) storedTranscript = parsed as TranscriptTurn[];
    } catch {
      storedTranscript = [];
    }
    const answers = completedAnswers as Array<{ answerIndex: number; text: string }>;
    const exactRecordedTranscript = storedTranscript.length === questionCount * 2 &&
      answers.every((answer, offset) => {
        const index = offset + 1;
        const questionTurn = storedTranscript[offset * 2];
        const answerTurn = storedTranscript[offset * 2 + 1];
        return answer.answerIndex === index &&
          questionTurn?.id === `recorded-transcribed-question-${index}` &&
          questionTurn.speaker === "interviewer" &&
          questionTurn.text === RECORDED_FALLBACK_QUESTIONS[offset] &&
          answerTurn?.id === `recorded-transcribed-answer-${index}` &&
          answerTurn.speaker === "candidate" &&
          answerTurn.text === answer.text;
      });
    if (!exactRecordedTranscript) throw new Error("RECORDED_COMPLETION_PROVENANCE_MISMATCH");
    let automaticEvaluationDeferred = true;
    try {
      const storedEvaluation = JSON.parse(session.evaluation_json ?? "null") as {
        evidenceValidationWarnings?: unknown;
      } | null;
      automaticEvaluationDeferred = !Array.isArray(storedEvaluation?.evidenceValidationWarnings) ||
        !storedEvaluation.evidenceValidationWarnings.includes(RECORDED_TRANSCRIPT_EVALUATION_WARNING);
    } catch {
      automaticEvaluationDeferred = true;
    }
    return { state: "completed", alreadyCompleted: true, automaticEvaluationDeferred };
  }
  const transcript = recordedTranscript(completedAnswers as Array<{ answerIndex: number; text: string }>);
  const claimId = await claimInterviewEvaluation({
    sessionId,
    transcript,
    source: "durable_recorded_fallback",
  }) ?? "";
  if (!claimId) return { state: "busy" };
  try {
    // The claim is the one-paid-call fence shared by candidate, staff and cron
    // completion paths. Only exact server-side transcriptions reach the model;
    // placeholder or partially transcribed interviews returned pending above.
    const automatic = await evaluateInterviewTranscript({
      sessionId,
      employment: session.employment,
      preferredLocation: session.preferred_location,
      transcript,
      source: "recorded_transcribed",
    });
    const saved = await saveInterviewEvaluation({
      sessionId,
      transcript,
      evaluation: automatic.evaluation ?? buildDeferredHumanEvaluation("recorded_fallback"),
      claimId,
      source: "durable_recorded_fallback",
    });
    if (!saved) return { state: "busy" };
    return {
      state: "completed",
      alreadyCompleted: false,
      automaticEvaluationDeferred: automatic.automaticEvaluationDeferred,
    };
  } catch (error) {
    await failInterviewEvaluation(sessionId, claimId);
    throw error;
  }
}
