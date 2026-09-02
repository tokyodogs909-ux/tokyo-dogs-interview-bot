import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const persistenceSource = await readFile(new URL("../lib/interview-persistence.ts", import.meta.url), "utf8");
const interviewSource = await readFile(new URL("../lib/interview.ts", import.meta.url), "utf8");

function functionBody(name, nextName) {
  const start = source.indexOf(`  ${name}`);
  const end = source.indexOf(`  ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source boundary missing`);
  return source.slice(start, end);
}

test("camera setup is hard-gated by measured microphone energy and explicit speaker confirmation", () => {
  const prepare = functionBody("async function prepareInterview()", "async function startTextInterview()");
  assert.match(prepare, /startMicrophoneMeter\(nextStream\)/);
  assert.doesNotMatch(prepare, /connectPreparedInterview\(/);

  const playback = functionBody("async function playPreparedAudio(", "function playSpeakerTest()");
  assert.match(playback, /audio\.onended[\s\S]*playback_completed/);
  assert.doesNotMatch(playback, /audio\.play\(\)[\s\S]{0,120}candidate_confirmed/);
  const confirm = functionBody("function confirmSpeakerHeard()", "async function copyPortalLink()");
  assert.match(confirm, /speakerTestState !== "played"/);
  assert.match(confirm, /candidate_confirmed/);
  assert.match(source, /microphoneVerified: microphoneCheckPassed/);
  assert.match(source, /speakerVerified: speakerTestState === "passed"/);
});

test("real local media changes stop recording while backgrounding flushes and resumes the same upload", () => {
  const interruption = functionBody("function markLocalMediaInterrupted(", "function bindLocalMicrophoneTrack(");
  assert.match(interruption, /stageRef\.current !== "interview"/);
  assert.match(interruption, /recordingLocalContinuityValidRef\.current = false/);
  assert.match(interruption, /stopRealtime\(\)/);
  assert.match(interruption, /setStage\("setup"\)/);
  assert.doesNotMatch(interruption, /keepRecorder: true/);
  assert.doesNotMatch(source, /markLocalMediaInterruptedActionRef\.current\("page_hidden"\)/);
  assert.match(source, /flushRecordingBeforeSuspension/);
  assert.match(source, /recorder\.requestData\(\)/);
  assert.match(source, /uploader\.retry\(\)/);
  assert.match(source, /switchInterruptedInterviewToTextContinuity/);
  assert.doesNotMatch(source, /explicit_recovery_verified/);
  assert.doesNotMatch(source, /resumeAfterLocalMediaRecovery|reacquireLocalMedia/);
});

test("interrupted media is replaced by one server-backed text session, never a second recorder", () => {
  const recovery = functionBody("async function switchInterruptedInterviewToTextContinuity()", "function stopAudioPrime()");
  assert.match(recovery, /fetch\("\/api\/interviews\/resume"/);
  assert.match(recovery, /data\.snapshot\.action !== "resume_text"/);
  assert.match(recovery, /recordingGenerationRef\.current \+= 1/);
  assert.match(recovery, /recordingFinalizePromiseRef\.current = null/);
  assert.match(recovery, /await openTextContinuity/);
  assert.doesNotMatch(recovery, /getUserMedia|startRecording|connectPreparedInterview/);

  const recordingStart = functionBody("async function startRecording(", "async function connectPreparedInterview()");
  assert.match(recordingStart, /!recordingLocalContinuityValidRef\.current/);
  assert.match(recordingStart, /recordingResolveRef\.current\?\.\(null\)/);
});

test("fallback disclosure and audio coverage do not claim interviewer audio", () => {
  assert.match(source, /録画にはあなたの音声を保存し、この端末で読む質問音声は含めず、質問文を別に記録します/);
  assert.match(source, /startRecording\(activeStream, displayStreamRef\.current, null, \{ resume: false \}\)/);
  assert.match(source, /録画はカメラ映像・応募者音声／質問は文面で別記録/);
  const fallback = functionBody("async function startRecordedFallback(", "async function advanceRecordedFallback()");
  assert.ok(
    fallback.indexOf("recordingLiveUploaderRef.current") <
      fallback.indexOf("/api/interviews/recorded/start"),
    "fallback must reject a second recorder/upload id before mutating server mode",
  );
});

test("durable recording and transcript receipts precede final completion", () => {
  assert.match(source, /recorder\.ondataavailable = \(event\) => \{[\s\S]*liveUploader\.append\(event\.data\)/);
  const voiceSeal = functionBody("async function sealVoiceTranscriptCompletion()", "async function syncInterviewArchive(");
  assert.ok(
    voiceSeal.indexOf("await sealDurableTranscriptDraft(\"voice\")") <
      voiceSeal.indexOf("/api/interviews/voice/transcript/seal"),
  );
  const finalization = functionBody("async function storeInterviewFinalization(activeMode", "function setArchiveCompletionMessage(activeMode");
  assert.match(finalization, /if \(activeMode === "voice"\) await sealVoiceTranscriptCompletion\(\)/);
  assert.ok(
    finalization.indexOf("await sealDurableTranscriptDraft(\"text\")") <
      finalization.indexOf("await requestEvaluation()"),
  );
  assert.match(source, /completedTranscriptRef/);
  assert.match(source, /recordCompletedTurn/);
  const completion = functionBody(
    "async function completeInterview(reason: string)",
    "function handleRealtimeEvent(event: RealtimeEvent)",
  );
  assert.ok(
    completion.indexOf("const recordingFinalization") <
      completion.indexOf('await sealDurableTranscriptDraft("voice")'),
    "recording finalization must start before a network-bound transcript seal",
  );
  assert.ok(
    completion.indexOf("const recordingResult = await Promise.race") <
      completion.indexOf("await ensureFinalArchiveStored(activeMode)"),
    "the recording receipt must precede the canonical voice seal and evaluation",
  );
  assert.doesNotMatch(completion, /uploadRecording\(recordingBlob\)/);
  const recordingFinalize = functionBody("function ensureRecordingFinalized()", "async function storeInterviewFinalization(activeMode");
  assert.match(recordingFinalize, /recordingFinalizePromiseRef\.current/);
  assert.match(recordingFinalize, /await uploadRecording\(blob\)/);
  const retry = functionBody("async function retryRecordingUpload()", "async function retryInterviewFinalization()");
  assert.match(retry, /const recordingResult = ensureRecordingFinalized\(\)\.then/);
  assert.match(retry, /transcriptSealFailed = true/);
  assert.doesNotMatch(retry, /setRecordingUploadState\("error"\)[\s\S]*transcriptSealFailed/);
});

test("candidate stop, safety escalation, and unknown reasons are technical holds outside receipt flow", () => {
  const activate = functionBody(
    "function activateInterviewHold(",
    "async function holdInterviewForStaffReview(",
  );
  assert.ok(
    activate.indexOf("endingRef.current = true") < activate.indexOf("stopRealtime()"),
    "the sticky local fence must precede recorder/network shutdown",
  );
  assert.match(activate, /pendingCompletionTimerRef\.current = null/);
  assert.match(activate, /pendingCompletionReasonRef\.current = null/);
  assert.match(activate, /clearResponseWatchdog\(\)/);

  const hold = functionBody(
    "async function holdInterviewForStaffReview(",
    "async function completeInterview(reason: string)",
  );
  assert.match(hold, /await liveUploader\.finalize\(audioCoverage\)/);
  assert.match(hold, /interruptedRecordingStored = true/);
  assert.match(hold, /recordingCompleteRef\.current = false/);
  assert.match(hold, /setArchiveSyncState\("error"\)/);
  assert.doesNotMatch(hold, /sealVoiceTranscriptCompletion|sealRecordedFallbackCompletion/);
  assert.doesNotMatch(hold, /requestEvaluation|storeInterviewFinalization|syncInterviewArchive/);

  const complete = functionBody(
    "async function completeInterview(reason: string)",
    "function handleRealtimeEvent(event: RealtimeEvent)",
  );
  assert.ok(
    complete.indexOf('reason === "candidate_requested_stop"') <
      complete.indexOf("verifyRecordingRemoteCoverageAtCompletion"),
    "candidate stop must branch before the normal seal/evaluation/archive path",
  );
  assert.ok(
    complete.indexOf('reason === "safety_escalation"') <
      complete.indexOf("verifyRecordingRemoteCoverageAtCompletion"),
    "safety escalation must branch before the normal seal/evaluation/archive path",
  );
  assert.ok(
    complete.indexOf("!SUCCESSFUL_COMPLETION_REASONS.has(reason)") <
      complete.indexOf("verifyRecordingRemoteCoverageAtCompletion"),
    "unknown reasons must fail closed before the normal completion path",
  );
  assert.match(source, /completionReason === "safety_escalation"[\s\S]*completeInterview\("safety_escalation"\)/);
  assert.match(source, /completeInterview\("completion_reason_invalid"\)/);
  assert.match(source, /runStickyInterviewCompletionHold/);
  assert.match(source, /completionHold === "none" && archiveSyncState !== "stored"/);
  assert.match(source, /面接は中止され、受付完了にはなっていません/);
  assert.match(source, /安全上の理由で中断し、受付完了にはなっていません/);
  assert.doesNotMatch(interviewSource, /enum: \["all_topics_covered", "candidate_requested_stop"/);
  assert.match(source, /modelAssertedCandidateStop/);
  assert.match(source, /reportCandidateEvent\("model_candidate_stop_rejected", "MODEL_TOOL_ARGUMENT"\)/);
  assert.match(source, /stopInterviewFromCandidateButton/);
  assert.match(source, /CANDIDATE_STOP_BUTTON_CONFIRMED/);
  assert.doesNotMatch(source, /completeInterview\("candidate_requested_stop"\)/);
  assert.match(source, /応募者本人が画面の「面接を中止」ボタンを押していないため、面接を中止しないでください/);
});

test("voice completion consumes strict pending item and response lifecycle state", () => {
  const events = functionBody(
    "function handleRealtimeEvent(event: RealtimeEvent)",
    "async function connectRealtime(",
  );
  for (const eventType of [
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
    "response.created",
    "response.done",
    "conversation.item.input_audio_transcription.completed",
    "conversation.item.input_audio_transcription.failed",
  ]) {
    const branch = events.slice(events.indexOf(`type === "${eventType}"`));
    assert.match(branch.slice(0, 900), /applyRealtimeTranscriptIntegrity\(event\)/, eventType);
  }
  const seal = functionBody("async function sealVoiceTranscriptCompletion()", "async function syncInterviewArchive(");
  assert.match(seal, /voiceTranscriptCompletionBlocker\(\)/);
  const completion = functionBody(
    "async function completeInterview(reason: string)",
    "function handleRealtimeEvent(event: RealtimeEvent)",
  );
  assert.match(completion, /activeMode === "voice" && voiceTranscriptCompletionBlocker\(\)/);
  assert.ok(
    completion.indexOf("voiceTranscriptCompletionBlocker()") < completion.indexOf("endingRef.current = true"),
    "pending voice events must block before recorder seal/evaluation begins",
  );
  const completed = events.slice(events.indexOf('type === "conversation.item.input_audio_transcription.completed"'));
  assert.match(completed.slice(0, 1_500), /if \(!itemId\)/);
  assert.match(completed.slice(0, 1_500), /if \(!text\)[\s\S]*promptCandidateToRepeatForTranscript\(\)/);
  assert.doesNotMatch(completed.slice(0, 1_500), /TRANSCRIPTION_EMPTY/);
  assert.ok(
    completed.indexOf("if (!text)") < completed.indexOf("rearmPendingCompletionWhenVoiceSettled(250)"),
    "empty completed text must request a repeat before completion can re-arm",
  );
  assert.match(source, /completeCandidateTranscriptionRepair\(\)/);
  assert.match(source, /同じ回答をもう一度お願いします/);
});

test("candidate event UI requires an exact durable receipt and never blindly resends ambiguity", () => {
  const reporter = functionBody("async function reportCandidateEvent(", "function clearCandidateResponseDelay()");
  assert.match(reporter, /reportCandidateEventOnce/);
  assert.match(reporter, /attemptedCandidateEventsRef\.current/);
  assert.match(reporter, /reportedCandidateEventsRef\.current/);
  const hold = functionBody("async function holdInterviewForStaffReview(", "async function completeInterview(reason: string)");
  assert.match(hold, /eventReceipt === "stored"/);
  assert.match(hold, /サーバー記録の受領確認が取れませんでした/);
  assert.match(hold, /自動再送は行いません/);
});

test("voice and text evaluation require an exact sealed durable draft", () => {
  const fenceStart = persistenceSource.indexOf("async function hasInterviewEvaluationTranscriptFence(");
  const fenceEnd = persistenceSource.indexOf("export async function sealVoiceInterviewTranscript(", fenceStart);
  assert.ok(fenceStart >= 0 && fenceEnd > fenceStart);
  const fence = persistenceSource.slice(fenceStart, fenceEnd);
  assert.match(fence, /hasExactSealedInterviewTranscriptDraft/);
  assert.match(fence, /input\.source === "durable_recorded_fallback"/);
  assert.doesNotMatch(fence, /state\.transcript_json !== input\.transcriptJson/);
  assert.doesNotMatch(fence, /state\.voice_transcript_sealed/);
});

test("recorded fallback disclosure matches the server-side evaluation helper", () => {
  assert.doesNotMatch(source, /自動評価は行わず、採用担当者が録画と照合/);
  assert.match(source, /自動文字起こしを根拠に評価補助を作成/);
  assert.match(source, /録画と文字起こしを照合して最終判断/);
  assert.match(source, /録画・音声の品質は不利益に使用しません/);
});

test("stored version 3 manifests remain readable by archive and staff range delivery", () => {
  const start = persistenceSource.indexOf("export async function getInterviewRecordingChunk(");
  const end = persistenceSource.indexOf("export async function getInterviewReview(", start);
  assert.ok(start >= 0 && end > start, "recording chunk source boundary missing");
  const chunkReader = persistenceSource.slice(start, end);
  assert.match(chunkReader, /!\[1, 2, 3\]\.includes\(manifest\.version\)/);
  assert.match(chunkReader, /manifest\.version !== 1[\s\S]*part\.sha256/);
});

test("unsealed version 3 uploads cannot exceed the final recording byte cap", () => {
  assert.match(
    persistenceSource,
    /MAX_PROVISIONAL_RECORDING_FULL_PARTS = Math\.floor\([\s\S]*MAX_RECORDING_BYTES \/ RECORDING_UPLOAD_PART_BYTES/,
  );
  const saveStart = persistenceSource.indexOf("export async function saveResumableInterviewRecordingPart(");
  const saveEnd = persistenceSource.indexOf("export async function completeResumableInterviewRecording(", saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart, "recording part source boundary missing");
  assert.match(
    persistenceSource.slice(saveStart, saveEnd),
    /isSealedRecordingUploadState\(state\)[\s\S]*MAX_PROVISIONAL_RECORDING_FULL_PARTS/,
  );
});

test("device loss resumes from server receipts without joining media containers", () => {
  assert.match(source, /fetch\("\/api\/interviews\/resume"/);
  assert.match(source, /action === "resume_text"/);
  assert.match(source, /action === "replace_with_text"/);
  assert.match(source, /recordingLiveUploaderRef\.current\?\.retry\(\)/);
  assert.match(source, /transcriptDraftWriterRef\.current!\.enqueue\(resumedTurns\)/);
  assert.match(source, /保存済みの質問・回答から、文字入力でそのまま再開できます/);
  assert.match(source, /音声・録画の保存済み部分は上書きせず保全/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|IndexedDB/);
  assert.match(
    persistenceSource,
    /UPDATE interview_sessions SET status = 'interrupted'/,
  );
  assert.match(
    persistenceSource,
    /NOT EXISTS \(SELECT 1 FROM interview_session_replacements replacement/,
  );
});
