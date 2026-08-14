import assert from "node:assert/strict";
import test from "node:test";

import { reportCandidateEventOnce } from "../lib/candidate-event-receipt.js";

function input(fetchImpl) {
  return {
    sessionId: "TD-EVENT-RECEIPT",
    accessToken: "candidate-token",
    eventType: "safety_escalation",
    code: "MODEL_SAFETY_ESCALATION",
    attemptedKeys: new Set(),
    storedKeys: new Set(),
    fetchImpl,
  };
}

test("candidate event dedupes only after an exact stored receipt", async () => {
  let calls = 0;
  const request = input(async (_url, init) => {
    calls += 1;
    assert.deepEqual(JSON.parse(init.body), {
      sessionId: "TD-EVENT-RECEIPT",
      eventType: "safety_escalation",
      code: "MODEL_SAFETY_ESCALATION",
    });
    return Response.json({ stored: true });
  });
  assert.deepEqual(await reportCandidateEventOnce(request), { state: "stored", attempted: true });
  assert.deepEqual(await reportCandidateEventOnce(request), { state: "stored", attempted: false });
  assert.equal(calls, 1);
  assert.equal(request.storedKeys.size, 1);
});

test("ambiguous transport failure is held and never blindly resent", async () => {
  let calls = 0;
  const request = input(async () => {
    calls += 1;
    throw new TypeError("response lost after request");
  });
  assert.deepEqual(await reportCandidateEventOnce(request), { state: "unconfirmed", attempted: true });
  assert.deepEqual(await reportCandidateEventOnce(request), { state: "unconfirmed", attempted: false });
  assert.equal(calls, 1);
  assert.equal(request.storedKeys.size, 0);
});

test("non-2xx and non-exact JSON receipts remain unconfirmed without retry", async () => {
  for (const response of [
    Response.json({ stored: true }, { status: 503 }),
    Response.json({ stored: true, duplicate: false }),
    new Response("not-json", { status: 200 }),
  ]) {
    let calls = 0;
    const request = input(async () => {
      calls += 1;
      return response;
    });
    assert.equal((await reportCandidateEventOnce(request)).state, "unconfirmed");
    assert.equal((await reportCandidateEventOnce(request)).attempted, false);
    assert.equal(calls, 1);
    assert.equal(request.storedKeys.size, 0);
  }
});

