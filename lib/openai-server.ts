import { EVALUATION_MODEL, REALTIME_MODEL } from "@/lib/interview";

function processApiKey() {
  const bound = (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: { OPENAI_API_KEY?: string };
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__?.OPENAI_API_KEY;
  if (bound?.trim()) return bound.trim();
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

type OpenAIHealthCache = {
  apiKeyHash: string;
  checkedAt: number;
  healthy: boolean;
};

function openAIServiceBinding() {
  return (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: { OPENAI_API?: Fetcher };
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__?.OPENAI_API;
}

let openAIHealthCache: OpenAIHealthCache | null = null;
const OPENAI_HEALTHY_CACHE_MS = 5 * 60 * 1000;
const OPENAI_UNHEALTHY_CACHE_MS = 30 * 1000;

function diagnosticToken(value: unknown) {
  if (typeof value !== "string") return null;
  return /^[a-z0-9._-]{1,80}$/i.test(value) ? value : null;
}

async function safeOpenAIErrorMetadata(response: Response) {
  if (response.ok) return { code: null, type: null };
  try {
    const payload = await response.clone().json() as {
      error?: { code?: unknown; type?: unknown };
    };
    return {
      code: diagnosticToken(payload.error?.code),
      type: diagnosticToken(payload.error?.type),
    };
  } catch {
    return { code: null, type: null };
  }
}

/**
 * The candidate readiness endpoint must not report green merely because a string
 * named OPENAI_API_KEY exists. A revoked, mistyped, or billing-disabled key looks
 * configured locally but makes every real interview fail only after camera/mic
 * permission. This zero-token models request verifies server authentication without
 * exposing the key or creating a paid response. The short module cache prevents the
 * public readiness check from becoming an upstream request amplifier.
 */
export async function verifyOpenAIAuthentication() {
  const apiKey = requireOpenAIApiKey();
  const apiKeyHash = await privacySafeIdentifier(apiKey);
  const now = Date.now();
  if (openAIHealthCache?.apiKeyHash === apiKeyHash) {
    const ttl = openAIHealthCache.healthy ? OPENAI_HEALTHY_CACHE_MS : OPENAI_UNHEALTHY_CACHE_MS;
    if (now - openAIHealthCache.checkedAt < ttl) return openAIHealthCache.healthy;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const requests = [REALTIME_MODEL, EVALUATION_MODEL].map((model) => new Request(
      `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      },
    ));
    // The optional Fetcher binding is used by deterministic Worker tests and can
    // also support a future egress proxy. Production normally takes global fetch.
    const service = openAIServiceBinding();
    const responses = await Promise.all(requests.map((request) =>
      service ? service.fetch(request) : fetch(request)));
    const healthy = responses.every((response) => response.ok);
    if (!healthy) {
      // Restrict upstream metadata to short machine-readable tokens. Never log
      // credentials, human-readable messages, response bodies, or candidate data.
      const errors = await Promise.all(responses.map(safeOpenAIErrorMetadata));
      console.warn("OPENAI_AUTHENTICATION_CHECK_FAILED", {
        models: [REALTIME_MODEL, EVALUATION_MODEL],
        statuses: responses.map((response) => response.status),
        requestIds: responses.map((response) => response.headers.get("x-request-id") ?? "unavailable"),
        errors,
      });
    }
    openAIHealthCache = { apiKeyHash, checkedAt: now, healthy };
    return healthy;
  } catch {
    openAIHealthCache = { apiKeyHash, checkedAt: now, healthy: false };
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function privacySafeIdentifier(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export function hasTrustedRequestOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    // Only request.url's own origin is trustworthy here. X-Forwarded-Host/Proto are
    // ordinary request headers a client can set on any cross-origin fetch, so honoring
    // them to widen the allowed set would let an attacker's own origin pass this check
    // and defeat the same-origin protection this function exists to provide.
    const requestUrl = new URL(request.url);
    return requestUrl.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function noStoreJson(payload: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

/**
 * Starts an application/json response immediately and emits legal JSON
 * whitespace while a long foreground operation is still running. Sites' public
 * dispatch path canceled an otherwise-connected archive request after about 167
 * seconds when no response headers or body had been produced. A streamed body
 * also keeps the Worker invocation alive under Cloudflare's documented HTTP
 * execution model, while the final JSON remains compatible with response.json().
 */
export function noStoreJsonStream(task: () => Promise<unknown>) {
  const encoder = new TextEncoder();
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (value: string) => {
        if (stopped) return;
        try {
          controller.enqueue(encoder.encode(value));
        } catch {
          stopped = true;
        }
      };
      // Leading whitespace is valid JSON and forces headers through every proxy
      // before the Drive work starts waiting on R2 or Google.
      write(" \n");
      heartbeat = setInterval(() => write(" \n"), 10_000);
      void task().then((payload) => {
        write(JSON.stringify(payload));
      }).catch(() => {
        write(JSON.stringify({
          stored: false,
          error: "面接記録の社内格納を完了できませんでした。採用担当者が保存状態を確認します。",
        }));
      }).finally(() => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (!stopped) controller.close();
        stopped = true;
      });
    },
    cancel() {
      stopped = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },
  });
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "application/json; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
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
