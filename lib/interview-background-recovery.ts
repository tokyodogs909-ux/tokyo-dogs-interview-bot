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

type InterviewBackgroundRecoveryBindings = {
  INTERVIEW_RECOVERY_TOKEN?: string;
};

export type InterviewBackgroundRecoveryAuthorization =
  | "authorized"
  | "unauthorized"
  | "unconfigured";

const MINIMUM_RECOVERY_TOKEN_LENGTH = 43;

function recoveryBindings() {
  return (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: InterviewBackgroundRecoveryBindings;
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ ?? {};
}

function configuredRecoveryToken() {
  return (
    recoveryBindings().INTERVIEW_RECOVERY_TOKEN ??
    (typeof process === "undefined" ? "" : process.env.INTERVIEW_RECOVERY_TOKEN) ??
    ""
  ).trim();
}

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

/**
 * Authenticates the machine-only recovery endpoint with a dedicated 256-bit
 * bearer token. Hashing both inputs before comparison keeps the comparison
 * length fixed and prevents timing differences from revealing token prefixes.
 */
export async function authorizeInterviewBackgroundRecoveryRequest(
  request: Request,
): Promise<InterviewBackgroundRecoveryAuthorization> {
  const expected = configuredRecoveryToken();
  if (expected.length < MINIMUM_RECOVERY_TOKEN_LENGTH) return "unconfigured";

  const authorization = request.headers.get("Authorization") ?? "";
  if (authorization.length > 512 || !authorization.startsWith("Bearer ")) {
    return "unauthorized";
  }
  const actual = authorization.slice(7).trim();
  if (!actual) return "unauthorized";

  const [actualHash, expectedHash] = await Promise.all([
    sha256(actual),
    sha256(expected),
  ]);
  return constantTimeEqual(actualHash, expectedHash) ? "authorized" : "unauthorized";
}

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
    if (result.state === "stored") return "advanced";
    return result.state === "waiting" ? "waiting" : "attention";
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
