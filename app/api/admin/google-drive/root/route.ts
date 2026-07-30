import { authorizeInterviewAdminOrSetupSession } from "@/lib/admin-auth";
import { fetchGoogleDriveAccessToken, validateGoogleDriveFolderSelection } from "@/lib/google-drive-auth";
import { saveGoogleDriveRoot } from "@/lib/google-drive-connection";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    if (!await authorizeInterviewAdminOrSetupSession(request)) {
      return noStoreJson({ error: "管理者認証を確認できません。" }, { status: 401 });
    }
    const rawBody = await request.text();
    if (rawBody.length > 500) return noStoreJson({ error: "入力内容が長すぎます。" }, { status: 413 });
    const payload = JSON.parse(rawBody) as { folderId?: unknown };
    const folderId = typeof payload.folderId === "string" ? payload.folderId.trim() : "";
    const accessToken = await fetchGoogleDriveAccessToken();
    const root = await validateGoogleDriveFolderSelection(folderId, accessToken);
    await saveGoogleDriveRoot({ id: root.id, name: root.name, webViewLink: root.webViewLink });
    return noStoreJson({ saved: true, root });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code.includes("AUTH_UNCONFIGURED") || code.includes("CONFIGURATION_MISSING") ? 503
      : code.includes("INVALID") || code.includes("MISMATCH") ? 400
        : code.includes("NOT_WRITABLE") ? 409
          : 502;
    const errorMessage = code.includes("MISMATCH")
      ? "指定フォルダ名が承認済みの保存先名と一致しません。"
      : code.includes("NOT_WRITABLE")
        ? "指定フォルダへファイルを追加できません。"
        : code.includes("INVALID")
          ? "保存先フォルダを確認してください。"
          : status === 503
            ? "Google Driveの管理設定が完了していません。"
            : "保存先フォルダを登録できませんでした。";
    return noStoreJson({ error: errorMessage }, { status });
  }
}
