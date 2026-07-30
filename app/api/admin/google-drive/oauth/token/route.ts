import { authorizeInterviewAdminOrSetupSession } from "@/lib/admin-auth";
import { googlePickerSettings } from "@/lib/google-drive-connection";
import { fetchGoogleDriveAccessToken } from "@/lib/google-drive-auth";
import { noStoreJson } from "@/lib/openai-server";

export async function GET(request: Request) {
  try {
    if (!await authorizeInterviewAdminOrSetupSession(request)) {
      return noStoreJson({ error: "管理者認証を確認できません。" }, { status: 401 });
    }
    const { apiKey, projectNumber } = googlePickerSettings();
    const accessToken = await fetchGoogleDriveAccessToken();
    return noStoreJson({ accessToken, apiKey, projectNumber, expiresIn: 3000 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code.includes("MISSING") || code.includes("UNCONFIGURED") ? 503 : 502;
    return noStoreJson({
      error: status === 503
        ? "Google Driveの管理設定が完了していません。"
        : "Google Driveの接続を確認できませんでした。",
    }, { status });
  }
}
