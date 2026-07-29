import { authorizeInterviewAdmin } from "@/lib/admin-auth";
import { issueInterviewInvite } from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    if (!await authorizeInterviewAdmin(request)) {
      return noStoreJson({ error: "管理者認証を確認できません。" }, { status: 401 });
    }
    const rawBody = await request.text();
    if (rawBody.length > 1_000) return noStoreJson({ error: "入力内容が長すぎます。" }, { status: 413 });
    const payload = rawBody ? JSON.parse(rawBody) as { expiresInHours?: unknown } : {};
    const expiresInHours = payload.expiresInHours === undefined ? 72 : Number(payload.expiresInHours);
    if (!Number.isFinite(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
      return noStoreJson({ error: "有効期限は1〜168時間で指定してください。" }, { status: 400 });
    }
    const invite = await issueInterviewInvite(expiresInHours);
    const url = new URL("/", new URL(request.url).origin);
    url.searchParams.set("invite", invite.token);
    return noStoreJson({ link: url.toString(), expiresAt: invite.expiresAt }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code === "INTERVIEW_ADMIN_AUTH_UNCONFIGURED" ||
      code === "INTERVIEW_INVITE_SIGNING_UNCONFIGURED" ||
      code === "INTERVIEW_DATABASE_UNAVAILABLE" ? 503 : 500;
    return noStoreJson({
      error: code === "INTERVIEW_INVITE_SIGNING_UNCONFIGURED"
        ? "面接リンク署名の設定が完了していません。"
        : code === "INTERVIEW_DATABASE_UNAVAILABLE"
          ? "オンライン一次面接の保存領域へ接続できません。"
          : "オンライン一次面接リンクを発行できませんでした。",
    }, { status });
  }
}
