import { EMPLOYMENT_OPTIONS, LOCATION_OPTIONS } from "@/lib/interview";
import { createInterviewSession } from "@/lib/interview-persistence";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const rawBody = await request.text();
    if (rawBody.length > 4_000) {
      return noStoreJson({ error: "入力内容が長すぎます。" }, { status: 413 });
    }
    const payload = JSON.parse(rawBody) as {
      employment?: string;
      location?: string;
      consent?: boolean;
    };
    const employment = payload.employment?.trim() ?? "";
    const location = payload.location?.trim() ?? "";
    if (payload.consent !== true) {
      return noStoreJson({ error: "録音・録画と文字起こしへの同意が必要です。" }, { status: 400 });
    }
    if (!(EMPLOYMENT_OPTIONS as readonly string[]).includes(employment)) {
      return noStoreJson({ error: "雇用形態を確認してください。" }, { status: 400 });
    }
    if (!(LOCATION_OPTIONS as readonly string[]).includes(location)) {
      return noStoreJson({ error: "希望店舗を確認してください。" }, { status: 400 });
    }
    const session = await createInterviewSession({ employment, location });
    return noStoreJson(session, { status: 201 });
  } catch (error) {
    const unavailable = error instanceof Error && error.message === "INTERVIEW_DATABASE_UNAVAILABLE";
    return noStoreJson(
      { error: unavailable ? "オンライン一次面接記録の保存領域を準備できませんでした。" : "オンライン一次面接を開始できませんでした。" },
      { status: unavailable ? 503 : 500 },
    );
  }
}
