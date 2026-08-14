import assert from "node:assert/strict";
import test from "node:test";

import { runStickyInterviewCompletionHold } from "../lib/interview-completion-hold.js";

test("a delayed stop receipt synchronously fences AI and timeout completion", async () => {
  let releaseReceipt;
  const delayedReceipt = new Promise((resolve) => {
    releaseReceipt = resolve;
  });
  let ending = false;
  let hold = "none";
  let pendingReason = "ai_completed";
  let eventCalls = 0;
  let finalized = 0;
  let successfulCompletions = 0;
  const pendingTimer = setTimeout(() => {
    if (!ending && hold === "none") successfulCompletions += 1;
  }, 0);

  const activate = () => {
    if (ending || hold !== "none") return false;
    ending = true;
    hold = "candidate_requested_stop";
    clearTimeout(pendingTimer);
    pendingReason = null;
    return true;
  };
  const report = async () => {
    eventCalls += 1;
    return await delayedReceipt;
  };
  const finalize = async (receipt) => {
    assert.equal(receipt, "stored");
    finalized += 1;
  };

  const holding = runStickyInterviewCompletionHold({ activate, report, finalize });
  assert.equal(ending, true, "the local ending fence must be visible before the first await");
  assert.equal(hold, "candidate_requested_stop");
  assert.equal(pendingReason, null);
  assert.equal(eventCalls, 1);
  assert.equal(finalized, 0);

  // These model the already-queued AI completion and a concurrent time-limit
  // completion while the candidate-event POST has not returned.
  for (const reason of ["ai_completed", "max_duration_reached"]) {
    if (!ending && hold === "none") {
      void reason;
      successfulCompletions += 1;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(successfulCompletions, 0);

  const duplicate = await runStickyInterviewCompletionHold({ activate, report, finalize });
  assert.deepEqual(duplicate, { entered: false });
  assert.equal(eventCalls, 1, "the exact candidate event is sent only once");

  releaseReceipt("stored");
  assert.deepEqual(await holding, { entered: true, receipt: "stored" });
  assert.equal(finalized, 1);
  assert.equal(ending, true, "the technical hold remains sticky after receipt processing");
  assert.equal(successfulCompletions, 0);
});

test("an ambiguous safety-event receipt still leaves the terminal hold active", async () => {
  let ending = false;
  let hold = "none";
  let finalizedReceipt = "unset";
  const result = await runStickyInterviewCompletionHold({
    activate: () => {
      ending = true;
      hold = "safety_escalation";
      return true;
    },
    report: async () => {
      throw new Error("response lost after possible server commit");
    },
    finalize: async (receipt) => {
      finalizedReceipt = receipt;
    },
  });

  assert.deepEqual(result, { entered: true, receipt: undefined });
  assert.equal(finalizedReceipt, undefined);
  assert.equal(ending, true);
  assert.equal(hold, "safety_escalation");
});
