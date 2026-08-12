/**
 * Google Apps Script fallback scheduler for interview background recovery.
 *
 * Set INTERVIEW_RECOVERY_TOKEN in Script Properties. Never put the token in
 * this file. Run installInterviewRecoveryTrigger() once to converge the
 * project to exactly one one-minute trigger for runInterviewRecovery().
 */
const INTERVIEW_RECOVERY_HANDLER = "runInterviewRecovery";
const INTERVIEW_RECOVERY_TOKEN_PROPERTY = "INTERVIEW_RECOVERY_TOKEN";
const INTERVIEW_RECOVERY_URL =
  "https://recruit.tokyo-dogs.com/api/internal/recovery";
const INTERVIEW_RECOVERY_STATE_KEYS = [
  "completion",
  "drive",
  "evaluation",
  "recording",
  "transcription",
];
const INTERVIEW_RECOVERY_ALLOWED_STATES = [
  "idle",
  "advanced",
  "waiting",
  "attention",
];

function installInterviewRecoveryTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === INTERVIEW_RECOVERY_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger(INTERVIEW_RECOVERY_HANDLER)
    .timeBased()
    .everyMinutes(1)
    .create();
}

function runInterviewRecovery() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    const token = readInterviewRecoveryToken_();
    let response;
    try {
      response = UrlFetchApp.fetch(INTERVIEW_RECOVERY_URL, {
        method: "post",
        contentType: "application/json",
        payload: "{}",
        headers: { Authorization: "Bearer " + token },
        muteHttpExceptions: true,
        followRedirects: false,
      });
    } catch (_) {
      throw new Error("INTERVIEW_RECOVERY_REQUEST_FAILED");
    }

    const result = parseInterviewRecoveryResponse_(response);
    if (INTERVIEW_RECOVERY_STATE_KEYS.some(function (key) {
      return result.states[key] === "attention";
    })) {
      throw new Error("INTERVIEW_RECOVERY_ATTENTION");
    }
  } finally {
    lock.releaseLock();
  }
}

function readInterviewRecoveryToken_() {
  let token;
  try {
    token = PropertiesService.getScriptProperties()
      .getProperty(INTERVIEW_RECOVERY_TOKEN_PROPERTY);
  } catch (_) {
    throw new Error("INTERVIEW_RECOVERY_CONFIGURATION_FAILED");
  }
  token = typeof token === "string" ? token.trim() : "";
  if (
    token.length < 43 ||
    token.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new Error("INTERVIEW_RECOVERY_CONFIGURATION_FAILED");
  }
  return token;
}

function parseInterviewRecoveryResponse_(response) {
  if (!response || response.getResponseCode() !== 200) {
    throw new Error("INTERVIEW_RECOVERY_REQUEST_FAILED");
  }

  const headers = response.getHeaders();
  const contentType = Object.keys(headers).reduce(function (value, key) {
    return key.toLowerCase() === "content-type" ? String(headers[key]) : value;
  }, "");
  if (!/^application\/json;\s*charset=utf-8$/i.test(contentType)) {
    throw new Error("INTERVIEW_RECOVERY_RESPONSE_INVALID");
  }

  const body = response.getContentText("UTF-8");
  if (body.length === 0 || body.length > 4096) {
    throw new Error("INTERVIEW_RECOVERY_RESPONSE_INVALID");
  }
  let result;
  try {
    result = JSON.parse(body);
  } catch (_) {
    throw new Error("INTERVIEW_RECOVERY_RESPONSE_INVALID");
  }

  if (!isExactObjectWithKeys_(result, ["states", "tick"])) {
    throw new Error("INTERVIEW_RECOVERY_RESPONSE_INVALID");
  }
  if (
    result.tick !== "completed" ||
    !isExactObjectWithKeys_(result.states, INTERVIEW_RECOVERY_STATE_KEYS)
  ) {
    throw new Error("INTERVIEW_RECOVERY_RESPONSE_INVALID");
  }
  const statesAreValid = INTERVIEW_RECOVERY_STATE_KEYS.every(function (key) {
    return INTERVIEW_RECOVERY_ALLOWED_STATES.indexOf(result.states[key]) !== -1;
  });
  if (!statesAreValid) {
    throw new Error("INTERVIEW_RECOVERY_RESPONSE_INVALID");
  }
  return result;
}

function isExactObjectWithKeys_(value, expectedKeys) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(expectedKeys.slice().sort());
}
