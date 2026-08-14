import {
  authorizeInterviewRequest,
  saveInterviewTranscriptDraft,
  type InterviewTranscriptDraftMode,
} from "@/lib/interview-persistence";
import { readBoundedJsonBody } from "@/lib/http-body";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
import {
  cleanVoiceTranscript,
  MAX_VOICE_TRANSCRIPT_BODY_CHARS,
} from "@/lib/voice-transcript-seal";

function transcriptDraftError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "INTERVIEW_DATABASE_UNAVAILABLE") {
    return noStoreJson({ error: "面接記録の保存先を利用できません。" }, { status: 503 });
  }
  if (code.startsWith("TRANSCRIPT_DRAFT_")) {
    return noStoreJson({
      error: code.includes("PREFIX") || code.includes("MODE") || code.includes("CAS")
        ? "別の画面または以前の回答記録と一致しないため、自動上書きは行いません。"
        : "この回答記録は現在保存できません。",
    }, { status: 409 });
  }
  return noStoreJson({ error: "回答記録を保存できませんでした。" }, { status: 500 });
}

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
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) || !mode || transcript.length < 1) {
      return noStoreJson({ error: "回答記録を確認できませんでした。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson(
        { error: "オンライン一次面接の有効期限または認証を確認してください。" },
        { status: 401 },
      );
    }
    const receipt = await saveInterviewTranscriptDraft({ sessionId, mode, transcript });
    return noStoreJson({ stored: true, ...receipt });
  } catch (error) {
    return transcriptDraftError(error);
  }
}
