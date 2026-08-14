import {
  authorizeInterviewRequest,
  sealVoiceInterviewTranscript,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
import { readBoundedJsonBody } from "@/lib/http-body";
import {
  cleanVoiceTranscript,
  hasCandidateVoiceTurn,
  MAX_VOICE_TRANSCRIPT_BODY_CHARS,
} from "@/lib/voice-transcript-seal";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const body = await readBoundedJsonBody<{
      sessionId?: unknown;
      transcript?: unknown;
      transcriptionComplete?: unknown;
    }>(request, { maxBytes: MAX_VOICE_TRANSCRIPT_BODY_CHARS * 4 });
    if (!body.ok) {
      return noStoreJson({ error: body.status === 413 ? "文字起こしが長すぎます。" : "文字起こしを確認できませんでした。" }, { status: body.status });
    }
    const payload = body.value;
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    const transcript = cleanVoiceTranscript(payload.transcript);
    if (
      !/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) ||
      payload.transcriptionComplete !== true ||
      !hasCandidateVoiceTurn(transcript)
    ) {
      return noStoreJson({ error: "完了した回答の文字起こしを確認できません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson(
        { error: "オンライン一次面接の有効期限または認証を確認してください。" },
        { status: 401 },
      );
    }
    if (
      Number(authorized.session.candidate_requested_stop ?? 0) === 1 ||
      Number(authorized.session.safety_escalation ?? 0) === 1 ||
      Number(authorized.session.completion_reason_invalid ?? 0) === 1 ||
      Number(authorized.session.candidate_transcription_failed ?? 0) === 1
    ) {
      return noStoreJson({ error: "中止または最終文字起こし未確定の面接は確定できません。" }, { status: 409 });
    }
    // The exact append-only draft must already have its own durable seal. A tab
    // opened before that protocol existed fails closed here and cannot promote
    // an in-memory partial transcript into the canonical interview record.
    const result = await sealVoiceInterviewTranscript({ sessionId, transcript });
    return noStoreJson({
      sealed: true,
      alreadySealed: result.alreadySealed,
      turnCount: result.turnCount,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const conflict = code === "VOICE_TRANSCRIPT_SEAL_CONFLICT" ||
      code === "VOICE_TRANSCRIPT_SEAL_NOT_READY" ||
      code === "VOICE_TRANSCRIPT_DRAFT_NOT_SEALED" ||
      code.startsWith("TRANSCRIPT_DRAFT_");
    const unavailable = code === "INTERVIEW_DATABASE_UNAVAILABLE";
    return noStoreJson({
      error: conflict
        ? "一度確定した文字起こしと一致しません。自動上書きは行いません。"
        : unavailable
          ? "面接記録の保存先を利用できません。"
          : "回答の文字起こしを確定できませんでした。",
    }, { status: unavailable ? 503 : conflict ? 409 : 500 });
  }
}
