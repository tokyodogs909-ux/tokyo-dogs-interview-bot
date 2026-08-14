import assert from "node:assert/strict";
import test from "node:test";

import {
  initialRealtimeTranscriptIntegrity,
  realtimeTranscriptIntegrityBlocker,
  realtimeTranscriptIntegrityReady,
  reduceRealtimeTranscriptIntegrity,
} from "../lib/realtime-transcript-integrity.js";

function sequence(events) {
  return events.reduce(reduceRealtimeTranscriptIntegrity, initialRealtimeTranscriptIntegrity());
}

test("voice finalization stays blocked until response.done and the exact final transcription complete", () => {
  let state = sequence([
    { type: "response.created", response: { id: "resp-question" } },
    { type: "response.done", response: { id: "resp-question", status: "completed" } },
    { type: "input_audio_buffer.speech_started", item_id: "candidate-final" },
    { type: "input_audio_buffer.speech_stopped", item_id: "candidate-final" },
    { type: "response.created", response: { id: "resp-closing" } },
  ]);
  assert.equal(realtimeTranscriptIntegrityReady(state), false);
  assert.equal(realtimeTranscriptIntegrityBlocker(state), "candidate_transcription_pending");

  state = reduceRealtimeTranscriptIntegrity(state, {
    type: "response.done",
    response: { id: "resp-closing", status: "completed" },
  });
  assert.equal(realtimeTranscriptIntegrityReady(state), false,
    "response.done must not imply that the separate input transcription finished");

  state = reduceRealtimeTranscriptIntegrity(state, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "candidate-final",
    transcript: "最終回答です。",
  });
  assert.equal(realtimeTranscriptIntegrityReady(state), true);
});

test("a completed transcription cannot close a different or unidentified speech item", () => {
  let state = sequence([
    { type: "input_audio_buffer.speech_started", item_id: "candidate-a" },
    { type: "input_audio_buffer.speech_stopped", item_id: "candidate-a" },
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "candidate-b",
      transcript: "別の回答です。",
    },
  ]);
  assert.equal(realtimeTranscriptIntegrityBlocker(state), "candidate_transcription_pending");
  assert.deepEqual(state.pendingCandidateItemIds, ["candidate-a"]);

  state = sequence([
    { type: "input_audio_buffer.speech_started" },
    { type: "input_audio_buffer.speech_stopped" },
    { type: "conversation.item.input_audio_transcription.completed" },
  ]);
  assert.equal(state.transcriptionFailed, true);
  assert.equal(realtimeTranscriptIntegrityReady(state), false);
});

test("transcription failure is sticky even after every known lifecycle closes", () => {
  const state = sequence([
    { type: "input_audio_buffer.committed", item_id: "candidate-gap" },
    { type: "conversation.item.input_audio_transcription.failed", item_id: "candidate-gap" },
    { type: "response.created", response: { id: "resp-after-gap" } },
    { type: "response.done", response: { id: "resp-after-gap", status: "completed" } },
  ]);
  assert.deepEqual(state.pendingCandidateItemIds, []);
  assert.deepEqual(state.pendingResponseIds, []);
  assert.equal(realtimeTranscriptIntegrityBlocker(state), "transcription_failed");
});

test("an empty completed transcription is a sticky lost turn, not a lifecycle close", () => {
  for (const transcript of ["", "   ", undefined]) {
    const state = sequence([
      { type: "input_audio_buffer.speech_started", item_id: "candidate-empty" },
      { type: "input_audio_buffer.speech_stopped", item_id: "candidate-empty" },
      {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "candidate-empty",
        transcript,
      },
      { type: "response.created", response: { id: "resp-after-empty" } },
      { type: "response.done", response: { id: "resp-after-empty" } },
    ]);
    assert.deepEqual(state.pendingCandidateItemIds, []);
    assert.equal(state.transcriptionFailed, true);
    assert.equal(realtimeTranscriptIntegrityBlocker(state), "transcription_failed");
    assert.equal(realtimeTranscriptIntegrityReady(state), false);
  }
});

test("duplicate identified lifecycle events are idempotent", () => {
  const state = sequence([
    { type: "input_audio_buffer.speech_started", item_id: "candidate-1" },
    { type: "input_audio_buffer.speech_started", item_id: "candidate-1" },
    { type: "input_audio_buffer.speech_stopped", item_id: "candidate-1" },
    { type: "conversation.item.input_audio_transcription.completed", item_id: "candidate-1", transcript: "回答です。" },
    { type: "conversation.item.input_audio_transcription.completed", item_id: "candidate-1", transcript: "回答です。" },
    { type: "response.created", response: { id: "resp-1" } },
    { type: "response.created", response: { id: "resp-1" } },
    { type: "response.done", response: { id: "resp-1" } },
  ]);
  assert.equal(realtimeTranscriptIntegrityReady(state), true);
});
