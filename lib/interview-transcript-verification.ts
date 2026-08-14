import type { TranscriptTurn } from "@/lib/interview";

type TranscriptAuditEvent = {
  type: string;
  detail?: Record<string, unknown>;
};

/**
 * A receipt may call a transcript complete only when it contains a real
 * candidate utterance, contains no legacy recorded-mode placeholder, and the
 * realtime stream did not report a missing candidate turn. Recorded-answer
 * transcription retries use system events with answerIndex/errorCode and are
 * allowed once every sealed answer has later completed.
 */
export function hasVerifiedCandidateTranscript(
  transcript: TranscriptTurn[],
  auditEvents: TranscriptAuditEvent[] = [],
) {
  const candidateTurns = transcript.filter((turn) => turn.speaker === "candidate");
  const whollyRecoveredRecordedInterview = candidateTurns.length > 0 && candidateTurns.every((turn) =>
    turn.id.startsWith("recorded-transcribed-answer-"));
  const realtimeTurnMissing = auditEvents.some((event) =>
    event.type === "transcription_failed" && [
      "TRANSCRIPTION_FAILED",
      "TRANSCRIPTION_EMPTY",
      "TRANSCRIPTION_ID_MISSING",
    ].includes(String(event.detail?.code ?? ""))) &&
    !whollyRecoveredRecordedInterview;
  return candidateTurns.some((turn) => turn.text.trim().length > 0) &&
    !candidateTurns.some((turn) => turn.id.startsWith("recorded-fallback-answer-")) &&
    !realtimeTurnMissing;
}
