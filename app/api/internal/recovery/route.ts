import {
  authorizeInterviewBackgroundRecoveryRequest,
  runInterviewBackgroundRecoveryOnce,
} from "@/lib/interview-background-recovery";
import { noStoreJson } from "@/lib/openai-server";
import { readBoundedJsonBody } from "@/lib/http-body";

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

    const body = await readBoundedJsonBody(request, { maxBytes: 64 });
    if (!body.ok) {
      return noStoreJson(
        { error: body.status === 415 ? "Background recovery content type is invalid." : "Background recovery request body is invalid." },
        { status: body.status },
      );
    }
    const payload = body.value;
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
