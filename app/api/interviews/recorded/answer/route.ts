import {
  authorizeInterviewRequest,
  interviewSessionAllowsCameraMedia,
  interviewSessionHasCompletionHold,
} from "@/lib/interview-persistence";
import {
  MAX_RECORDED_ANSWER_BYTES,
  saveAndTranscribeRecordedAnswer,
  validateRecordedAnswerContentType,
  validateRecordedAnswerIndex,
} from "@/lib/recorded-transcription";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const sessionId = request.headers.get("X-Interview-Session")?.trim() ?? "";
    const answerIndex = Number(request.headers.get("X-Recorded-Answer-Index"));
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) || !validateRecordedAnswerIndex(answerIndex)) {
      return noStoreJson({ error: "録画式面接の回答情報を確認できません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
    }
    if (interviewSessionHasCompletionHold(authorized.session)) {
      return noStoreJson({ error: "このオンライン一次面接は技術確認中のため回答を追加できません。" }, { status: 409 });
    }
    if (!["in_progress", "evaluation_pending"].includes(authorized.session.status)) {
      return noStoreJson({ error: "このオンライン一次面接は回答を受け付ける状態ではありません。" }, { status: 409 });
    }
    if (!await interviewSessionAllowsCameraMedia(sessionId)) {
      return noStoreJson({ error: "この面接方式では回答音声を保存できません。" }, { status: 409 });
    }

    const declaredBytesHeader = request.headers.get("X-Recorded-Answer-Bytes");
    let bytes: Uint8Array | undefined;
    let contentType: string | undefined;
    // X-Recorded-Answer-Bytes is the explicit upload/retry discriminator.
    // Cloudflare/Vinext can expose a zero-length ReadableStream as request.body
    // for a POST whose caller omitted body entirely. Treating body truthiness as
    // an upload therefore rejects legitimate R2-backed retries as malformed.
    // A request without the declaration can never register or replace audio;
    // saveAndTranscribeRecordedAnswer only reuses an already durable D1/R2 row.
    if (declaredBytesHeader !== null) {
      const declaredBytes = Number(declaredBytesHeader);
      contentType = validateRecordedAnswerContentType(request.headers.get("Content-Type") ?? "") ?? undefined;
      if (
        !contentType ||
        !Number.isInteger(declaredBytes) ||
        declaredBytes <= 0 ||
        declaredBytes > MAX_RECORDED_ANSWER_BYTES
      ) {
        const status = declaredBytes > MAX_RECORDED_ANSWER_BYTES ? 413 : 400;
        return noStoreJson({ error: status === 413 ? "回答音声のサイズが上限を超えています。" : "回答音声の形式またはサイズを確認できません。" }, { status });
      }
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength !== declaredBytes) {
        return noStoreJson({ error: "回答音声のサイズが一致しません。" }, { status: 400 });
      }
      bytes = new Uint8Array(buffer);
    }

    const result = await saveAndTranscribeRecordedAnswer({
      session: authorized.session,
      answerIndex,
      contentType,
      bytes,
    });
    if (result.state === "completed") {
      return noStoreJson({ stored: true, transcribed: true, answerIndex, alreadyCompleted: result.alreadyCompleted });
    }
    if (result.state === "pending") {
      return noStoreJson({
        stored: true,
        transcribed: false,
        pending: true,
        answerIndex,
        retryAfterSeconds: result.retryAfterSeconds,
      }, { status: 202, headers: { "Retry-After": String(result.retryAfterSeconds) } });
    }
    if (result.state === "missing") {
      return noStoreJson({ error: "この回答音声はまだ保存されていません。" }, { status: 409 });
    }
    return noStoreJson({ error: "回答音声を文字起こしできませんでした。採用担当者が録画を確認します。" }, { status: 422 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "RECORDED_ANSWER_AUDIO_CONFLICT") {
      return noStoreJson({ error: "同じ質問の回答音声が一致しません。自動上書きは行いません。" }, { status: 409 });
    }
    if (code === "RECORDED_INTERVIEW_HELD") {
      return noStoreJson({ error: "このオンライン一次面接は技術確認中のため回答を追加できません。" }, { status: 409 });
    }
    if (code.includes("STORAGE_UNAVAILABLE") || code.includes("OPENAI_API_KEY")) {
      return noStoreJson({ error: "回答音声の保存または文字起こしの準備が完了していません。" }, { status: 503 });
    }
    return noStoreJson({ error: "回答音声の保存を完了できませんでした。" }, { status: 500 });
  }
}
