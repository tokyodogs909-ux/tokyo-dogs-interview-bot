import {
  authorizeInterviewRequest,
  sealVoiceInterviewTranscript,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
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
    const rawBody = await request.text();
    if (rawBody.length > MAX_VOICE_TRANSCRIPT_BODY_CHARS) {
      return noStoreJson({ error: "文字起こしが長すぎます。" }, { status: 413 });
    }
    const payload = JSON.parse(rawBody) as {
      sessionId?: unknown;
      transcript?: unknown;
      transcriptionComplete?: unknown;
    };
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
    const result = await sealVoiceInterviewTranscript({ sessionId, transcript });
    return noStoreJson({
      sealed: true,
      alreadySealed: result.alreadySealed,
      turnCount: result.turnCount,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const conflict = code === "VOICE_TRANSCRIPT_SEAL_CONFLICT" ||
      code === "VOICE_TRANSCRIPT_SEAL_NOT_READY";
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
