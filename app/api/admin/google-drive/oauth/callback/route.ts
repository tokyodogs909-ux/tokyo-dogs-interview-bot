import { saveGoogleDriveRefreshToken } from "@/lib/google-drive-connection";
import {
  clearGoogleDriveOAuthCookies,
  exchangeGoogleDriveAuthorizationCode,
} from "@/lib/google-drive-oauth";

function finishRedirect(request: Request, status: "connected" | "failed") {
  const target = new URL("/staff/google-drive", request.url);
  target.searchParams.set(status === "connected" ? "connected" : "error", status === "connected" ? "1" : "oauth_failed");
  const response = new Response(null, { status: 303, headers: { Location: target.toString() } });
  clearGoogleDriveOAuthCookies(request).forEach((value) => response.headers.append("Set-Cookie", value));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const refreshToken = await exchangeGoogleDriveAuthorizationCode(request);
    await saveGoogleDriveRefreshToken(refreshToken);
    return finishRedirect(request, "connected");
  } catch {
    return finishRedirect(request, "failed");
  }
}
