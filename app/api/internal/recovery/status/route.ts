import { authorizeInterviewBackgroundRecoveryRequest } from "@/lib/interview-background-recovery";
import { getInterviewRecoveryTechnicalStatus } from "@/lib/interview-persistence";
import { noStoreJson } from "@/lib/openai-server";
import { readBoundedJsonBody } from "@/lib/http-body";

const MAX_STATUS_REQUEST_BYTES = 128;
const SESSION_ID_PATTERN = /^TD-[A-Z0-9-]{6,40}$/;

export async function POST(request: Request) {
  try {
    const authorization = await authorizeInterviewBackgroundRecoveryRequest(request);
    if (authorization === "unconfigured") {
      return noStoreJson(
        { error: "Recovery status authentication is not configured." },
        { status: 503 },
      );
    }
    if (authorization !== "authorized") {
      return noStoreJson(
        { error: "Recovery status authentication failed." },
        { status: 401 },
      );
    }

    const body = await readBoundedJsonBody(request, { maxBytes: MAX_STATUS_REQUEST_BYTES });
    if (!body.ok) {
      return noStoreJson({
        error: body.status === 415 ? "Recovery status content type is invalid." : "Recovery status request body is invalid.",
      }, { status: body.status });
    }
    const payload = body.value;
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 1 ||
      !("sessionId" in payload) ||
      typeof payload.sessionId !== "string" ||
      !SESSION_ID_PATTERN.test(payload.sessionId)
    ) {
      return noStoreJson({ error: "Recovery status request body is invalid." }, { status: 400 });
    }

    const technicalStatus = await getInterviewRecoveryTechnicalStatus(payload.sessionId);
    if (!technicalStatus) {
      return noStoreJson({ error: "Recovery status record was not found." }, { status: 404 });
    }
    return noStoreJson({ technicalStatus });
  } catch (error) {
    const unavailable = error instanceof Error && error.message === "INTERVIEW_DATABASE_UNAVAILABLE";
    console.error("interview_recovery_status_failed");
    return noStoreJson(
      { error: unavailable ? "Recovery status storage is unavailable." : "Recovery status failed." },
      { status: unavailable ? 503 : 500 },
    );
  }
}
