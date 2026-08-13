import {
  authorizeManualRepairRequest,
  createManualTranscriptDraft,
  MANUAL_TRANSCRIPTION_MODEL,
  readAndVerifyManualRepairAudio,
  validateManualRepairHeaders,
} from "@/lib/interview-manual-repair";
import { noStoreJson, noStoreJsonStream } from "@/lib/openai-server";

function errorResponse(code: string, status: number) {
  return noStoreJson({ error: { code } }, { status });
}

export async function POST(request: Request) {
  try {
    const authorization = await authorizeManualRepairRequest(request);
    if (authorization === "unconfigured") {
      return errorResponse("manual_repair_authentication_unconfigured", 503);
    }
    if (authorization !== "authorized") {
      return errorResponse("manual_repair_authentication_failed", 401);
    }

    const headers = validateManualRepairHeaders(request);
    if (headers.state === "configuration_unavailable") {
      return errorResponse("manual_repair_authentication_unconfigured", 503);
    }
    if (headers.state === "invalid_content_type") {
      return errorResponse("manual_repair_content_type_invalid", 415);
    }
    if (headers.state === "length_required") {
      return errorResponse("manual_repair_content_length_required", 411);
    }
    if (headers.state === "too_large") {
      return errorResponse("manual_repair_audio_too_large", 413);
    }
    if (headers.state !== "valid") {
      return errorResponse("manual_repair_request_invalid", 400);
    }

    let audio: Uint8Array;
    try {
      audio = await readAndVerifyManualRepairAudio(
        request,
        headers.declaredByteSize,
        headers.expectedSha256,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "BODY_TOO_LARGE") {
        return errorResponse("manual_repair_audio_too_large", 413);
      }
      return errorResponse("manual_repair_audio_verification_failed", 400);
    }

    // A full interview can take close to the 180-second upstream fence. Start
    // the JSON response before the paid request so Sites' public dispatch does
    // not cancel an otherwise healthy invocation while it is still waiting.
    // The stream contains legal leading JSON whitespace and one final object.
    return noStoreJsonStream(async () => {
      try {
        const result = await createManualTranscriptDraft({
          sessionId: headers.sessionId,
          audioIndex: headers.audioIndex,
          audio,
        });
        if (result.state === "upstream_rejected") {
          return { error: { code: "manual_repair_audio_rejected" } };
        }
        if (result.state === "upstream_unavailable") {
          return { error: { code: "manual_repair_upstream_unavailable" } };
        }
        if (result.state === "invalid_upstream_response") {
          return { error: { code: "manual_repair_upstream_response_invalid" } };
        }
        return {
          model: MANUAL_TRANSCRIPTION_MODEL,
          segments: result.segments,
        };
      } catch {
        console.error("manual_transcript_draft_failed");
        return { error: { code: "manual_repair_failed" } };
      }
    });
  } catch {
    // Fixed message only. Never log a candidate, session, request, transcript,
    // audio digest, provider body, or secret from this one-time repair route.
    console.error("manual_transcript_draft_failed");
    return errorResponse("manual_repair_failed", 500);
  }
}
