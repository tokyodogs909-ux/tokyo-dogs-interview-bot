export const TECHNICAL_EVIDENCE_TRANSCRIPT_KIND = "partial_transcript_human_review";

export const TECHNICAL_EVIDENCE_TRANSCRIPTION_FAILURE_CODES = new Set([
  "TRANSCRIPTION_EMPTY",
  "TRANSCRIPTION_FAILED",
  "TRANSCRIPTION_ID_MISSING",
]);

const HARMFUL_HOLD_EVENTS = new Set([
  "candidate_requested_stop",
  "safety_escalation",
  "completion_reason_invalid",
]);

const RECORDING_MISSING_RECOVERY_EVENTS = new Set([
  "voice_transcript_sealed",
  "orphaned_sealed_voice_draft_recovered",
  "recording_recovery_part_missing",
]);

function substantiveCandidateTurns(turns) {
  return Array.isArray(turns) && turns.length >= 1 && turns.some((turn) =>
    turn?.speaker === "candidate" &&
    typeof turn?.text === "string" && turn.text.trim().length > 0 &&
    typeof turn?.id === "string" && !turn.id.startsWith("recorded-fallback-answer-"));
}

/**
 * Distinguishes the two evidence-only paths so Drive copy never claims that a
 * complete transcript is partial, or that an unavailable recording exists.
 *
 * @param {Record<string, any>} source
 * @returns {"transcription_gap" | "recording_missing" | null}
 */
export function technicalEvidenceArchiveReason(source) {
  const draft = source?.transcriptDraft;
  const events = Array.isArray(source?.auditEvents) ? source.auditEvents : [];
  const failures = events.filter((event) => event?.type === "transcription_failed");
  const harmfulHold = events.some((event) => HARMFUL_HOLD_EVENTS.has(event?.type));
  if (
    source?.status === "in_progress" &&
    source?.recordingStatus === "stored" &&
    Boolean(source?.recording) &&
    Array.isArray(source?.transcript) && source.transcript.length === 0 &&
    source?.evaluation === null && source?.completedAt === null &&
    draft?.mode === "voice" && draft?.sealedAt === null &&
    draft?.turnCount === draft?.transcript?.length &&
    substantiveCandidateTurns(draft?.transcript) &&
    failures.length > 0 &&
    failures.every((event) =>
      TECHNICAL_EVIDENCE_TRANSCRIPTION_FAILURE_CODES.has(event?.detail?.code)) &&
    !harmfulHold
  ) return "transcription_gap";

  const eventTypes = new Set(events.map((event) => event?.type));
  const canonicalTranscript = Array.isArray(source?.transcript) ? source.transcript : [];
  if (
    source?.status === "in_progress" &&
    ["uploading", "failed"].includes(source?.recordingStatus) &&
    !source?.recording &&
    source?.evaluation === null && source?.completedAt === null &&
    draft?.mode === "voice" && typeof draft?.sealedAt === "string" &&
    draft?.turnCount === draft?.transcript?.length &&
    substantiveCandidateTurns(canonicalTranscript) &&
    JSON.stringify(canonicalTranscript) === JSON.stringify(draft?.transcript) &&
    failures.length === 0 && !harmfulHold &&
    [...RECORDING_MISSING_RECOVERY_EVENTS].every((type) => eventTypes.has(type))
  ) return "recording_missing";
  return null;
}

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
  const reason = technicalEvidenceArchiveReason(source);
  if (reason === "transcription_gap") return source.transcriptDraft.transcript;
  if (reason === "recording_missing") return source.transcript;
  return null;
}
