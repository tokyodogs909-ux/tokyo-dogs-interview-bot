import {
  authorizeInterviewRequest,
  claimInterviewRecordingUpload,
  failInterviewRecordingUpload,
  hasRecordingStorage,
  saveInterviewRecording,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

const MAX_RECORDING_BYTES = 95 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["video/webm", "audio/webm", "video/mp4", "audio/mp4"]);

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const sessionId = request.headers.get("X-Interview-Session")?.trim() ?? "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "オンライン一次面接の接続情報が正しくありません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
    }
    if (!["in_progress", "evaluation_pending", "evaluation_processing", "completed"].includes(authorized.session.status)) {
      return noStoreJson({ error: "このオンライン一次面接は録画を受け付ける状態ではありません。" }, { status: 409 });
    }
    if (!hasRecordingStorage()) {
      return noStoreJson({ error: "録画の保存領域を準備できませんでした。" }, { status: 503 });
    }
    const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0].toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) {
      return noStoreJson({ error: "この録画形式には対応していません。" }, { status: 415 });
    }
    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return noStoreJson({ error: "録画サイズを確認できませんでした。" }, { status: 411 });
    }
    if (contentLength > MAX_RECORDING_BYTES) {
      return noStoreJson({ error: "録画サイズが上限を超えています。" }, { status: 413 });
    }
    if (!request.body) {
      return noStoreJson({ error: "録画データがありません。" }, { status: 400 });
    }
    const audioCoverage = request.headers.get("X-Interview-Audio-Coverage")?.trim() ?? "unverified";
    if (!["both", "candidate-only", "unverified"].includes(audioCoverage)) {
      return noStoreJson({ error: "録画の音声確認情報が正しくありません。" }, { status: 400 });
    }
    if (!await claimInterviewRecordingUpload(sessionId)) {
      return noStoreJson({ error: "録画はすでに保存済み、または現在保存中です。" }, { status: 409 });
    }
    try {
      await saveInterviewRecording({
        session: authorized.session,
        body: request.body,
        contentType,
        byteSize: contentLength,
        audioCoverage: audioCoverage as "both" | "candidate-only" | "unverified",
      });
    } catch (error) {
      await failInterviewRecordingUpload(sessionId);
      throw error;
    }
    return noStoreJson({ stored: true });
  } catch {
    return noStoreJson({ error: "録画を保存できませんでした。採用担当者へ連絡してください。" }, { status: 500 });
  }
}
