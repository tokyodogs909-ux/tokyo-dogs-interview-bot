export const TECHNICAL_EVIDENCE_TRANSCRIPT_KIND = "partial_transcript_human_review";

export const TECHNICAL_EVIDENCE_TRANSCRIPTION_FAILURE_CODES = new Set([
  "TRANSCRIPTION_EMPTY",
  "TRANSCRIPTION_FAILED",
  "TRANSCRIPTION_ID_MISSING",
]);

/**
 * Returns the already-hash-verified append-only draft only when a known
 * realtime transcription fault stopped an otherwise substantive interview
 * after its full recording was stored. This is evidence preservation only:
 * the partial transcript is never promoted to a completed interview or used
 * for automatic evaluation.
 * `null` means the ordinary completed-interview archive rules must apply.
 *
 * @param {Record<string, any>} source
 * @returns {Array<Record<string, any>> | null}
 */
export function technicalEvidenceArchiveTranscript(source) {
  const draft = source?.transcriptDraft;
  const failures = Array.isArray(source?.auditEvents)
    ? source.auditEvents.filter((event) => event?.type === "transcription_failed")
    : [];
  const harmfulHold = Array.isArray(source?.auditEvents) && source.auditEvents.some((event) => [
    "candidate_requested_stop",
    "safety_escalation",
    "completion_reason_invalid",
  ].includes(event?.type));
  const turns = Array.isArray(draft?.transcript) ? draft.transcript : [];
  const eligible = source?.status === "in_progress" &&
    source?.recordingStatus === "stored" &&
    Boolean(source?.recording) &&
    Array.isArray(source?.transcript) && source.transcript.length === 0 &&
    source?.evaluation === null &&
    source?.completedAt === null &&
    draft?.mode === "voice" &&
    draft?.sealedAt === null &&
    draft?.turnCount === turns.length &&
    turns.length >= 2 &&
    turns.some((turn) =>
      turn?.speaker === "candidate" &&
      typeof turn?.text === "string" && turn.text.trim().length > 0 &&
      typeof turn?.id === "string" && !turn.id.startsWith("recorded-fallback-answer-")) &&
    failures.length > 0 &&
    failures.every((event) =>
      TECHNICAL_EVIDENCE_TRANSCRIPTION_FAILURE_CODES.has(event?.detail?.code)) &&
    !harmfulHold;
  return eligible ? turns : null;
}
