import {
  authorizeInterviewRequest,
  sealInterviewTranscriptDraft,
  type InterviewTranscriptDraftMode,
} from "@/lib/interview-persistence";
import { readBoundedJsonBody } from "@/lib/http-body";
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
    const body = await readBoundedJsonBody<{
      sessionId?: unknown;
      mode?: unknown;
      transcript?: unknown;
    }>(request, { maxBytes: MAX_VOICE_TRANSCRIPT_BODY_CHARS * 4 });
    if (!body.ok) {
      return noStoreJson({
        error: body.status === 413 ? "回答記録が長すぎます。" : "回答記録を確認できませんでした。",
      }, { status: body.status });
    }
    const sessionId = typeof body.value.sessionId === "string" ? body.value.sessionId.trim() : "";
    const mode = body.value.mode === "voice" || body.value.mode === "text"
      ? body.value.mode as InterviewTranscriptDraftMode
      : null;
    const transcript = cleanVoiceTranscript(body.value.transcript);
    if (
      !/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) ||
      !mode ||
      !hasCandidateVoiceTurn(transcript)
    ) {
      return noStoreJson({ error: "確定する回答記録を確認できませんでした。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson(
        { error: "オンライン一次面接の有効期限または認証を確認してください。" },
        { status: 401 },
      );
    }
    const receipt = await sealInterviewTranscriptDraft({ sessionId, mode, transcript });
    return noStoreJson({ sealed: true, ...receipt });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const unavailable = code === "INTERVIEW_DATABASE_UNAVAILABLE";
    const conflict = code.startsWith("TRANSCRIPT_DRAFT_");
    return noStoreJson({
      error: unavailable
        ? "面接記録の保存先を利用できません。"
        : conflict
          ? "保存済みの回答記録と一致しないため、確定できません。"
          : "回答記録を確定できませんでした。",
    }, { status: unavailable ? 503 : conflict ? 409 : 500 });
  }
}
