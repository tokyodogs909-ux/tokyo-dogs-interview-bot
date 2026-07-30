import {
  googleDriveOAuthClientSettings,
  googleDriveOAuthRedirectUri,
  googleDriveScope,
} from "@/lib/google-drive-connection";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_DRIVE_OAUTH_STATE_COOKIE = "td_drive_oauth_state";
export const GOOGLE_DRIVE_OAUTH_VERIFIER_COOKIE = "td_drive_oauth_verifier";
const OAUTH_COOKIE_PATH = "/api/admin/google-drive/oauth";
const OAUTH_SESSION_SECONDS = 10 * 60;

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBase64Url(byteLength: number) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function readCookie(request: Request, name: string) {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function isHttpsRequest(request: Request) {
  return new URL(request.url).protocol === "https:" || request.headers.get("X-Forwarded-Proto") === "https";
}

function cookie(request: Request, name: string, value: string, maxAge: number, path: string) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAge}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isHttpsRequest(request)) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearGoogleDriveOAuthCookies(request: Request) {
  return [
    cookie(request, GOOGLE_DRIVE_OAUTH_STATE_COOKIE, "", 0, OAUTH_COOKIE_PATH),
    cookie(request, GOOGLE_DRIVE_OAUTH_VERIFIER_COOKIE, "", 0, OAUTH_COOKIE_PATH),
  ];
}

export function googleDriveAdminSessionCookie(request: Request, name: string, value: string, maxAge: number) {
  return cookie(request, name, value, maxAge, "/api/admin/google-drive");
}

async function constantTimeStringEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

export async function createGoogleDriveAuthorization(request: Request) {
  const { clientId } = googleDriveOAuthClientSettings();
  const redirectUri = googleDriveOAuthRedirectUri(request);
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const challenge = toBase64Url(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ));
  const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: googleDriveScope(),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return {
    authorizationUrl: authorizationUrl.toString(),
    cookies: [
      cookie(request, GOOGLE_DRIVE_OAUTH_STATE_COOKIE, state, OAUTH_SESSION_SECONDS, OAUTH_COOKIE_PATH),
      cookie(request, GOOGLE_DRIVE_OAUTH_VERIFIER_COOKIE, verifier, OAUTH_SESSION_SECONDS, OAUTH_COOKIE_PATH),
    ],
  };
}

async function readJson(response: Response) {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function exchangeGoogleDriveAuthorizationCode(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code")?.trim() ?? "";
  const returnedState = requestUrl.searchParams.get("state")?.trim() ?? "";
  const expectedState = readCookie(request, GOOGLE_DRIVE_OAUTH_STATE_COOKIE);
  const verifier = readCookie(request, GOOGLE_DRIVE_OAUTH_VERIFIER_COOKIE);
  if (
    requestUrl.searchParams.has("error") ||
    !code || code.length > 4096 ||
    !returnedState || !expectedState ||
    !await constantTimeStringEqual(returnedState, expectedState) ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)
  ) {
    throw new Error("GOOGLE_DRIVE_OAUTH_CALLBACK_INVALID");
  }
  const { clientId, clientSecret } = googleDriveOAuthClientSettings();
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleDriveOAuthRedirectUri(request),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const payload = await readJson(response);
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : "";
  const grantedScope = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
  if (!response.ok || !refreshToken) throw new Error("GOOGLE_DRIVE_OAUTH_TOKEN_EXCHANGE_FAILED");
  if (grantedScope.length > 0 && !grantedScope.includes(googleDriveScope())) {
    throw new Error("GOOGLE_DRIVE_OAUTH_SCOPE_MISMATCH");
  }
  return refreshToken;
}
