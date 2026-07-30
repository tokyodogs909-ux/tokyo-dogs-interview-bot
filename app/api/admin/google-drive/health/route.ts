import { authorizeInterviewAdminOrSetupSession } from "@/lib/admin-auth";
import {
  missingGoogleDriveConfiguration,
  validateGoogleDriveRoot,
} from "@/lib/google-drive-auth";
import { noStoreJson } from "@/lib/openai-server";

export async function GET(request: Request) {
  try {
    if (!await authorizeInterviewAdminOrSetupSession(request)) {
      return noStoreJson({ error: "管理者認証を確認できません。" }, { status: 401 });
    }
    const missing = await missingGoogleDriveConfiguration();
    if (missing.length > 0) {
      return noStoreJson({
        configured: false,
        authenticated: false,
        missing,
      }, { status: 503 });
    }
    const root = await validateGoogleDriveRoot();
    return noStoreJson({
      configured: true,
      authenticated: true,
      root,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "INTERVIEW_ADMIN_AUTH_UNCONFIGURED") {
      return noStoreJson({ error: "管理者用認証の設定が完了していません。" }, { status: 503 });
    }
    const message = code === "GOOGLE_DRIVE_ROOT_MISMATCH"
      ? "承認済みのGoogle Drive保存先と一致しません。"
      : code === "GOOGLE_DRIVE_ROOT_NOT_WRITABLE"
        ? "承認済みのGoogle Drive保存先へ追加できません。"
        : "Google Driveの認証または保存先を確認できませんでした。";
    return noStoreJson({
      configured: true,
      authenticated: false,
      error: message,
    }, { status: 502 });
  }
}
