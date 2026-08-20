import { recoverNextStaleInterviewEvaluation } from "@/lib/interview-evaluation-recovery";
import {
  findInterviewTechnicalEvidenceDriveSessions,
  findNextInterviewDriveRecoverySession,
  recoverNextInterruptedV3Recording,
  recoverNextLegacyV1RecordingOrphan,
  recoverNextSealedResumableInterviewRecording,
} from "@/lib/interview-persistence";
import { finalizeRecordedInterview } from "@/lib/recorded-interview-completion";
import {
  findRecordedInterviewReadyForCompletion,
  recoverNextRecordedAnswerTranscription,
} from "@/lib/recorded-transcription";
import { stepInterviewToGoogleDrive } from "@/lib/google-drive-sync";
import { authorizeBearerSecret, bearerToken, serverSecretReadiness } from "@/lib/server-secret-auth";

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
  if (!bearerToken(request)) return "unauthorized";
  return await authorizeBearerSecret(request, expected) ? "authorized" : "unauthorized";
}

export function backgroundRecoveryAuthenticationReadiness() {
  const readiness = serverSecretReadiness(configuredRecoveryToken());
  return { ...readiness, configured: configuredRecoveryToken().length >= MINIMUM_RECOVERY_TOKEN_LENGTH };
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
  let legacyState: RecoveryStageState;
  try {
    const legacy = await recoverNextLegacyV1RecordingOrphan();
    legacyState = legacy.state === "none"
      ? "idle"
      : legacy.state === "stored"
        ? "advanced"
        : legacy.state === "waiting"
          ? "waiting"
          : "attention";
  } catch {
    legacyState = "attention";
  }

  let interruptedState: RecoveryStageState;
  try {
    const interrupted = await recoverNextInterruptedV3Recording();
    interruptedState = interrupted.state === "none"
      ? "idle"
      : interrupted.state === "stored"
        ? "advanced"
        : interrupted.state === "waiting"
          ? "waiting"
          : "attention";
  } catch {
    interruptedState = "attention";
  }

  // A damaged legacy object must not starve the normal sealed-upload queue,
  // and a repeatedly waiting sealed upload must not starve the legacy queue.
  // Each helper remains independently bounded to at most one successful store.
  let sealedState: RecoveryStageState;
  try {
    const sealed = await recoverNextSealedResumableInterviewRecording();
    sealedState = sealed.state === "none"
      ? "idle"
      : sealed.state === "stored"
        ? "advanced"
        : sealed.state === "waiting"
          ? "waiting"
          : "attention";
  } catch {
    sealedState = "attention";
  }

  if ([legacyState, interruptedState, sealedState].includes("advanced")) return "advanced";
  if ([legacyState, interruptedState, sealedState].includes("attention")) return "attention";
  if ([legacyState, interruptedState, sealedState].includes("waiting")) return "waiting";
  return "idle";
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
    // Advance one normal archive and a bounded technical-evidence batch
    // sequentially. This preserves the live candidate path while preventing
    // two durable incident recordings from waiting behind one another for
    // hours. Each session still owns its existing D1 claim and <=4 MiB step.
    const normalSessionId = await findNextInterviewDriveRecoverySession({
      includeIntegrityRecheck: false,
    });
    const technicalLimit = normalSessionId ? 4 : 5;
    const technicalSessionIds = await findInterviewTechnicalEvidenceDriveSessions(technicalLimit);
    const sessionIds = [normalSessionId, ...technicalSessionIds]
      .filter((value): value is string => typeof value === "string");
    if (sessionIds.length === 0) {
      const maintenanceSessionId = await findNextInterviewDriveRecoverySession({
        includeIntegrityRecheck: true,
      });
      if (!maintenanceSessionId) return "idle";
      sessionIds.push(maintenanceSessionId);
    }
    let advanced = false;
    for (const sessionId of sessionIds) {
      const result = await stepInterviewToGoogleDrive(sessionId);
      if (result.status !== "completed") continue;
      if (result.integrity?.status !== "verified") return "attention";
      advanced = true;
    }
    return advanced ? "advanced" : "waiting";
  } catch {
    return "attention";
  }
}

/**
 * Advances a bounded amount of global work per scheduled event. At most one
 * paid answer transcription and at most five Drive chunks (each <=4 MiB) are
 * attempted. A live archive occupies one slot; technical evidence uses the
 * remaining four, or all five when there is no live archive. Every
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
