type AdminBindings = {
  INTERVIEW_ADMIN_TOKEN?: string;
};

export const INTERVIEW_ADMIN_SETUP_COOKIE = "td_drive_admin_setup";
const SETUP_SESSION_SECONDS = 30 * 60;

function bindings() {
  return (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: AdminBindings;
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ ?? {};
}

function configuredAdminToken() {
  return (
    bindings().INTERVIEW_ADMIN_TOKEN ??
    (typeof process === "undefined" ? "" : process.env.INTERVIEW_ADMIN_TOKEN) ??
    ""
  ).trim();
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string) {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

async function setupSessionSignature(payload: string) {
  const secret = configuredAdminToken();
  if (!secret) throw new Error("INTERVIEW_ADMIN_AUTH_UNCONFIGURED");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

export async function authorizeInterviewAdmin(request: Request) {
  const expected = configuredAdminToken();
  if (!expected) throw new Error("INTERVIEW_ADMIN_AUTH_UNCONFIGURED");
  const authorization = request.headers.get("Authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!actual) return false;
  return constantTimeEqual(await sha256(actual), await sha256(expected));
}

export async function createInterviewAdminSetupSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + SETUP_SESSION_SECONDS;
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const payload = `${expiresAt}.${nonce}`;
  const signature = toBase64Url(await setupSessionSignature(payload));
  return {
    value: `${payload}.${signature}`,
    maxAge: SETUP_SESSION_SECONDS,
  };
}

export async function authorizeInterviewAdminSetupSession(request: Request) {
  const value = readCookie(request, INTERVIEW_ADMIN_SETUP_COOKIE);
  const [expiresRaw, nonce, signatureRaw, ...extra] = value.split(".");
  if (extra.length > 0 || !/^\d{10}$/.test(expiresRaw) || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) return false;
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  const actualSignature = fromBase64Url(signatureRaw);
  if (!actualSignature) return false;
  const expectedSignature = await setupSessionSignature(`${expiresRaw}.${nonce}`);
  return constantTimeEqual(actualSignature, expectedSignature);
}

export async function authorizeInterviewAdminOrSetupSession(request: Request) {
  if (await authorizeInterviewAdmin(request)) return true;
  return authorizeInterviewAdminSetupSession(request);
}
