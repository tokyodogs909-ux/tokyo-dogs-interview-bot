import { finalizeRecordedInterview } from "@/lib/recorded-interview-completion";
import { recoverNextStaleInterviewEvaluation } from "@/lib/interview-evaluation-recovery";
import {
  authorizeReviewerRequest,
  recoverNextSealedResumableInterviewRecording,
} from "@/lib/interview-persistence";
import {
  findRecordedInterviewReadyForCompletion,
  recoverNextRecordedAnswerTranscription,
} from "@/lib/recorded-transcription";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const reviewer = await authorizeReviewerRequest(request);
    if (!reviewer) {
      return noStoreJson({ error: "採用担当者の認証を確認できませんでした。" }, { status: 401 });
    }
    // A sealed interview can survive a browser close after the last part but
    // before the candidate's recording-complete response. Finalization is only
    // metadata work and refuses to store when even one expected part is absent.
    const recording = await recoverNextSealedResumableInterviewRecording();
    // One poll advances at most one paid transcription. The D1 claim and
    // Retry-After fence prevent duplicate model calls across staff tabs.
    const transcription = await recoverNextRecordedAnswerTranscription();
    const ready = await findRecordedInterviewReadyForCompletion();
    const completion = ready
      ? await finalizeRecordedInterview(ready.sessionId, ready.questionCount)
      : null;
    // A normal voice/text interview may have durably stored its transcript and
    // then lost the Worker before evaluation was saved. Recover one stale claim
    // per poll without another paid model call, using the same atomic claim fence.
    const evaluation = await recoverNextStaleInterviewEvaluation();
    return noStoreJson({
      processed: transcription.state === "processed" || evaluation.state === "completed",
      recording: recording.state === "none"
        ? null
        : { sessionId: recording.sessionId, state: recording.state },
      transcription: transcription.state === "processed"
        ? {
            sessionId: transcription.sessionId,
            answerIndex: transcription.answerIndex,
            state: transcription.result,
            retryAfterSeconds: transcription.retryAfterSeconds,
          }
        : null,
      completion: ready ? { sessionId: ready.sessionId, state: completion?.state } : null,
      evaluation: evaluation.state === "none"
        ? null
        : { sessionId: evaluation.sessionId, state: evaluation.state },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const unavailable = code.includes("STORAGE_UNAVAILABLE") ||
      code.includes("DATABASE_UNAVAILABLE") ||
      code.includes("OPENAI_API_KEY");
    return noStoreJson({
      error: unavailable
        ? "録画回答の文字起こし復旧に必要な設定を確認してください。"
        : "録画回答の文字起こし復旧を完了できませんでした。",
    }, { status: unavailable ? 503 : 500 });
  }
}
