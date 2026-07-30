import {
  authorizeInterviewAdmin,
  createInterviewAdminSetupSession,
  INTERVIEW_ADMIN_SETUP_COOKIE,
} from "@/lib/admin-auth";
import {
  createGoogleDriveAuthorization,
  googleDriveAdminSessionCookie,
} from "@/lib/google-drive-oauth";
import { assertGoogleDriveConnectionStorageReady } from "@/lib/google-drive-connection";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    if (!await authorizeInterviewAdmin(request)) {
      return noStoreJson({ error: "管理者認証を確認できません。" }, { status: 401 });
    }
    await assertGoogleDriveConnectionStorageReady();
    const setupSession = await createInterviewAdminSetupSession();
    const authorization = await createGoogleDriveAuthorization(request);
    const response = noStoreJson({ authorizationUrl: authorization.authorizationUrl });
    response.headers.append(
      "Set-Cookie",
      googleDriveAdminSessionCookie(
        request,
        INTERVIEW_ADMIN_SETUP_COOKIE,
        setupSession.value,
        setupSession.maxAge,
      ),
    );
    authorization.cookies.forEach((value) => response.headers.append("Set-Cookie", value));
    return response;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code.includes("UNCONFIGURED") || code.includes("MISSING") || code.includes("UNAVAILABLE") ? 503 : 500;
    return noStoreJson({
      error: status === 503
        ? "Google Drive接続の管理設定が完了していません。"
        : "Google Drive接続を開始できませんでした。",
    }, { status });
  }
}
