import { getRequestExecutionContext } from "vinext/shims/request-context";
import { recoverResumableInterviewRecording } from "@/lib/interview-persistence";
import { syncInterviewToGoogleDrive } from "@/lib/google-drive-sync";

export function scheduleInterruptedInterviewRecovery(sessionId: string) {
  const context = getRequestExecutionContext();
  if (!context) return false;
  const promise = recoverResumableInterviewRecording(sessionId)
    .then(() => syncInterviewToGoogleDrive(sessionId))
    .catch(() => undefined);
  context.waitUntil(promise);
  return true;
}
