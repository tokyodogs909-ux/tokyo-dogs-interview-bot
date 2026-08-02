import {
  buildRealtimeSessionConfig,
} from "@/lib/interview";
import {
  hasTrustedRequestOrigin,
  privacySafeIdentifier,
  readOpenAIError,
  requireOpenAIApiKey,
} from "@/lib/openai-server";
import {
  authorizeInterviewRequest,
  markInterviewStarted,
  reserveInterviewRealtimeConnection,
} from "@/lib/interview-persistence";

function noStoreText(body: string, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    },
  });
}

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreText("TD-CONN-ORIGIN: リクエスト元を確認できません。", 403);
    }
    const sessionId = request.headers.get("X-Interview-Session")?.trim() ?? "";
    if (!/^TD-[A-Z0-9-]{6,40}$/.test(sessionId)) {
      return noStoreText("TD-CONN-SESSION: オンライン一次面接の接続情報が正しくありません。", 400);
    }
    const authorized = await authorizeInterviewRequest(request, sessionId);
    if (!authorized?.session) {
      return noStoreText("TD-CONN-AUTH: オンライン一次面接リンクの接続情報を確認できません。", 401);
    }
    if (!["created", "in_progress"].includes(authorized.session.status)) {
      return noStoreText("TD-CONN-STATUS: このオンライン一次面接は再開できません。", 409);
    }
    const contentType = request.headers.get("Content-Type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/sdp")) {
      return noStoreText("TD-CONN-SDP: 音声通話の準備情報が正しくありません。", 415);
    }
    const sdp = await request.text();
    if (!sdp || sdp.length > 120_000) {
      return noStoreText("TD-CONN-SDP: 音声通話の準備情報を確認できません。", 400);
    }
    if (!await reserveInterviewRealtimeConnection(sessionId)) {
      return noStoreText("TD-CONN-LIMIT: 音声回線への再接続回数が上限に達しました。採用担当者へご連絡ください。", 429);
    }

    const apiKey = requireOpenAIApiKey();
    const formData = new FormData();
    formData.set("sdp", sdp);
    formData.set("session", JSON.stringify(buildRealtimeSessionConfig({
      employment: authorized.session.employment,
      location: authorized.session.preferred_location,
    })));
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Safety-Identifier": await privacySafeIdentifier(sessionId),
      },
      body: formData,
    });
    if (!response.ok) {
      return noStoreText(`TD-CONN-VOICE: ${await readOpenAIError(response)}`, response.status === 429 ? 429 : 502);
    }
    const answer = await response.text();
    if (!answer) {
      return noStoreText("TD-CONN-VOICE: 音声通話の応答を取得できませんでした。", 502);
    }
    await markInterviewStarted(sessionId);
    return noStoreText(answer, 200, "application/sdp");
  } catch (error) {
    const missingCredential = error instanceof Error && error.message.includes("OPENAI_API_KEY");
    return noStoreText(
      missingCredential
        ? "TD-CONN-CONFIG: オンライン一次面接の利用設定を確認できません。"
        : "TD-CONN-SERVER: オンライン一次面接サーバーへ接続できませんでした。",
      missingCredential ? 503 : 500,
    );
  }
}
