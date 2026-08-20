function addUnique(values, value) {
  return value && !values.includes(value) ? [...values, value] : values;
}

function removeValue(values, value) {
  return value ? values.filter((candidate) => candidate !== value) : values;
}

function responseId(event) {
  return String(event?.response?.id ?? event?.response_id ?? "").trim();
}

/**
 * @typedef {Object} RealtimeTranscriptIntegrityState
 * @property {string[]} pendingCandidateItemIds
 * @property {string[]} pendingResponseIds
 * @property {number} unidentifiedCandidateItems
 * @property {number} unidentifiedResponses
 * @property {boolean} transcriptionFailed
 * @property {boolean} transcriptionRepairRequired
 */

/**
 * Tracks only server-confirmed Realtime lifecycles that must be closed before a
 * voice transcript can be sealed. UI text is deliberately not authoritative:
 * speech remains pending until the matching transcription event arrives, and a
 * model response remains pending until response.done identifies the same ID.
 */
/** @returns {RealtimeTranscriptIntegrityState} */
export function initialRealtimeTranscriptIntegrity() {
  return {
    pendingCandidateItemIds: [],
    pendingResponseIds: [],
    unidentifiedCandidateItems: 0,
    unidentifiedResponses: 0,
    transcriptionFailed: false,
    transcriptionRepairRequired: false,
  };
}

/**
 * @param {RealtimeTranscriptIntegrityState} current
 * @param {Record<string, any>} event
 * @returns {RealtimeTranscriptIntegrityState}
 */
export function reduceRealtimeTranscriptIntegrity(current, event) {
  const state = {
    pendingCandidateItemIds: [...current.pendingCandidateItemIds],
    pendingResponseIds: [...current.pendingResponseIds],
    unidentifiedCandidateItems: current.unidentifiedCandidateItems,
    unidentifiedResponses: current.unidentifiedResponses,
    transcriptionFailed: current.transcriptionFailed,
    transcriptionRepairRequired: current.transcriptionRepairRequired,
  };
  const type = event?.type ?? "";

  if (
    type === "input_audio_buffer.speech_started" ||
    type === "input_audio_buffer.speech_stopped" ||
    type === "input_audio_buffer.committed"
  ) {
    const itemId = String(event?.item_id ?? "").trim();
    if (itemId) state.pendingCandidateItemIds = addUnique(state.pendingCandidateItemIds, itemId);
    else if (type !== "input_audio_buffer.speech_stopped" || state.unidentifiedCandidateItems === 0) {
      // started/stopped normally repeat one item_id. Missing IDs are counted on
      // started (or on an isolated stopped/committed event), never silently
      // treated as a completed candidate turn.
      state.unidentifiedCandidateItems += 1;
    }
    return state;
  }

  if (type === "conversation.item.input_audio_transcription.completed") {
    const itemId = String(event?.item_id ?? "").trim();
    const transcript = String(event?.transcript ?? "").trim();
    if (itemId) state.pendingCandidateItemIds = removeValue(state.pendingCandidateItemIds, itemId);
    if (!itemId) {
      // An unidentified item can never be paired with the durable transcript.
      state.transcriptionFailed = true;
    } else if (!transcript) {
      // Realtime input transcription is a separate asynchronous ASR process.
      // It can return an empty transcript even though the realtime model heard
      // the audio. Keep finalization blocked, but allow one subsequent,
      // explicitly requested repeat (or typed replacement) to repair the gap.
      state.transcriptionRepairRequired = true;
    } else if (state.transcriptionRepairRequired) {
      state.transcriptionRepairRequired = false;
    }
    return state;
  }

  if (type === "conversation.item.input_audio_transcription.failed") {
    const itemId = String(event?.item_id ?? "").trim();
    if (itemId) state.pendingCandidateItemIds = removeValue(state.pendingCandidateItemIds, itemId);
    if (itemId) state.transcriptionRepairRequired = true;
    else state.transcriptionFailed = true;
    return state;
  }

  if (type === "candidate.transcription_repair.completed") {
    state.transcriptionRepairRequired = false;
    return state;
  }

  if (type === "response.created") {
    const id = responseId(event);
    if (id) state.pendingResponseIds = addUnique(state.pendingResponseIds, id);
    else state.unidentifiedResponses += 1;
    return state;
  }

  if (type === "response.done") {
    const id = responseId(event);
    if (id) state.pendingResponseIds = removeValue(state.pendingResponseIds, id);
    else if (state.unidentifiedResponses > 0) state.unidentifiedResponses -= 1;
    return state;
  }

  return state;
}

/** @param {RealtimeTranscriptIntegrityState} state */
export function realtimeTranscriptIntegrityBlocker(state) {
  if (state.transcriptionFailed) return "transcription_failed";
  if (state.transcriptionRepairRequired) return "transcription_repair_required";
  if (state.pendingCandidateItemIds.length > 0 || state.unidentifiedCandidateItems > 0) {
    return "candidate_transcription_pending";
  }
  if (state.pendingResponseIds.length > 0 || state.unidentifiedResponses > 0) {
    return "response_pending";
  }
  return null;
}

/** @param {RealtimeTranscriptIntegrityState} state */
export function realtimeTranscriptIntegrityReady(state) {
  return realtimeTranscriptIntegrityBlocker(state) === null;
}
