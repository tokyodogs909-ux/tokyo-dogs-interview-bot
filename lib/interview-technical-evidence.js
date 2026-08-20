export const TECHNICAL_EVIDENCE_TRANSCRIPT_KIND = "partial_transcript_human_review";

/**
 * Returns the already-hash-verified append-only draft only for the narrow
 * historic incident where one empty asynchronous voice transcription stopped
 * an otherwise substantive interview after its full recording was stored.
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
    failures.every((event) => event?.detail?.code === "TRANSCRIPTION_EMPTY") &&
    !harmfulHold;
  return eligible ? turns : null;
}
