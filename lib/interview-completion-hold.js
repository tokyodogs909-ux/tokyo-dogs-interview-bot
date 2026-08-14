/**
 * Enters a terminal interview hold synchronously, before waiting for the
 * candidate-event receipt. Concurrent completion signals therefore observe
 * the sticky local fence even while the one event request is still in flight.
 *
 * @template TReceipt
 * @param {{
 *   activate: () => boolean;
 *   report?: () => Promise<TReceipt>;
 *   finalize: (receipt: TReceipt | undefined) => Promise<void>;
 * }} input
 * @returns {Promise<{ entered: boolean; receipt?: TReceipt }>}
 */
export async function runStickyInterviewCompletionHold(input) {
  if (!input.activate()) return { entered: false };
  let receipt;
  if (input.report) {
    try {
      receipt = await input.report();
    } catch {
      // The hold is already active. A lost event receipt must never reopen the
      // normal completion path or cause an automatic resend.
    }
  }
  await input.finalize(receipt);
  return { entered: true, receipt };
}
