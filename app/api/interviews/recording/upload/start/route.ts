import {
  authorizeInterviewRequest,
  beginProvisionalInterviewRecording,
  beginResumableInterviewRecording,
  hasRecordingStorage,
  validateProvisionalRecordingUploadShape,
  validateRecordingUploadShape,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
import { readBoundedJsonBody } from "@/lib/http-body";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    if (!hasRecordingStorage()) {
      return noStoreJson({ error: "録画の保存領域を準備できませんでした。" }, { status: 503 });
    }
    const body = await readBoundedJsonBody<{
      sessionId?: string;
      contentType?: string;
      byteSize?: number;
      partSize?: number;
      totalParts?: number;
      audioCoverage?: string;
      uploadVersion?: number;
      uploadId?: string;
    }>(request, { maxBytes: 8_000 });
    if (!body.ok) return noStoreJson({ error: body.status === 413 ? "録画情報が長すぎます。" : "録画情報を確認できませんでした。" }, { status: body.status });
    const payload = body.value;
    const sessionId = payload.sessionId?.trim() ?? "";
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
    if (payload.uploadVersion === 3) {
      const provisionalShape = validateProvisionalRecordingUploadShape({
        uploadId: payload.uploadId?.trim() ?? "",
        contentType: payload.contentType ?? "",
        partSize: Number(payload.partSize),
      });
      if (!provisionalShape) {
        return noStoreJson({ error: "録画の分割情報を確認できません。" }, { status: 400 });
      }
      const result = await beginProvisionalInterviewRecording({
        session: authorized.session,
        ...provisionalShape,
      });
      return noStoreJson(result);
    }
    const shape = validateRecordingUploadShape({
      contentType: payload.contentType ?? "",
      byteSize: Number(payload.byteSize),
      partSize: Number(payload.partSize),
      totalParts: Number(payload.totalParts),
      audioCoverage: payload.audioCoverage ?? "",
    });
    if (!shape) return noStoreJson({ error: "録画の分割情報を確認できません。" }, { status: 400 });
    // Tabs opened before the SHA-256 rollout do not send uploadVersion. Keep
    // those in Version 1 so a 15-27 minute interview that spans deployment can
    // still upload its locally held recording. Only the new client explicitly
    // opts into the stricter Version 2 part-digest contract.
    const uploadVersion = payload.uploadVersion === undefined ? 1 : payload.uploadVersion;
    if (uploadVersion !== 1 && uploadVersion !== 2) {
      return noStoreJson({ error: "録画の分割情報を確認できません。" }, { status: 400 });
    }
    const result = await beginResumableInterviewRecording({
      session: authorized.session,
      ...shape,
      uploadVersion,
    });
    return noStoreJson(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "INTERVIEW_RECORDING_UPLOAD_CONFLICT") {
      return noStoreJson({ error: "録画の再開情報が一致しません。採用担当者へご連絡ください。" }, { status: 409 });
    }
    if (code === "INTERVIEW_RECORDING_UPLOAD_BUSY") {
      return noStoreJson({ error: "録画の保存処理を確認中です。少し待ってから再試行してください。" }, { status: 409 });
    }
    if (code === "INTERVIEW_RECORDING_UPLOAD_EXPIRED") {
      return noStoreJson({ error: "録画の保存期限を超えました。採用担当者へご連絡ください。" }, { status: 409 });
    }
    return noStoreJson({ error: "録画の分割保存を開始できませんでした。" }, { status: 500 });
  }
}
