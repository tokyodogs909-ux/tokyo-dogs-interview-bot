import { syncInterviewToGoogleDrive } from "@/lib/google-drive-sync";
import {
  recoverResumableInterviewRecording,
  releaseInterruptedExternalSync,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

const MAINTENANCE_ID = "2026-08-12-recording-archive-repair";
const REPAIR_BATCHES = [
  ["TD-MSO85H0W-XLIY5NA"],
  ["TD-MSOGPXBI-ND4OCDC"],
  ["TD-MSPHPNBC-Z7QFNFU"],
] as const;

/**
 * One-deployment maintenance hook for the three already-completed interviews
 * whose original recording-finalize requests were interrupted. The route is
 * deliberately limited to a fixed allowlist, returns no applicant data, and is
 * removed immediately after production read-back.
 */
export async function POST(request: Request) {
  if (!hasTrustedRequestOrigin(request)) {
    return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
  }
  let payload: { maintenanceId?: string; batch?: number } = {};
  try {
    payload = await request.json();
  } catch {
    return noStoreJson({ error: "保守リクエストを確認できません。" }, { status: 400 });
  }
  if (payload.maintenanceId !== MAINTENANCE_ID) {
    return noStoreJson({ error: "保守リクエストを確認できません。" }, { status: 400 });
  }
  const batch = Number(payload.batch);
  if (!Number.isInteger(batch) || batch < 1 || batch > REPAIR_BATCHES.length) {
    return noStoreJson({ error: "復旧対象を確認できません。" }, { status: 400 });
  }
  const targets = REPAIR_BATCHES[batch - 1];
  try {
    for (const sessionId of targets) {
      await recoverResumableInterviewRecording(sessionId);
      await releaseInterruptedExternalSync(sessionId);
      const result = await syncInterviewToGoogleDrive(sessionId);
      if (result.status !== "completed" || result.recordingIncluded !== true) {
        throw new Error("INTERVIEW_ARCHIVE_REPAIR_READBACK_FAILED");
      }
    }
  } catch {
    return noStoreJson({ error: "復旧処理を完了できませんでした。" }, { status: 502 });
  }
  return noStoreJson({ completed: true, repaired: targets.length });
}
