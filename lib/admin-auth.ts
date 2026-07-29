type AdminBindings = {
  INTERVIEW_ADMIN_TOKEN?: string;
};

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

export async function authorizeInterviewAdmin(request: Request) {
  const expected = configuredAdminToken();
  if (!expected) throw new Error("INTERVIEW_ADMIN_AUTH_UNCONFIGURED");
  const authorization = request.headers.get("Authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!actual) return false;
  return constantTimeEqual(await sha256(actual), await sha256(expected));
}
