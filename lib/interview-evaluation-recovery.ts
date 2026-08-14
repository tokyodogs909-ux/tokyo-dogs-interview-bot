import { buildDeferredHumanEvaluation } from "@/lib/interview-evaluation-fallback";
import {
  claimInterviewEvaluation,
  findNextStaleInterviewEvaluation,
  saveInterviewEvaluation,
} from "@/lib/interview-persistence";

export type StaleEvaluationRecoveryResult =
  | { state: "none" }
  | { state: "claimed_elsewhere"; sessionId: string }
  | { state: "completed"; sessionId: string };

/**
 * Converts at most one abandoned model-evaluation claim into an explicit human
 * review record. This path never calls OpenAI: it only uses transcript bytes
 * that were durably committed before the original Worker died.
 */
export async function recoverNextStaleInterviewEvaluation(): Promise<StaleEvaluationRecoveryResult> {
  const target = await findNextStaleInterviewEvaluation();
  if (!target) return { state: "none" };

  // claimInterviewEvaluation is the compare-and-set fence shared with the live
  // evaluator. If another staff tab or a late Worker won first, do not overwrite
  // its result or manufacture a second completion.
  const claimId = await claimInterviewEvaluation({
    sessionId: target.sessionId,
    transcript: target.transcript,
    source: target.source,
  });
  if (!claimId) return { state: "claimed_elsewhere", sessionId: target.sessionId };

  const saved = await saveInterviewEvaluation({
    sessionId: target.sessionId,
    transcript: target.transcript,
    evaluation: buildDeferredHumanEvaluation("service_unavailable"),
    claimId,
    source: target.source,
  });
  return saved
    ? { state: "completed", sessionId: target.sessionId }
    : { state: "claimed_elsewhere", sessionId: target.sessionId };
}
