import {
  authorizeInterviewRequest,
  CANDIDATE_EVENT_TYPES,
  recordCandidateEvent,
  type CandidateEventType,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";
import { readBoundedJsonBody } from "@/lib/http-body";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const body = await readBoundedJsonBody<{
      sessionId?: string;
      eventType?: CandidateEventType;
      code?: string;
    }>(request, { maxBytes: 8_000 });
    if (!body.ok) {
      return noStoreJson({ error: body.status === 413 ? "イベント内容が長すぎます。" : "イベント内容を確認できませんでした。" }, { status: body.status });
    }
    const payload = body.value;
    const sessionId = payload.sessionId?.trim() ?? "";
    if (
      !/^TD-[A-Z0-9-]{6,40}$/.test(sessionId) ||
      !(CANDIDATE_EVENT_TYPES as readonly string[]).includes(payload.eventType ?? "")
    ) {
      return noStoreJson({ error: "記録イベントを確認できません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized) {
      return noStoreJson({ error: "オンライン一次面接の認証を確認できません。" }, { status: 401 });
    }
    const result = await recordCandidateEvent({
      sessionId,
      eventType: payload.eventType as CandidateEventType,
      detail: payload.code ? { code: payload.code.replace(/[^A-Z0-9_-]/gi, "").slice(0, 80) } : {},
    });
    if (result === "closed") {
      return noStoreJson({ error: "終了した面接には状態記録を追加できません。" }, { status: 409 });
    }
    if (result === "capped") {
      return noStoreJson({ error: "状態記録の上限に達しました。" }, { status: 429 });
    }
    return noStoreJson({ stored: true });
  } catch {
    return noStoreJson({ error: "状態記録を保存できませんでした。" }, { status: 500 });
  }
}
