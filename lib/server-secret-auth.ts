export const RECOMMENDED_SERVER_SECRET_BYTES = 32;
const MAX_AUTHORIZATION_HEADER_CHARS = 600;

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
}

export function secureBytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function serverSecretReadiness(secret: string) {
  const normalized = secret.trim();
  return {
    configured: normalized.length > 0,
    strong: new TextEncoder().encode(normalized).byteLength >= RECOMMENDED_SERVER_SECRET_BYTES,
  };
}

export async function secureServerSecretMatch(actual: string, expected: string) {
  if (!actual || !expected) return false;
  const [actualHash, expectedHash] = await Promise.all([sha256(actual), sha256(expected)]);
  return secureBytesEqual(actualHash, expectedHash);
}

export function bearerToken(request: Request) {
  const authorization = request.headers.get("Authorization") ?? "";
  if (
    authorization.length > MAX_AUTHORIZATION_HEADER_CHARS ||
    !authorization.startsWith("Bearer ")
  ) return "";
  return authorization.slice(7).trim();
}

export async function authorizeBearerSecret(request: Request, expected: string) {
  return secureServerSecretMatch(bearerToken(request), expected.trim());
}
