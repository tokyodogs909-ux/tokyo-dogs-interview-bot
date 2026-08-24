import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TECHNICAL_EVIDENCE_TRANSCRIPT_KIND,
  technicalEvidenceArchiveTranscript,
} from "../lib/interview-technical-evidence.js";

function eligibleSource() {
  const transcript = [
    { id: "assistant-1", speaker: "interviewer", text: "質問です", createdAt: "2026-08-20T00:00:00Z" },
    { id: "candidate-1", speaker: "candidate", text: "回答です", createdAt: "2026-08-20T00:01:00Z" },
  ];
  return {
    status: "in_progress",
    recordingStatus: "stored",
    recording: { byteSize: 70_000_000 },
    transcript: [],
    evaluation: null,
    completedAt: null,
    transcriptDraft: {
      mode: "voice",
      transcript,
      turnCount: transcript.length,
      sealedAt: null,
    },
    auditEvents: [{ type: "transcription_failed", detail: { code: "TRANSCRIPTION_EMPTY" } }],
  };
}

test("only a stored draft with a known transcription fault is eligible for a technical evidence archive", () => {
  const source = eligibleSource();
  assert.equal(TECHNICAL_EVIDENCE_TRANSCRIPT_KIND, "partial_transcript_human_review");
  assert.equal(technicalEvidenceArchiveTranscript(source), source.transcriptDraft.transcript);

  for (const code of ["TRANSCRIPTION_EMPTY", "TRANSCRIPTION_FAILED", "TRANSCRIPTION_ID_MISSING"]) {
    const knownFailure = structuredClone(source);
    knownFailure.auditEvents[0].detail.code = code;
    assert.equal(technicalEvidenceArchiveTranscript(knownFailure), knownFailure.transcriptDraft.transcript);
  }

  for (const mutate of [
    (value) => { value.recordingStatus = "uploading"; },
    (value) => { value.recording = null; },
    (value) => { value.status = "completed"; },
    (value) => { value.evaluation = {}; },
    (value) => { value.transcriptDraft.sealedAt = "2026-08-20T00:02:00Z"; },
    (value) => { value.transcriptDraft.transcript[1].text = ""; },
    (value) => { value.auditEvents[0].detail.code = "UNKNOWN_TRANSCRIPTION_ERROR"; },
    (value) => { value.auditEvents.push({ type: "transcription_failed", detail: { code: "UNKNOWN_TRANSCRIPTION_ERROR" } }); },
    (value) => { value.auditEvents.push({ type: "candidate_requested_stop", detail: {} }); },
  ]) {
    const value = structuredClone(source);
    mutate(value);
    assert.equal(technicalEvidenceArchiveTranscript(value), null);
  }
});

test("Drive renders eligible evidence as a non-evaluated technical hold, never a completed transcript", async () => {
  const source = await readFile(new URL("../lib/google-drive-sync.ts", import.meta.url), "utf8");
  assert.match(source, /TECHNICAL_EVIDENCE_TRANSCRIPT_KIND/);
  assert.match(source, /技術保留記録（一部文字起こし・人手確認必須）/);
  assert.match(source, /面接未完了の技術保留/);
  assert.match(source, /technicalHold: transcriptKind === TECHNICAL_EVIDENCE_TRANSCRIPT_KIND/);
  assert.match(source, /automaticEvaluationPerformed: source\.evaluation !== null/);
  assert.match(source, /if \(isTechnicalEvidenceArchiveSource\(source\)\) return;[\s\S]*source\.status !== "completed"/);
});
