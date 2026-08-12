import { recoverNextStaleInterviewEvaluation } from "@/lib/interview-evaluation-recovery";
import {
  findNextInterviewDriveRecoverySession,
  recoverNextSealedResumableInterviewRecording,
} from "@/lib/interview-persistence";
import { finalizeRecordedInterview } from "@/lib/recorded-interview-completion";
import {
  findRecordedInterviewReadyForCompletion,
  recoverNextRecordedAnswerTranscription,
} from "@/lib/recorded-transcription";
import { stepInterviewToGoogleDrive } from "@/lib/google-drive-sync";

type RecoveryStageState = "idle" | "advanced" | "waiting" | "attention";

export type InterviewBackgroundRecoverySummary = {
  recording: RecoveryStageState;
  transcription: RecoveryStageState;
  completion: RecoveryStageState;
  evaluation: RecoveryStageState;
  drive: RecoveryStageState;
};

async function recoverRecording(): Promise<RecoveryStageState> {
  try {
    const result = await recoverNextSealedResumableInterviewRecording();
    if (result.state === "none") return "idle";
    return result.state === "stored" ? "advanced" : "attention";
  } catch {
    return "attention";
  }
}

async function recoverTranscription(): Promise<RecoveryStageState> {
  try {
    const result = await recoverNextRecordedAnswerTranscription();
    if (result.state === "none") return "idle";
    if (result.result === "completed") return "advanced";
    return result.result === "pending" ? "waiting" : "attention";
  } catch {
    return "attention";
  }
}

async function recoverCompletion(): Promise<RecoveryStageState> {
  try {
    const ready = await findRecordedInterviewReadyForCompletion();
    if (!ready) return "idle";
    const result = await finalizeRecordedInterview(ready.sessionId, ready.questionCount);
    return result.state === "completed" ? "advanced" : "waiting";
  } catch {
    return "attention";
  }
}

async function recoverEvaluation(): Promise<RecoveryStageState> {
  try {
    const result = await recoverNextStaleInterviewEvaluation();
    if (result.state === "none") return "idle";
    return result.state === "completed" ? "advanced" : "waiting";
  } catch {
    return "attention";
  }
}

async function recoverDriveArchive(): Promise<RecoveryStageState> {
  try {
    const sessionId = await findNextInterviewDriveRecoverySession();
    if (!sessionId) return "idle";
    const result = await stepInterviewToGoogleDrive(sessionId);
    return result.status === "completed" ? "advanced" : "waiting";
  } catch {
    return "attention";
  }
}

/**
 * Advances a bounded amount of global work per scheduled event. At most one
 * paid answer transcription and one <=4 MiB Drive chunk are attempted. Every
 * mutable stage retains its existing D1 compare-and-set/lease fence, so an
 * overlapping cron, candidate retry, or staff tab cannot duplicate paid work
 * or write the same Drive offset concurrently.
 */
export async function runInterviewBackgroundRecoveryOnce(): Promise<InterviewBackgroundRecoverySummary> {
  const recording = await recoverRecording();
  const [transcription, completion, evaluation, drive] = await Promise.all([
    recoverTranscription(),
    recoverCompletion(),
    recoverEvaluation(),
    recoverDriveArchive(),
  ]);
  return { recording, transcription, completion, evaluation, drive };
}
