import { INTERVIEW_ACCESS_MESSAGES, type InterviewAccessState } from "@/lib/interview";
import { describeInterviewInvite } from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

/**
 * Pre-flight for the candidate screen: tells it whether this browser holds a usable
 * signed invite BEFORE the camera and microphone permission prompt appears, so a
 * candidate who opened the plain top-level URL is stopped with a link explanation
 * instead of a permission prompt followed by a configuration error.
 *
 * This is advisory only. It never issues credentials and never relaxes anything —
 * POST /api/interviews/session independently re-validates and atomically consumes
 * the invite, so a candidate who skips or forges this response gains nothing.
 */
export async function GET(request: Request) {
  if (!hasTrustedRequestOrigin(request)) {
    return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
  }
  const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  try {
    const invite = await describeInterviewInvite(token || undefined);
    if (invite.status === "ok" || invite.status === "not-required") {
      return noStoreJson({ status: "ok", inviteRequired: invite.status === "ok" });
    }
    return noStoreJson(
      { status: invite.status, error: INTERVIEW_ACCESS_MESSAGES[invite.status] },
      { status: 403 },
    );
  } catch (error) {
    const status: InterviewAccessState =
      error instanceof Error && error.message === "INTERVIEW_INVITE_SIGNING_UNCONFIGURED"
        ? "signing-unavailable"
        : "storage-unavailable";
    return noStoreJson({ status, error: INTERVIEW_ACCESS_MESSAGES[status] }, { status: 503 });
  }
}
