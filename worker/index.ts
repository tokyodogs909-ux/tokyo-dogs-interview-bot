/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runInterviewBackgroundRecoveryOnce } from "@/lib/interview-background-recovery";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  RECORDINGS?: R2Bucket;
  OPENAI_API_KEY?: string;
  OPENAI_API?: Fetcher;
  INTERVIEW_STAFF_TOKEN?: string;
  INTERVIEW_ADMIN_TOKEN?: string;
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  GOOGLE_DRIVE_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_ROOT_FOLDER_ID?: string;
  GOOGLE_DRIVE_EXPECTED_ROOT_NAME?: string;
  GOOGLE_DRIVE_OAUTH_REDIRECT_URI?: string;
  GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET?: string;
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_CLOUD_PROJECT_NUMBER?: string;
  INTERVIEW_INVITE_SIGNING_SECRET?: string;
  INTERVIEW_REQUIRE_SIGNED_INVITE?: string;
  INTERVIEW_RECOVERY_TOKEN?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type InterviewBindings = Pick<Env,
  | "DB"
  | "RECORDINGS"
  | "OPENAI_API_KEY"
  | "OPENAI_API"
  | "INTERVIEW_STAFF_TOKEN"
  | "INTERVIEW_ADMIN_TOKEN"
  | "GOOGLE_DRIVE_CLIENT_ID"
  | "GOOGLE_DRIVE_CLIENT_SECRET"
  | "GOOGLE_DRIVE_REFRESH_TOKEN"
  | "GOOGLE_DRIVE_ROOT_FOLDER_ID"
  | "GOOGLE_DRIVE_EXPECTED_ROOT_NAME"
  | "GOOGLE_DRIVE_OAUTH_REDIRECT_URI"
  | "GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET"
  | "GOOGLE_PICKER_API_KEY"
  | "GOOGLE_CLOUD_PROJECT_NUMBER"
  | "INTERVIEW_INVITE_SIGNING_SECRET"
  | "INTERVIEW_REQUIRE_SIGNED_INVITE"
  | "INTERVIEW_RECOVERY_TOKEN"
>;

function installInterviewBindings(bindings: Env) {
  (globalThis as typeof globalThis & {
    __TOKYO_DOGS_INTERVIEW_BINDINGS__?: InterviewBindings;
  }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ = {
    DB: bindings.DB,
    RECORDINGS: bindings.RECORDINGS,
    OPENAI_API_KEY: bindings.OPENAI_API_KEY,
    OPENAI_API: bindings.OPENAI_API,
    INTERVIEW_STAFF_TOKEN: bindings.INTERVIEW_STAFF_TOKEN,
    INTERVIEW_ADMIN_TOKEN: bindings.INTERVIEW_ADMIN_TOKEN,
    GOOGLE_DRIVE_CLIENT_ID: bindings.GOOGLE_DRIVE_CLIENT_ID,
    GOOGLE_DRIVE_CLIENT_SECRET: bindings.GOOGLE_DRIVE_CLIENT_SECRET,
    GOOGLE_DRIVE_REFRESH_TOKEN: bindings.GOOGLE_DRIVE_REFRESH_TOKEN,
    GOOGLE_DRIVE_ROOT_FOLDER_ID: bindings.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    GOOGLE_DRIVE_EXPECTED_ROOT_NAME: bindings.GOOGLE_DRIVE_EXPECTED_ROOT_NAME,
    GOOGLE_DRIVE_OAUTH_REDIRECT_URI: bindings.GOOGLE_DRIVE_OAUTH_REDIRECT_URI,
    GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET: bindings.GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET,
    GOOGLE_PICKER_API_KEY: bindings.GOOGLE_PICKER_API_KEY,
    GOOGLE_CLOUD_PROJECT_NUMBER: bindings.GOOGLE_CLOUD_PROJECT_NUMBER,
    INTERVIEW_INVITE_SIGNING_SECRET: bindings.INTERVIEW_INVITE_SIGNING_SECRET,
    INTERVIEW_REQUIRE_SIGNED_INVITE: bindings.INTERVIEW_REQUIRE_SIGNED_INVITE,
    INTERVIEW_RECOVERY_TOKEN: bindings.INTERVIEW_RECOVERY_TOKEN,
  };
}

function withSecurityHeaders(response: Response, request?: Request) {
  const headers = new Headers(response.headers);
  headers.set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // 'unsafe-inline' is still required: the framework emits per-request inline
    // RSC payload scripts, so their content changes on every render and cannot be
    // covered by hashes. script-src-attr 'none' closes the part of that gap that
    // matters most for XSS by blocking inline event-handler attributes
    // (onerror=, onclick=, …). No page in this app renders one.
    "script-src 'self' 'unsafe-inline' https://apis.google.com https://accounts.google.com",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self' https://api.openai.com wss://api.openai.com https://accounts.google.com https://www.googleapis.com",
    "frame-src https://accounts.google.com https://docs.google.com https://drive.google.com",
    "worker-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join("; "));
  if (request && new URL(request.url).protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (request && (new URL(request.url).pathname === "/" || new URL(request.url).pathname.startsWith("/staff"))) {
    headers.set("Cache-Control", "private, no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env | undefined, ctx: ExecutionContext): Promise<Response> {
    // `vinext start` does not inject Cloudflare bindings. Keep the public,
    // storage-free mobile test renderable while hosted Workers still receive
    // their normal bindings.
    const bindings = env ?? ({} as Env);
    installInterviewBindings(bindings);
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image" && bindings.ASSETS && bindings.IMAGES) {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => bindings.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await bindings.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(response, request);
    }

    return withSecurityHeaders(await handler.fetch(request, bindings, ctx), request);
  },

  scheduled(
    _controller: { scheduledTime: number; cron: string },
    env: Env | undefined,
    ctx: ExecutionContext,
  ) {
    const bindings = env ?? ({} as Env);
    installInterviewBindings(bindings);
    ctx.waitUntil(runInterviewBackgroundRecoveryOnce().then((summary) => {
      // Emit one fixed, aggregate heartbeat even on an idle tick. This is the
      // production readback proving that the deployed Cron Trigger is firing;
      // it contains no candidate identity, session ID, transcript, object key,
      // Drive URL, exception text, or secret.
      console.info("interview_background_recovery", { tick: "completed", states: summary });
    }).catch(() => {
      // Never reflect an exception message: upstream errors can contain URLs or
      // transport details. The next scheduled tick retries through durable CAS.
      console.error("interview_background_recovery_failed");
    }));
  },
};

export default worker;
