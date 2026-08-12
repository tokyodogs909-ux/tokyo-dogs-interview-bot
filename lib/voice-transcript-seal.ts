import type { TranscriptTurn } from "@/lib/interview";

export const MAX_VOICE_TRANSCRIPT_BODY_CHARS = 180_000;

/**
 * Produces the one canonical representation used by both the durable voice
 * transcript seal and evaluation. Keeping this strict prevents a retry from
 * silently changing what the candidate actually said after recording upload.
 */
export function cleanVoiceTranscript(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 300).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const turn = item as Partial<TranscriptTurn>;
    if (
      typeof turn.id !== "string" ||
      (turn.speaker !== "candidate" && turn.speaker !== "interviewer") ||
      typeof turn.text !== "string"
    ) {
      return [];
    }
    const text = turn.text.replace(/\0/g, "").trim().slice(0, 5000);
    if (!text) return [];
    return [{
      id: turn.id.slice(0, 120),
      speaker: turn.speaker,
      text,
      createdAt: typeof turn.createdAt === "string" ? turn.createdAt.slice(0, 40) : "",
    }];
  });
}

export function hasCandidateVoiceTurn(transcript: TranscriptTurn[]) {
  return transcript.some(
    (turn) => turn.speaker === "candidate" && turn.text.trim().length > 0,
  );
}
