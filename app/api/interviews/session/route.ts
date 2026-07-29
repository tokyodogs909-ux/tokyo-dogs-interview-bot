import {
  EMPLOYMENT_OPTIONS,
  isValidPreferredLocation,
  normalizePreferredLocation,
} from "@/lib/interview";
import { createInterviewSession, validateInterviewInvite } from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const rawBody = await request.text();
    if (rawBody.length > 4_000) {
      return noStoreJson({ error: "入力内容が長すぎます。" }, { status: 413 });
    }
    const payload = JSON.parse(rawBody) as {
      candidateName?: string;
      employment?: string;
      location?: string;
      consent?: boolean;
      inviteToken?: string;
    };
    const candidateName = payload.candidateName?.normalize("NFKC").replace(/\s+/g, " ").trim() ?? "";
    const employment = payload.employment?.trim() ?? "";
    const location = normalizePreferredLocation(payload.location);
    if (payload.consent !== true) {
      return noStoreJson({ error: "録音・録画と文字起こしへの同意が必要です。" }, { status: 400 });
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
    const invite = await validateInterviewInvite(payload.inviteToken?.trim());
    if (!invite) {
      return noStoreJson({ error: "このオンライン一次面接リンクは無効、使用済み、または期限切れです。採用担当者へご連絡ください。" }, { status: 403 });
    }
    const session = await createInterviewSession({
      candidateName,
      employment,
      location,
      inviteNonceHash: invite.nonceHash,
    });
    return noStoreJson(session, { status: 201 });
  } catch (error) {
    const unavailable = error instanceof Error && error.message === "INTERVIEW_DATABASE_UNAVAILABLE";
    const signingUnavailable = error instanceof Error && error.message === "INTERVIEW_INVITE_SIGNING_UNCONFIGURED";
    const invalidInvite = error instanceof Error && error.message === "INTERVIEW_INVITE_INVALID";
    if (invalidInvite) {
      return noStoreJson({ error: "このオンライン一次面接リンクは無効、使用済み、または期限切れです。採用担当者へご連絡ください。" }, { status: 403 });
    }
    return noStoreJson(
      {
        error: unavailable
          ? "オンライン一次面接記録の保存領域を準備できませんでした。"
          : signingUnavailable
            ? "オンライン一次面接リンクの署名設定が完了していません。"
            : "オンライン一次面接を開始できませんでした。",
      },
      { status: unavailable || signingUnavailable ? 503 : 500 },
    );
  }
}
