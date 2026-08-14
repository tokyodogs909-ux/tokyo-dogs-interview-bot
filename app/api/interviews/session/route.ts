import {
  EMPLOYMENT_OPTIONS,
  INTERVIEW_ACCESS_MESSAGES,
  isValidPreferredLocation,
  normalizePreferredLocation,
} from "@/lib/interview";
import { hashPublicEntrySource } from "@/lib/interview-invite";
import {
  createInterviewSession,
  describeInterviewInvite,
  reservePublicInterviewEntry,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
import { readBoundedJsonBody } from "@/lib/http-body";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const body = await readBoundedJsonBody<{
      candidateName?: string;
      employment?: string;
      location?: string;
      consent?: boolean;
      interviewMode?: "camera" | "text";
      inviteToken?: string;
    }>(request, { maxBytes: 16_000 });
    if (!body.ok) {
      return noStoreJson({ error: body.status === 413 ? "入力内容が長すぎます。" : "入力内容を確認できませんでした。" }, { status: body.status });
    }
    const payload = body.value;
    const candidateName = payload.candidateName?.normalize("NFKC").replace(/\s+/g, " ").trim() ?? "";
    const employment = payload.employment?.trim() ?? "";
    const location = normalizePreferredLocation(payload.location);
    const interviewMode = payload.interviewMode ?? "camera";
    if (interviewMode !== "camera" && interviewMode !== "text") {
      return noStoreJson({ error: "オンライン一次面接の参加方法を確認してください。" }, { status: 400 });
    }
    if (payload.consent !== true) {
      return noStoreJson({ error: interviewMode === "camera" ? "録音・録画と文字起こしへの同意が必要です。" : "回答内容の選考利用への同意が必要です。" }, { status: 400 });
    }
    if (!candidateName || candidateName.length > 60 || /[\u0000-\u001F\u007F]/.test(candidateName)) {
      return noStoreJson({ error: "氏名を60文字以内で入力してください。" }, { status: 400 });
    }
    if (!(EMPLOYMENT_OPTIONS as readonly string[]).includes(employment)) {
      return noStoreJson({ error: "雇用形態を確認してください。" }, { status: 400 });
    }
    if (!isValidPreferredLocation(location)) {
      return noStoreJson({ error: "入職希望対象店舗を120文字以内で入力してください。" }, { status: 400 });
    }
    const invite = await describeInterviewInvite(payload.inviteToken?.trim());
    if (invite.status !== "ok" && invite.status !== "not-required") {
      return noStoreJson(
        { status: invite.status, error: INTERVIEW_ACCESS_MESSAGES[invite.status] },
        { status: 403 },
      );
    }
    if (invite.status === "not-required") {
      // Cloudflare overwrites CF-Connecting-IP at the trusted edge. User-Agent and
      // X-Forwarded-For are caller-controlled and must not let one source mint a
      // fresh throttle identity for every request.
      const connectingAddress = request.headers.get("cf-connecting-ip")?.trim() || "address-unavailable";
      const sourceHash = await hashPublicEntrySource(connectingAddress);
      const candidateHash = await hashPublicEntrySource(
        `${candidateName.toLocaleLowerCase("ja-JP")}\n${employment}\n${location.toLocaleLowerCase("ja-JP")}`,
      );
      await reservePublicInterviewEntry({ sourceHash, candidateHash });
    }
    const session = await createInterviewSession({
      candidateName,
      employment,
      location,
      interviewMode,
      inviteNonceHash: invite.nonceHash,
    });
    return noStoreJson(session, { status: 201 });
  } catch (error) {
    const unavailable = error instanceof Error && error.message === "INTERVIEW_DATABASE_UNAVAILABLE";
    const signingUnavailable = error instanceof Error && error.message === "INTERVIEW_INVITE_SIGNING_UNCONFIGURED";
    const invalidInvite = error instanceof Error && error.message === "INTERVIEW_INVITE_INVALID";
    const publicEntryRateLimited = error instanceof Error && error.message === "INTERVIEW_PUBLIC_ENTRY_RATE_LIMITED";
    if (invalidInvite) {
      // The invite was usable moments ago but lost the race to consume it, so the
      // most accurate thing we can tell the candidate is that it is already used.
      return noStoreJson({ status: "used", error: INTERVIEW_ACCESS_MESSAGES.used }, { status: 403 });
    }
    if (publicEntryRateLimited) {
      return noStoreJson({
        error: "短時間に複数回の開始操作が確認されました。しばらく時間を空けてから、もう一度お試しください。",
      }, { status: 429 });
    }
    if (unavailable || signingUnavailable) {
      const status = unavailable ? "storage-unavailable" : "signing-unavailable";
      return noStoreJson({ status, error: INTERVIEW_ACCESS_MESSAGES[status] }, { status: 503 });
    }
    return noStoreJson({ error: "オンライン一次面接を開始できませんでした。" }, { status: 500 });
  }
}
