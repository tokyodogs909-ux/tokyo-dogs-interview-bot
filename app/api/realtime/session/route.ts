import {
  EMPLOYMENT_OPTIONS,
  LOCATION_OPTIONS,
  REALTIME_MODEL,
  buildRealtimeSessionConfig,
} from "@/lib/interview";
import {
  noStoreJson,
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
    const payload = (await request.json()) as {
      sessionId?: string;
      employment?: string;
      location?: string;
    };
    const sessionId = payload.sessionId?.trim() ?? "";
    const employment = payload.employment?.trim() ?? "";
    const location = payload.location?.trim() ?? "";

    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreJson({ error: "オンライン一次面接の接続情報が正しくありません。" }, { status: 400 });
    }
    if (!(EMPLOYMENT_OPTIONS as readonly string[]).includes(employment)) {
      return noStoreJson({ error: "雇用形態を確認してください。" }, { status: 400 });
    }
    if (!(LOCATION_OPTIONS as readonly string[]).includes(location)) {
      return noStoreJson({ error: "希望店舗を確認してください。" }, { status: 400 });
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized) {
      return noStoreJson(
        { error: "オンライン一次面接の有効期限または認証を確認してください。" },
        { status: 401 },
      );
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
