import {
  authorizeInterviewBackgroundRecoveryRequest,
  runInterviewBackgroundRecoveryOnce,
} from "@/lib/interview-background-recovery";
import { noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    const authorization = await authorizeInterviewBackgroundRecoveryRequest(request);
    if (authorization === "unconfigured") {
      return noStoreJson(
        { error: "Background recovery authentication is not configured." },
        { status: 503 },
      );
    }
    if (authorization !== "authorized") {
      return noStoreJson(
        { error: "Background recovery authentication failed." },
        { status: 401 },
      );
    }

    if (request.headers.get("Content-Type") !== "application/json") {
      return noStoreJson(
        { error: "Background recovery content type is invalid." },
        { status: 415 },
      );
    }
    const contentLength = request.headers.get("Content-Length") ?? "";
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > 64) {
      return noStoreJson(
        { error: "Background recovery request body is invalid." },
        { status: 413 },
      );
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 64) {
      return noStoreJson(
        { error: "Background recovery request body is invalid." },
        { status: 413 },
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = null;
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 0
    ) {
      return noStoreJson(
        { error: "Background recovery request body is invalid." },
        { status: 400 },
      );
    }

    const states = await runInterviewBackgroundRecoveryOnce();
    return noStoreJson({ tick: "completed", states });
  } catch {
    // Keep machine-facing failures fixed and aggregate. Exception messages may
    // contain upstream URLs or storage details and must not enter public logs.
    console.error("interview_background_recovery_http_failed");
    return noStoreJson(
      { error: "Background recovery failed." },
      { status: 500 },
    );
  }
}
