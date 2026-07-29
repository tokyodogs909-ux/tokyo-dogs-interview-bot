function processApiKey() {
  if (typeof process === "undefined") return undefined;
  return process.env.OPENAI_API_KEY?.trim();
}

export function requireOpenAIApiKey() {
  const apiKey = processApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the server");
  }
  return apiKey;
}

export async function privacySafeIdentifier(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export function noStoreJson(payload: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

export function safeOpenAIError(status: number, code?: string) {
  if (code === "insufficient_quota") {
    return "オンライン一次面接の接続設定が完了していません。採用担当者へご連絡ください。";
  }
  if (status === 401 || status === 403) return "オンライン一次面接の接続を確認できませんでした。";
  if (status === 429) return "オンライン一次面接の接続が混み合っています。少し待ってから再度お試しください。";
  return "オンライン一次面接へ接続できませんでした。再度お試しください。";
}

export async function readOpenAIError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: { code?: string; type?: string } };
    return safeOpenAIError(
      response.status,
      payload.error?.code ?? payload.error?.type,
    );
  } catch {
    return safeOpenAIError(response.status);
  }
}
