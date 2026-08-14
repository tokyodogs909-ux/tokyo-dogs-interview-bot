/**
 * @typedef {"stored" | "unconfirmed"} CandidateEventReceiptState
 */

function exactStoredReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "stored" && value.stored === true;
}

/**
 * Sends a candidate event at most once for the exact session/type/code tuple.
 * An ambiguous response is deliberately not retried: the server may have
 * committed it even when the response was lost, so a blind retry would make
 * the browser's UI claim more certainty than the durable receipt proves.
 *
 * @param {{
 *   sessionId: string;
 *   accessToken: string;
 *   eventType: string;
 *   code?: string;
 *   attemptedKeys: Set<string>;
 *   storedKeys: Set<string>;
 *   fetchImpl?: typeof fetch;
 * }} input
 * @returns {Promise<{ state: CandidateEventReceiptState; attempted: boolean }>}
 */
export async function reportCandidateEventOnce(input) {
  const code = input.code ?? "";
  const key = `${input.sessionId}:${input.eventType}:${code}`;
  if (input.storedKeys.has(key)) return { state: "stored", attempted: false };
  if (input.attemptedKeys.has(key)) return { state: "unconfirmed", attempted: false };
  if (!input.sessionId || !input.accessToken) return { state: "unconfirmed", attempted: false };

  input.attemptedKeys.add(key);
  try {
    const response = await (input.fetchImpl ?? fetch)("/api/interviews/event", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: input.sessionId,
        eventType: input.eventType,
        code,
      }),
      keepalive: true,
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 200 && exactStoredReceipt(payload)) {
      input.storedKeys.add(key);
      return { state: "stored", attempted: true };
    }
  } catch {
    // Ambiguous transport failures are a terminal local state for this exact
    // body. The candidate sees a technical hold and staff can inspect D1.
  }
  return { state: "unconfirmed", attempted: true };
}

