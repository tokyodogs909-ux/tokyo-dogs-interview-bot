import {
  authorizeInterviewRequest,
  sealProvisionalInterviewRecording,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
import { readBoundedJsonBody } from "@/lib/http-body";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const body = await readBoundedJsonBody<{
      sessionId?: string;
      uploadId?: string;
      byteSize?: number;
      totalParts?: number;
      audioCoverage?: string;
    }>(request, { maxBytes: 4_000 });
    if (!body.ok) return noStoreJson({ error: body.status === 413 ? "録画情報が長すぎます。" : "録画の確定情報を確認できません。" }, { status: body.status });
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
    const uploadId = payload.uploadId?.trim() ?? "";
    const audioCoverage = payload.audioCoverage ?? "";
    if (
      !/^[A-Za-z0-9_-]{16,80}$/.test(uploadId) ||
      !Number.isInteger(payload.byteSize) ||
      !Number.isInteger(payload.totalParts) ||
      !["both", "candidate-only", "unverified"].includes(audioCoverage)
    ) {
      return noStoreJson({ error: "録画の確定情報を確認できません。" }, { status: 400 });
    }
    const result = await sealProvisionalInterviewRecording({
      sessionId,
      uploadId,
      byteSize: payload.byteSize as number,
      totalParts: payload.totalParts as number,
      audioCoverage: audioCoverage as "both" | "candidate-only" | "unverified",
    });
    return noStoreJson(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code.includes("PART_MISSING")) {
      return noStoreJson({ error: "録画データの受信が途中です。自動再送します。" }, { status: 409 });
    }
    if (code.includes("UPLOAD_CONFLICT") || code.includes("UPLOAD_EXPIRED")) {
      return noStoreJson({ error: "録画の再開情報が一致しません。採用担当者へご連絡ください。" }, { status: 409 });
    }
    if (code.includes("UPLOAD_NOT_STARTED") || code.includes("UPLOAD_SEAL_INVALID")) {
      return noStoreJson({ error: "録画の確定情報を確認できません。" }, { status: 400 });
    }
    return noStoreJson({ error: "録画を確定できませんでした。" }, { status: 500 });
  }
}
