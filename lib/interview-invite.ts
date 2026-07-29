type InviteBindings = {
  INTERVIEW_INVITE_SIGNING_SECRET?: string;
  INTERVIEW_REQUIRE_SIGNED_INVITE?: string;
};

type InvitePayload = {
  v: 1;
  nonce: string;
  exp: number;
};

function bindings() {
  return (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: InviteBindings;
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ ?? {};
}

function setting(name: keyof InviteBindings) {
  const bound = bindings()[name];
  const local = typeof process === "undefined" ? undefined : process.env[name];
  return (bound ?? local ?? "").trim();
}

function signingSecret() {
  const secret = setting("INTERVIEW_INVITE_SIGNING_SECRET");
  if (!secret) throw new Error("INTERVIEW_INVITE_SIGNING_UNCONFIGURED");
  return secret;
}

export function signedInvitesRequired() {
  return setting("INTERVIEW_REQUIRE_SIGNED_INVITE").toLowerCase() === "true";
}

export function assertSignedInviteConfigured() {
  if (signedInvitesRequired()) signingSecret();
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textToBase64Url(value: string) {
  return toBase64Url(new TextEncoder().encode(value));
}

function fromBase64Url(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createInterviewInviteToken(nonce: string, expiresAt: Date) {
  const payload: InvitePayload = { v: 1, nonce, exp: Math.floor(expiresAt.getTime() / 1000) };
  const encoded = textToBase64Url(JSON.stringify(payload));
  return `${encoded}.${toBase64Url(await hmac(encoded))}`;
}

export async function verifyInterviewInviteToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  let actualSignature: Uint8Array;
  let payload: InvitePayload;
  try {
    actualSignature = fromBase64Url(parts[1]);
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as InvitePayload;
  } catch {
    return null;
  }
  if (!constantTimeEqual(actualSignature, await hmac(parts[0]))) return null;
  if (
    payload.v !== 1 ||
    typeof payload.nonce !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(payload.nonce) ||
    !Number.isInteger(payload.exp) ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) return null;
  return { nonceHash: await sha256Hex(payload.nonce), expiresAt: new Date(payload.exp * 1000).toISOString() };
}
