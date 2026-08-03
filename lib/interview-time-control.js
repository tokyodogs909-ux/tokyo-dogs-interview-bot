/**
 * Time limits for the candidate interview.
 *
 * The warning is intentionally earlier than the maximum so the interviewer can
 * finish the current topic naturally. Reaching the maximum requests a controlled
 * close; the caller still waits for the candidate's active utterance to finish.
 */
export const INTERVIEW_WARNING_SECONDS = 24 * 60;
export const INTERVIEW_MAX_SECONDS = 27 * 60;
export const RECORDED_FALLBACK_QUIET_MS = 3_200;

/**
 * @param {{
 *   elapsedSeconds: number;
 *   warningDelivered: boolean;
 *   maximumRequested: boolean;
 * }} input
 * @returns {"warning" | "complete" | null}
 */
export function nextInterviewTimeAction(input) {
  if (!input.maximumRequested && input.elapsedSeconds >= INTERVIEW_MAX_SECONDS) {
    return "complete";
  }
  if (
    !input.maximumRequested &&
    !input.warningDelivered &&
    input.elapsedSeconds >= INTERVIEW_WARNING_SECONDS
  ) {
    return "warning";
  }
  return null;
}

/**
 * A timed interviewer response may only start while both sides are idle. This
 * guard is shared by the 24-minute warning and the 27-minute closing message.
 *
 * @param {{
 *   candidateSpeaking: boolean;
 *   awaitingResponse: boolean;
 *   timedResponseInFlight: boolean;
 *   ending: boolean;
 * }} input
 */
export function mayDispatchTimedResponse(input) {
  return !input.candidateSpeaking &&
    !input.awaitingResponse &&
    !input.timedResponseInFlight &&
    !input.ending;
}

/**
 * The recorded fallback has no server VAD. It therefore closes only after the
 * local microphone has remained quiet for the same pause used between ordinary
 * interview turns. A noisy sample resets the quiet window.
 *
 * @param {{
 *   microphoneLevel: number;
 *   quietSince: number | null;
 *   now: number;
 *   quietWindowMs?: number;
 * }} input
 * @returns {{ quietSince: number | null; ready: boolean }}
 */
export function recordedFallbackQuietState(input) {
  if (input.microphoneLevel >= 4) return { quietSince: null, ready: false };
  const quietSince = input.quietSince ?? input.now;
  return {
    quietSince,
    ready: input.now - quietSince >= (input.quietWindowMs ?? RECORDED_FALLBACK_QUIET_MS),
  };
}
