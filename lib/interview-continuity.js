export const INTERVIEW_CONTINUITY_COOKIE = "__Host-td-interview-continuity";

const SESSION_ID_PATTERN = /^TD-[A-Z0-9-]{6,40}$/;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,80}$/;

function encode(value) {
  return encodeURIComponent(value);
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export function parseInterviewContinuityCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.length > 8_192) return null;
  const entry = cookieHeader.split(";").map((item) => item.trim()).find((item) =>
    item.startsWith(`${INTERVIEW_CONTINUITY_COOKIE}=`));
  if (!entry) return null;
  const raw = decode(entry.slice(INTERVIEW_CONTINUITY_COOKIE.length + 1));
  const [version, sessionId, accessToken, ...extra] = raw.split(".");
  if (
    version !== "v1" ||
    extra.length !== 0 ||
    !SESSION_ID_PATTERN.test(sessionId ?? "") ||
    !ACCESS_TOKEN_PATTERN.test(accessToken ?? "")
  ) return null;
  return { sessionId, accessToken };
}

export function serializeInterviewContinuityCookie(input) {
  if (
    !input ||
    !SESSION_ID_PATTERN.test(input.sessionId ?? "") ||
    !ACCESS_TOKEN_PATTERN.test(input.accessToken ?? "") ||
    !Number.isFinite(input.maxAgeSeconds) ||
    input.maxAgeSeconds < 1
  ) throw new Error("INTERVIEW_CONTINUITY_COOKIE_INVALID");
  const maxAge = Math.min(8 * 60 * 60, Math.floor(input.maxAgeSeconds));
  return `${INTERVIEW_CONTINUITY_COOKIE}=${encode(`v1.${input.sessionId}.${input.accessToken}`)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearInterviewContinuityCookie() {
  return `${INTERVIEW_CONTINUITY_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
