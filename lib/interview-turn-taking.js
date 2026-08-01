/**
 * Turn-taking decisions for the realtime voice interview.
 *
 * This lives outside app/page.tsx so the rules that decide "may the interviewer
 * ask the next question yet?" can be regression-tested directly with recorded
 * realtime event orders, instead of only being asserted as source strings.
 *
 * The realtime session is configured with turn_detection.create_response=false
 * and interrupt_response=false (lib/interview.ts), so every response is started
 * by this client. That makes the client solely responsible for never speaking
 * over the candidate and for never leaving the candidate waiting after they
 * finish an answer.
 */

/**
 * @typedef {(
 *   | "candidate_speech_started"
 *   | "candidate_speech_stopped"
 *   | "response_created"
 *   | "assistant_output"
 *   | "response_done"
 *   | "response_cancel_rejected"
 *   | "response_failed"
 *   | "reset"
 * )} TurnTakingEvent
 */

/**
 * @typedef {object} TurnTakingState
 * @property {boolean} candidateSpeaking
 *   The candidate is mid-utterance. No question may be started.
 * @property {boolean} awaitingResponse
 *   A response was requested or created and has not finished yet.
 * @property {boolean} candidateTurnPending
 *   The candidate finished speaking while a response was still in flight, so
 *   their end-of-turn could not schedule the next question yet. Without this
 *   the interview stalls: nothing else would ever start the next question.
 */

/**
 * @typedef {(
 *   | "cancelActiveResponse"
 *   | "clearNextQuestionDelay"
 *   | "clearResponseWatchdog"
 *   | "armResponseWatchdog"
 *   | "scheduleNextQuestion"
 * )} TurnTakingAction
 */

/** @returns {TurnTakingState} */
export function initialTurnTakingState() {
  return { candidateSpeaking: false, awaitingResponse: false, candidateTurnPending: false };
}

/**
 * @param {TurnTakingState} state
 * @param {TurnTakingEvent} event
 * @returns {{ state: TurnTakingState, actions: TurnTakingAction[] }}
 */
export function reduceTurnTaking(state, event) {
  if (event === "candidate_speech_started") {
    /** @type {TurnTakingAction[]} */
    const actions = ["clearNextQuestionDelay"];
    if (state.awaitingResponse) actions.push("cancelActiveResponse", "clearResponseWatchdog");
    return {
      state: { candidateSpeaking: true, awaitingResponse: false, candidateTurnPending: false },
      actions,
    };
  }

  if (event === "candidate_speech_stopped") {
    // The speaking latch is always released here. Leaving it set (as happens if
    // this branch returns early) permanently blocks scheduleNextQuestion, so the
    // candidate is left on "お話を聞いています" with no further question.
    if (state.awaitingResponse) {
      return {
        state: { ...state, candidateSpeaking: false, candidateTurnPending: true },
        actions: [],
      };
    }
    return {
      state: { ...state, candidateSpeaking: false, candidateTurnPending: false },
      actions: ["scheduleNextQuestion"],
    };
  }

  if (event === "response_created") {
    /** @type {TurnTakingAction[]} */
    const actions = [];
    // A response.create can be accepted by the server just as the candidate
    // starts talking, so response.created can arrive after our barge-in cancel.
    // Cancel again rather than let the interviewer talk over the candidate.
    if (state.candidateSpeaking) actions.push("cancelActiveResponse");
    actions.push("clearNextQuestionDelay", "armResponseWatchdog");
    return { state: { ...state, awaitingResponse: true }, actions };
  }

  if (event === "assistant_output") {
    // Late transcript deltas of an already cancelled response must not re-arm
    // the watchdog while the candidate is still answering.
    if (state.candidateSpeaking) return { state, actions: [] };
    return { state: { ...state, awaitingResponse: true }, actions: ["armResponseWatchdog"] };
  }

  if (event === "response_done" || event === "response_cancel_rejected") {
    /** @type {TurnTakingAction[]} */
    const actions = ["clearResponseWatchdog"];
    if (state.candidateTurnPending && !state.candidateSpeaking) actions.push("scheduleNextQuestion");
    return {
      state: { ...state, awaitingResponse: false, candidateTurnPending: false },
      actions,
    };
  }

  if (event === "response_failed") {
    return {
      state: { ...state, awaitingResponse: false, candidateTurnPending: false },
      actions: ["clearNextQuestionDelay", "clearResponseWatchdog"],
    };
  }

  return {
    state: initialTurnTakingState(),
    actions: ["clearNextQuestionDelay", "clearResponseWatchdog"],
  };
}

/**
 * Convenience wrapper for tests and callers that replay a whole event order.
 *
 * @param {TurnTakingEvent[]} events
 * @param {TurnTakingState} [start]
 * @returns {{ state: TurnTakingState, actions: TurnTakingAction[] }}
 */
export function replayTurnTaking(events, start = initialTurnTakingState()) {
  let state = start;
  /** @type {TurnTakingAction[]} */
  const actions = [];
  for (const event of events) {
    const next = reduceTurnTaking(state, event);
    state = next.state;
    actions.push(...next.actions);
  }
  return { state, actions };
}

/**
 * Recording container selection, extracted so each supported device class can be
 * regression-tested without a browser. iOS Safari only exposes MP4 recording,
 * Android/desktop Chrome only WebM, so a list that silently matches nothing
 * would leave that device with no interview recording at all. The full ordered
 * list is returned because a MediaRecorder constructor can still reject a type
 * that isTypeSupported() accepted, and the next candidate must be tried.
 *
 * @param {boolean} hasVideo
 * @param {(mimeType: string) => boolean} isTypeSupported
 * @returns {string[]}
 */
export function supportedRecordingMimeTypes(hasVideo, isTypeSupported) {
  const candidates = hasVideo
    ? ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4;codecs=h264,aac", "video/mp4"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.filter((mimeType) => isTypeSupported(mimeType));
}

/**
 * @param {boolean} hasVideo
 * @param {(mimeType: string) => boolean} isTypeSupported
 * @returns {string | null}
 */
export function selectRecordingMimeType(hasVideo, isTypeSupported) {
  return supportedRecordingMimeTypes(hasVideo, isTypeSupported)[0] ?? null;
}

/**
 * The candidate reconnects to the same interview id after a dropped line. The
 * transcript and recording chunks captured before the drop must survive, because
 * both are only sent to the server when the interview completes.
 *
 * @param {string | null} recordedSessionId
 * @param {string} activeSessionId
 * @returns {boolean}
 */
export function isNewInterviewRecord(recordedSessionId, activeSessionId) {
  return recordedSessionId !== activeSessionId;
}
