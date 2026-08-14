/**
 * Splits one answer-audio POST into two independently awaitable milestones.
 *
 * The registration promise resolves only after the server has receipted the
 * exact answer index and durable audio bytes. The completion promise can stay
 * pending while speech-to-text is retried from the already stored R2 object.
 * This distinction lets the client seal the exact answer count and upload the
 * full interview recording without racing an unregistered final answer.
 *
 * @template T
 * @param {{
 *   register: () => Promise<T>;
 *   afterRegistration: (receipt: T) => void;
 *   complete: (receipt: T) => Promise<void>;
 * }} input
 * @returns {{ registration: Promise<void>; completion: Promise<void> }}
 */
export function splitRecordedAnswerUpload(input) {
  const registeredReceipt = Promise.resolve()
    .then(input.register)
    .then((receipt) => {
      input.afterRegistration(receipt);
      return receipt;
    });
  return {
    registration: registeredReceipt.then(() => undefined),
    completion: registeredReceipt.then(input.complete),
  };
}

/**
 * A generic 409 from the answer endpoint is never proof of success. The client
 * may proceed only when the authenticated completion endpoint returns its exact
 * idempotent completed-session receipt.
 *
 * @param {number} status
 * @param {unknown} body
 */
export function isExactRecordedCompletionReplay(status, body) {
  if (status !== 200 || !body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = /** @type {Record<string, unknown>} */ (body);
  const keys = Object.keys(record).sort();
  return keys.length === 4 &&
    keys[0] === "alreadyCompleted" &&
    keys[1] === "automaticEvaluationDeferred" &&
    keys[2] === "humanReviewRequired" &&
    keys[3] === "stored" &&
    record.stored === true &&
    record.humanReviewRequired === true &&
    record.alreadyCompleted === true &&
    typeof record.automaticEvaluationDeferred === "boolean";
}
