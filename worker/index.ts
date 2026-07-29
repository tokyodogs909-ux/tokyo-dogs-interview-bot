/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  RECORDINGS?: R2Bucket;
  INTERVIEW_REVIEW_TOKEN_KASAMA?: string;
  INTERVIEW_REVIEW_TOKEN_YAMAMOTO?: string;
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

function withSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
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
    (globalThis as typeof globalThis & {
      __TOKYO_DOGS_INTERVIEW_BINDINGS__?: Pick<Env, "DB" | "RECORDINGS" | "INTERVIEW_REVIEW_TOKEN_KASAMA" | "INTERVIEW_REVIEW_TOKEN_YAMAMOTO">;
    }).__TOKYO_DOGS_INTERVIEW_BINDINGS__ = {
      DB: bindings.DB,
      RECORDINGS: bindings.RECORDINGS,
      INTERVIEW_REVIEW_TOKEN_KASAMA: bindings.INTERVIEW_REVIEW_TOKEN_KASAMA,
      INTERVIEW_REVIEW_TOKEN_YAMAMOTO: bindings.INTERVIEW_REVIEW_TOKEN_YAMAMOTO,
    };
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
      return withSecurityHeaders(response);
    }

    return withSecurityHeaders(await handler.fetch(request, bindings, ctx));
  },
};

export default worker;
