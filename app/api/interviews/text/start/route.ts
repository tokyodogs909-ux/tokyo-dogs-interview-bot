import {
  authorizeInterviewRequest,
  markTextInterviewStarted,
} from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const sessionId = request.headers.get("X-Interview-Session")?.trim() ?? "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "オンライン一次面接の接続情報が正しくありません。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreJson({ error: "オンライン一次面接の有効期限または認証を確認してください。" }, { status: 401 });
    }
    if (!["created", "in_progress"].includes(authorized.session.status)) {
      return noStoreJson({ error: "このオンライン一次面接は開始できません。" }, { status: 409 });
    }
    if (!await markTextInterviewStarted(sessionId)) {
      return noStoreJson({ error: "文字入力によるオンライン一次面接を開始できませんでした。" }, { status: 409 });
    }
    return noStoreJson({ started: true, recordingRequired: false });
  } catch {
    return noStoreJson({ error: "文字入力によるオンライン一次面接を開始できませんでした。" }, { status: 500 });
  }
}
