function copyTranscriptSnapshot(transcript) {
  if (!Array.isArray(transcript) || transcript.length < 1 || transcript.length > 300) {
    throw new Error("TRANSCRIPT_DRAFT_INVALID");
  }
  return transcript.map((turn) => ({
    id: String(turn.id),
    speaker: turn.speaker,
    text: String(turn.text),
    createdAt: String(turn.createdAt ?? ""),
  }));
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readExactReceipt(response, expected) {
  const payload = await response.json().catch(() => null);
  if (
    !response.ok ||
    !payload ||
    payload[expected.kind] !== true ||
    payload.turnCount !== expected.turnCount ||
    payload.sha256 !== expected.sha256
  ) {
    throw new Error(payload?.error || "TRANSCRIPT_DRAFT_RECEIPT_MISMATCH");
  }
  return payload;
}

/**
 * Serializes completed-turn snapshots through one candidate session. A failed
 * request does not poison later snapshots: the server itself accepts a later
 * snapshot only when its durable current row is an exact prefix, CAS-fenced by
 * that row's digest.
 */
export function createTranscriptDraftWriter(input) {
  if (!input || !input.sessionId || !input.accessToken || !["voice", "text"].includes(input.mode)) {
    throw new Error("TRANSCRIPT_DRAFT_CONFIGURATION_INVALID");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let chain = Promise.resolve(null);
  let lastAcknowledgedJson = "";
  let lastReceipt = null;

  function persist(transcript) {
    const snapshot = copyTranscriptSnapshot(transcript);
    const transcriptJson = JSON.stringify(snapshot);
    const task = chain.catch(() => null).then(async () => {
      if (lastAcknowledgedJson === transcriptJson && lastReceipt) return lastReceipt;
      const digest = await sha256Text(transcriptJson);
      const response = await fetchImpl("/api/interviews/transcript/draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.accessToken}`,
        },
        body: JSON.stringify({
          sessionId: input.sessionId,
          mode: input.mode,
          transcript: snapshot,
        }),
      });
      const receipt = await readExactReceipt(response, {
        kind: "stored",
        turnCount: snapshot.length,
        sha256: digest,
      });
      lastAcknowledgedJson = transcriptJson;
      lastReceipt = receipt;
      return receipt;
    });
    chain = task;
    return task;
  }

  async function seal(transcript) {
    const snapshot = copyTranscriptSnapshot(transcript);
    const transcriptJson = JSON.stringify(snapshot);
    const digest = await sha256Text(transcriptJson);
    await persist(snapshot);
    const response = await fetchImpl("/api/interviews/transcript/draft/seal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: input.sessionId,
        mode: input.mode,
        transcript: snapshot,
      }),
    });
    return await readExactReceipt(response, {
      kind: "sealed",
      turnCount: snapshot.length,
      sha256: digest,
    });
  }

  return {
    enqueue: persist,
    flush: persist,
    seal,
  };
}
