import { getRequestExecutionContext } from "vinext/shims/request-context";
import { recoverResumableInterviewRecording } from "@/lib/interview-persistence";

export function scheduleInterruptedInterviewRecovery(sessionId: string) {
  const context = getRequestExecutionContext();
  if (!context) return false;
  // R2 finalization is bounded metadata work. A later foreground request moves
  // the full recording to Drive because waitUntil is cancelled after 30 seconds.
  const promise = recoverResumableInterviewRecording(sessionId).catch(() => undefined);
  context.waitUntil(promise);
  return true;
}
