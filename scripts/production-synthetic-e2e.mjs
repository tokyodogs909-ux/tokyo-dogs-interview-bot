import { readFile } from "node:fs/promises";

const baseUrl = (process.env.INTERVIEW_E2E_BASE_URL ?? "").replace(/\/$/, "");
const recordingPath = process.env.INTERVIEW_E2E_RECORDING_PATH ?? "";

if (!/^https:\/\//.test(baseUrl)) throw new Error("INTERVIEW_E2E_BASE_URL must be an https URL");
if (!recordingPath) throw new Error("INTERVIEW_E2E_RECORDING_PATH is required");

const startedAt = Date.now();
const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const candidateName = `社内試運転 ${runId}`;
const employment = "正社員";
const location = "試運転店舗（実応募ではありません）";
const origin = new URL(baseUrl).origin;
const results = [];

function record(step, response, details = {}) {
  results.push({ step, status: response.status, ok: response.ok, ...details });
}

function fail(message, details = {}) {
  process.stdout.write(`${JSON.stringify({
    testData: "synthetic",
    candidateName,
    elapsedMs: Date.now() - startedAt,
    results,
    failure: { message, ...details },
  }, null, 2)}\n`);
  throw new Error(message);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function candidateTurn(id, text, offsetSeconds) {
  return { id, speaker: "candidate", text, createdAt: new Date(startedAt + offsetSeconds * 1000).toISOString() };
}

function interviewerTurn(id, text, offsetSeconds) {
  return { id, speaker: "interviewer", text, createdAt: new Date(startedAt + offsetSeconds * 1000).toISOString() };
}

const transcript = [
  interviewerTurn("q01", "まず自己紹介と、これまでのご経験を教えてください。", 1),
  candidateTurn("a01", "社内試運転用の架空応募者です。接客業で三年間、お客様の要望確認と新人教育を担当した想定で回答します。", 5),
  interviewerTurn("q02", "転職を考えた理由を教えてください。", 10),
  candidateTurn("a02", "前職への不満だけではなく、犬と飼い主様の継続的な成長支援に責任を持つ仕事へ挑戦したいと考えたためです。引継ぎを終えてから退職する想定です。", 15),
  interviewerTurn("q03", "TOKYO DOGSを志望した理由は何ですか。", 20),
  candidateTurn("a03", "犬だけでなく飼い主様にも学びを届ける方針と、店舗で連携してサービス品質を高める考え方に共感したためです。見学時には教育手順も確認したいです。", 25),
  interviewerTurn("q04", "会社選びで重視することと、当社の志望度を教えてください。", 30),
  candidateTurn("a04", "理念と日々の行動が一致していること、学習支援、チームで改善できることを重視します。第一志望の想定ですが、仕事内容と勤務条件を相互確認して決めたいです。", 35),
  interviewerTurn("q05", "仕事で失敗した経験と、その後の改善を教えてください。", 40),
  candidateTurn("a05", "予約変更の共有が遅れた経験があります。すぐ謝罪し、原因を記録して、口頭連絡だけでなくチェック表へ担当者と期限を残す方法へ変え、再発を防いだ想定です。", 45),
  interviewerTurn("q06", "新しい知識を学ぶとき、どのように進めますか。", 50),
  candidateTurn("a06", "最初に手本を見て要点をメモし、自分で実践し、先輩から具体的なフィードバックを受け、翌日に同じ手順を再現できるか確認します。", 55),
  interviewerTurn("q07", "忙しい時間帯に複数の依頼が重なった場合はどうしますか。", 60),
  candidateTurn("a07", "犬と人の安全、時間制約、お客様への影響で優先順位を決めます。一人で抱えず、現在地と応援が必要な内容を短く共有します。", 65),
  interviewerTurn("q08", "接客で大切にしていることを教えてください。", 70),
  candidateTurn("a08", "先に結論を決めつけず、ご要望と困りごとを復唱して認識を合わせ、専門用語を避けて選択肢と理由を説明することです。", 75),
  interviewerTurn("q09", "説明に納得されていない飼い主様への対応を実演してください。", 80),
  candidateTurn("a09", "ご不安な点を教えていただけますか。私の説明で分かりにくかったところを確認し、犬の安全を第一に、今日できる方法と別の方法を順にご説明します。判断を急がせず質問を受けます。", 85),
  interviewerTurn("q10", "勤務可能日、土日、早番や遅番について教えてください。", 90),
  candidateTurn("a10", "週五日勤務を想定し、土日勤務は可能です。早番と遅番も事前のシフトで対応できます。個別事情が出た場合は早めに相談します。", 95),
  interviewerTurn("q11", "運転免許、送迎、当直への対応を教えてください。", 100),
  candidateTurn("a11", "普通自動車免許を保有している想定です。送迎は安全手順と同乗研修後に対応できます。当直は頻度と勤務間隔を確認したうえで相談可能です。", 105),
  interviewerTurn("q12", "希望店舗と通勤について教えてください。", 110),
  candidateTurn("a12", "試運転店舗を希望する想定で、通勤は片道四十五分以内です。配属条件を確認し、無理のない継続勤務ができるか判断します。", 115),
  interviewerTurn("q13", "希望店舗以外への配属や、他店舗ヘルプが発生する可能性があります。理解と対応条件を教えてください。", 120),
  candidateTurn("a13", "可能性を理解しました。近隣店舗で月数回、事前に分かる場合は対応できます。急な変更は移動時間と終業時刻を確認して相談します。", 125),
  interviewerTurn("q14", "犬への接し方と、安全上やらないことを教えてください。", 130),
  candidateTurn("a14", "犬の様子と環境を観察し、無理に距離を詰めません。判断できない行動を自己流で続けず、記録して先輩へ相談します。事故につながる省略はしません。", 135),
  interviewerTurn("q15", "職場体験と今後の選考、入社可能時期について教えてください。", 140),
  candidateTurn("a15", "職場体験に参加可能です。業務内容とチーム連携を確認したいです。次の選考案内を確認し、入社は内定後一か月を想定します。", 145),
  interviewerTurn("q16", "最後に確認したいことはありますか。", 150),
  candidateTurn("a16", "入社後三か月の教育目標、困ったときの相談経路、店舗間ヘルプの平均頻度を確認したいです。以上はすべて社内試運転用の合成回答です。", 155),
];

const commonHeaders = { Origin: origin };
const preflight = await fetch(`${baseUrl}/api/interviews/invite`, { headers: commonHeaders });
const preflightBody = await safeJson(preflight);
record("common_entry_preflight", preflight, {
  inviteRequired: preflightBody.inviteRequired,
  accepted: preflightBody.status === "ok",
});
if (!preflight.ok || preflightBody.status !== "ok") fail("Common entry preflight failed", { error: preflightBody.error });

const sessionResponse = await fetch(`${baseUrl}/api/interviews/session`, {
  method: "POST",
  headers: { ...commonHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ candidateName, employment, location, consent: true }),
});
const session = await safeJson(sessionResponse);
record("candidate_session", sessionResponse, { sessionId: session.sessionId });
if (!sessionResponse.ok || !session.sessionId || !session.accessToken) fail("Candidate session failed", { error: session.error });

const authorizedHeaders = {
  ...commonHeaders,
  Authorization: `Bearer ${session.accessToken}`,
};
const syntheticOffer = [
  "v=0",
  "o=- 1785629300 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1",
  "a=msid-semantic: WMS synthetic",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=sendrecv",
  "a=rtcp-mux",
  "a=ice-ufrag:syntheticProbe",
  "a=ice-pwd:syntheticProbePassword123456",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00",
  "a=setup:actpass",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=ssrc:1001 cname:synthetic",
  "a=msid:synthetic audio",
  "a=ssrc:1001 msid:synthetic audio",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=mid:1",
  "a=sctp-port:5000",
  "a=ice-ufrag:syntheticProbe",
  "a=ice-pwd:syntheticProbePassword123456",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00",
  "a=setup:actpass",
  "",
].join("\r\n");
const realtimeResponse = await fetch(`${baseUrl}/api/realtime/call`, {
  method: "POST",
  headers: {
    ...authorizedHeaders,
    "Content-Type": "application/sdp",
    "X-Interview-Session": session.sessionId,
  },
  body: syntheticOffer,
});
const realtimeAnswer = await realtimeResponse.text();
record("realtime_webrtc_call", realtimeResponse, {
  sdpAnswerReceived: realtimeResponse.ok && realtimeAnswer.startsWith("v=0"),
  answerBytes: realtimeAnswer.length,
  error: realtimeResponse.ok ? undefined : realtimeAnswer.slice(0, 300),
});
if (!realtimeResponse.ok || !realtimeAnswer.startsWith("v=0")) {
  fail("Realtime WebRTC call failed", { sessionId: session.sessionId });
}

const eventResponse = await fetch(`${baseUrl}/api/interviews/event`, {
  method: "POST",
  headers: { ...authorizedHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({
    sessionId: session.sessionId,
    eventType: "connection_failed",
    code: "SYNTHETIC_RECOVERY_PROBE",
  }),
});
record("technical_event_audit", eventResponse);
if (!eventResponse.ok) fail("Technical event audit failed", { sessionId: session.sessionId });

const recording = await readFile(recordingPath);
const recordingResponse = await fetch(`${baseUrl}/api/interviews/recording`, {
  method: "POST",
  headers: {
    ...authorizedHeaders,
    "X-Interview-Session": session.sessionId,
    "Content-Type": "video/webm",
    "Content-Length": String(recording.byteLength),
  },
  body: recording,
});
record("recording_upload", recordingResponse, { bytes: recording.byteLength });
if (!recordingResponse.ok) fail("Recording upload failed", { sessionId: session.sessionId });

const evaluationResponse = await fetch(`${baseUrl}/api/evaluate`, {
  method: "POST",
  headers: { ...authorizedHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: session.sessionId, employment, location, transcript }),
});
const evaluation = await safeJson(evaluationResponse);
record("transcript_and_evaluation", evaluationResponse, {
  stored: evaluation.stored === true,
  humanReviewRequired: evaluation.humanReviewRequired === true,
});
if (!evaluationResponse.ok || evaluation.stored !== true) {
  fail("Evaluation failed", { sessionId: session.sessionId, error: evaluation.error });
}

const archiveStartedAt = Date.now();
const archiveResponse = await fetch(`${baseUrl}/api/interviews/archive`, {
  method: "POST",
  headers: { ...authorizedHeaders, "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: session.sessionId }),
});
const archive = await safeJson(archiveResponse);
record("foreground_drive_archive", archiveResponse, {
  elapsedMs: Date.now() - archiveStartedAt,
  stored: archive.stored === true,
  recordingIncluded: archive.recordingIncluded === true,
});
if (!archiveResponse.ok || archive.stored !== true || archive.recordingIncluded !== true) {
  fail("Foreground Drive archive failed", { sessionId: session.sessionId, error: archive.error });
}

process.stdout.write(`${JSON.stringify({
  testData: "synthetic",
  candidateName,
  sessionId: session.sessionId,
  elapsedMs: Date.now() - startedAt,
  results,
  driveReadbackRequired: true,
}, null, 2)}\n`);
