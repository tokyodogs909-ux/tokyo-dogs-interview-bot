import {
  EMPLOYMENT_OPTIONS,
  REALTIME_MODEL,
  buildRealtimeSessionConfig,
  isValidPreferredLocation,
  normalizePreferredLocation,
} from "@/lib/interview";
import {
  noStoreJson,
  hasTrustedRequestOrigin,
  privacySafeIdentifier,
  readOpenAIError,
  requireOpenAIApiKey,
} from "@/lib/openai-server";
import {
  authorizeInterviewRequest,
  markInterviewStarted,
} from "@/lib/interview-persistence";

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
      sessionId?: string;
      employment?: string;
      location?: string;
    };
    const sessionId = payload.sessionId?.trim() ?? "";
    const employment = payload.employment?.trim() ?? "";
    const location = normalizePreferredLocation(payload.location);

    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "オンライン一次面接の接続情報が正しくありません。" }, { status: 400 });
    }
    if (!(EMPLOYMENT_OPTIONS as readonly string[]).includes(employment)) {
      return noStoreJson({ error: "雇用形態を確認してください。" }, { status: 400 });
    }
    if (!isValidPreferredLocation(location)) {
      return noStoreJson({ error: "入職希望対象店舗を120文字以内で入力してください。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized) {
      return noStoreJson(
        { error: "オンライン一次面接の有効期限または認証を確認してください。" },
        { status: 401 },
      );
    }
    if (!["created", "in_progress"].includes(authorized.session.status)) {
      return noStoreJson({ error: "このオンライン一次面接は再開できません。採用担当者へご連絡ください。" }, { status: 409 });
    }
    if (
      authorized.session &&
      (authorized.session.employment !== employment ||
        authorized.session.preferred_location !== location)
    ) {
      return noStoreJson({ error: "応募条件とオンライン一次面接の接続情報が一致しません。" }, { status: 409 });
    }

    const apiKey = requireOpenAIApiKey();
    const safetyIdentifier = await privacySafeIdentifier(sessionId);
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": safetyIdentifier,
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 600 },
        session: buildRealtimeSessionConfig({ employment, location }),
      }),
    });

    if (!response.ok) {
      return noStoreJson(
        { error: await readOpenAIError(response) },
        { status: response.status === 429 ? 429 : 502 },
      );
    }

    const data = (await response.json()) as {
      value?: string;
      expires_at?: number;
      session?: { model?: string };
    };
    if (!data.value) {
      return noStoreJson({ error: "オンライン一次面接の接続情報を取得できませんでした。" }, { status: 502 });
    }
    await markInterviewStarted(sessionId);

    return noStoreJson({
      value: data.value,
      expiresAt: data.expires_at,
      model: data.session?.model ?? REALTIME_MODEL,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message.includes("OPENAI_API_KEY") ? 503 : 500;
    return noStoreJson(
      { error: status === 503 ? "オンライン一次面接の接続設定が完了していません。" : "オンライン一次面接を開始できませんでした。" },
      { status },
    );
  }
}
