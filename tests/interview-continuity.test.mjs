import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERVIEW_CONTINUITY_COOKIE,
  clearInterviewContinuityCookie,
  parseInterviewContinuityCookie,
  serializeInterviewContinuityCookie,
} from "../lib/interview-continuity.js";

const sessionId = "TD-ABC12345-XYZ7890";
const accessToken = "A".repeat(43);

test("continuity cookie is host-only, HttpOnly, strict, secure, and round-trips", () => {
  const serialized = serializeInterviewContinuityCookie({
    sessionId,
    accessToken,
    maxAgeSeconds: 7_200,
  });
  assert.match(serialized, new RegExp(`^${INTERVIEW_CONTINUITY_COOKIE}=`));
  assert.match(serialized, /; Path=\//);
  assert.match(serialized, /; Max-Age=7200/);
  assert.match(serialized, /; HttpOnly/);
  assert.match(serialized, /; Secure/);
  assert.match(serialized, /; SameSite=Strict/);
  assert.doesNotMatch(serialized, /Domain=/i);
  assert.deepEqual(parseInterviewContinuityCookie(`other=1; ${serialized.split("; ")[0]}`), {
    sessionId,
    accessToken,
  });
});

test("continuity cookie rejects malformed or attacker-controlled credentials", () => {
  assert.equal(parseInterviewContinuityCookie(null), null);
  assert.equal(parseInterviewContinuityCookie(`${INTERVIEW_CONTINUITY_COOKIE}=v1.bad.${accessToken}`), null);
  assert.equal(parseInterviewContinuityCookie(`${INTERVIEW_CONTINUITY_COOKIE}=v1.${sessionId}.short`), null);
  assert.equal(parseInterviewContinuityCookie(`${INTERVIEW_CONTINUITY_COOKIE}=v2.${sessionId}.${accessToken}`), null);
  assert.throws(() => serializeInterviewContinuityCookie({
    sessionId: "TD-invalid",
    accessToken,
    maxAgeSeconds: 10,
  }), /INTERVIEW_CONTINUITY_COOKIE_INVALID/);
});

test("continuity cookie expiry clears the same host-only scope", () => {
  const cleared = clearInterviewContinuityCookie();
  assert.equal(cleared, `${INTERVIEW_CONTINUITY_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
});
