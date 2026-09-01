import {
  clearInterviewContinuityCookie,
  parseInterviewContinuityCookie,
  serializeInterviewContinuityCookie,
} from "@/lib/interview-continuity";
import {
  authorizeInterviewToken,
  getInterviewContinuitySnapshot,
  replaceInterruptedInterviewWithText,
} from "@/lib/interview-persistence";
import { readBoundedJsonBody } from "@/lib/http-body";
import { hasTrustedRequestOrigin, noStoreJson } from "@/lib/openai-server";

function continuityCookie(request: Request) {
  return parseInterviewContinuityCookie(request.headers.get("cookie"));
}

function responseWithContinuity(
  payload: Record<string, unknown>,
  credentials: { sessionId: string; accessToken: string; expiresAt: string },
) {
  const response = noStoreJson(payload);
  response.headers.append("Set-Cookie", serializeInterviewContinuityCookie({
    sessionId: credentials.sessionId,
    accessToken: credentials.accessToken,
    maxAgeSeconds: Math.max(1, Math.floor((Date.parse(credentials.expiresAt) - Date.now()) / 1_000)),
  }));
  return response;
}

function unavailableResponse(status = 401) {
  const response = noStoreJson({ available: false }, { status });
  response.headers.append("Set-Cookie", clearInterviewContinuityCookie());
  return response;
}

export async function GET(request: Request) {
  try {
    const credentials = continuityCookie(request);
    if (!credentials) return noStoreJson({ available: false });
    const authorized = await authorizeInterviewToken(credentials.sessionId, credentials.accessToken);
    if (!authorized?.session) return unavailableResponse();
    const snapshot = await getInterviewContinuitySnapshot(credentials.sessionId);
    if (!snapshot) return unavailableResponse(404);
    return responseWithContinuity({
      available: true,
      accessToken: credentials.accessToken,
      snapshot,
    }, {
      sessionId: snapshot.sessionId,
      accessToken: credentials.accessToken,
      expiresAt: snapshot.expiresAt,
    });
  } catch {
    return noStoreJson({ available: false, error: "面接の途中保存状態を確認できませんでした。" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    if (!hasTrustedRequestOrigin(request)) {
      return noStoreJson({ error: "リクエスト元を確認できません。" }, { status: 403 });
    }
    const credentials = continuityCookie(request);
    if (!credentials) return unavailableResponse();
    const authorized = await authorizeInterviewToken(credentials.sessionId, credentials.accessToken);
    if (!authorized?.session) return unavailableResponse();
    const bodyResult = request.body === null
      ? { ok: true as const, value: {} }
      : await readBoundedJsonBody<{
          expectedDraftSha256?: unknown;
          expectedDraftTurnCount?: unknown;
        }>(request, { maxBytes: 1_000, allowEmpty: true });
    if (!bodyResult.ok) {
      return noStoreJson({
        error: bodyResult.status === 413
          ? "途中保存の確認情報が長すぎます。"
          : "途中保存の確認情報を読み取れませんでした。",
      }, { status: bodyResult.status });
    }
    const body = bodyResult.value;
    const snapshot = await replaceInterruptedInterviewWithText(credentials.sessionId, {
      sha256: body?.expectedDraftSha256 === null || typeof body?.expectedDraftSha256 === "string"
        ? body.expectedDraftSha256
        : null,
      turnCount: Number(body?.expectedDraftTurnCount),
    });
    if (!snapshot) {
      return noStoreJson({ error: "この面接は文字入力へ切り替えられません。" }, { status: 409 });
    }
    return responseWithContinuity({
      resumed: true,
      accessToken: credentials.accessToken,
      snapshot,
    }, {
      sessionId: snapshot.sessionId,
      accessToken: credentials.accessToken,
      expiresAt: snapshot.expiresAt,
    });
  } catch (error) {
    const conflict = error instanceof Error && [
      "INTERVIEW_CONTINUITY_NOT_REPLACEABLE",
      "INTERVIEW_CONTINUITY_READBACK_MISMATCH",
    ].includes(error.message);
    return noStoreJson({
      error: conflict
        ? "保存済みの状態を確認したため、自動切替を停止しました。採用担当者へ受付番号をお伝えください。"
        : "面接を文字入力へ安全に切り替えられませんでした。",
    }, { status: conflict ? 409 : 503 });
  }
}
