import {
  authorizeInterviewRequest,
  CANDIDATE_EVENT_TYPES,
  recordCandidateEvent,
  type CandidateEventType,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const rawBody = await request.text();
    if (rawBody.length > 2_000) {
      return noStoreJson({ error: "イベント内容が長すぎます。" }, { status: 413 });
    }
    const payload = JSON.parse(rawBody) as {
      sessionId?: string;
      eventType?: CandidateEventType;
      code?: string;
    };
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
    await recordCandidateEvent({
      sessionId,
      eventType: payload.eventType as CandidateEventType,
      detail: payload.code ? { code: payload.code.replace(/[^A-Z0-9_-]/gi, "").slice(0, 80) } : {},
    });
    return noStoreJson({ stored: true });
  } catch {
    return noStoreJson({ error: "状態記録を保存できませんでした。" }, { status: 500 });
  }
}
