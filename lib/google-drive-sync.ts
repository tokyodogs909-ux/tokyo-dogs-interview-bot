import {
  DRIVE_API_ENDPOINT,
  DRIVE_UPLOAD_ENDPOINT,
  fetchGoogleDriveAccessToken,
  missingGoogleDriveConfiguration,
  validateGoogleDriveRoot,
} from "@/lib/google-drive-auth";
import {
  decryptGoogleDriveUploadCapability,
  encryptGoogleDriveUploadCapability,
} from "@/lib/google-drive-connection";
import {
  adoptFinalizingDriveUploadStep,
  acquireDriveHierarchyNodeLease,
  acquireDriveUploadStepLease,
  claimExternalSync,
  claimExternalSyncIntegrityCheck,
  completeExternalSync,
  consumeMissingRecordingRepairAuthorization,
  createMissingRecordingRepairAuthorization,
  deferExternalSync,
  deleteDriveUploadStep,
  failExternalSync,
  finishExternalSyncIntegrityCheck,
  getDriveUploadStep,
  getExternalSyncStatus,
  getInterviewArchiveSource,
  getInterviewRecordingChunk,
  hasDurableMissingRecordingRepairAuthorization,
  heartbeatExternalSync,
  initializeDriveUploadStep,
  markDriveHierarchyNodeCreationAttempt,
  releaseDriveUploadStepLease,
  releaseDriveHierarchyNodeLease,
  renewDriveHierarchyNodeLease,
  renewDriveUploadStepLease,
  requestExternalSync,
  setDriveHierarchyNodeCanonicalFolder,
  updateDriveUploadStepContext,
  updateDriveUploadStep,
  type AuthorizedReviewer,
} from "@/lib/interview-persistence";
import { recordingReplacementBlockCode } from "@/lib/drive-recovery.js";
import { hasVerifiedCandidateTranscript } from "@/lib/interview-transcript-verification";
import {
  TECHNICAL_EVIDENCE_TRANSCRIPT_KIND,
  technicalEvidenceArchiveReason,
  technicalEvidenceArchiveTranscript,
} from "@/lib/interview-technical-evidence";
import {
  INTERVIEW_REPORT_PRESENTATION_VERSION,
  buildCandidateReviewOutline,
  buildCandidateValueHighlights,
  buildInterviewQuestionAnswers,
} from "@/lib/interview-review-summary.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const DRIVE_PROVIDER = "google_drive";
const TRANSIENT_DRIVE_RETRY_DELAY_MS = 600;
// Google Drive resumable uploads require every non-final chunk to be a
// multiple of 256 KiB. Keeping each request bounded avoids the two-minute
// upstream timeout observed when a 71 MB R2 stream was sent in one PUT.
const DRIVE_RECORDING_CHUNK_BYTES = 4 * 1024 * 1024;
const DRIVE_RECORDING_CHUNK_ATTEMPTS = 4;
const DRIVE_RECORDING_REQUEST_TIMEOUT_MS = 25_000;
// Drive normally supplies a whole-file checksum for binary uploads. If it
// does not, only a genuinely small duplicate is safe to prove by bounded
// range reads inside one Worker request. Large checksum-less recordings stay
// fail-closed instead of risking an unbounded download or partial comparison.
const DRIVE_DUPLICATE_RECORDING_FALLBACK_MAX_BYTES = 16 * 1024 * 1024;
const DRIVE_DUPLICATE_RECORDING_RANGE_BYTES = 4 * 1024 * 1024;
const DRIVE_INTEGRITY_SMALL_FILE_MAX_BYTES = 8 * 1024 * 1024;
const DRIVE_RECORDING_MISSING_CODE = "GOOGLE_DRIVE_ARCHIVE_RECORDING_MISSING";
const DRIVE_RECORDING_MOVED_CODE = "GOOGLE_DRIVE_ARCHIVE_RECORDING_MOVED_MANUAL_ATTENTION";
const DRIVE_RECORDING_TRASHED_CODE =
  "GOOGLE_DRIVE_ARCHIVE_RECORDING_TRASHED_RESTORE_REQUIRED";
const DRIVE_RECORDING_REPAIR_CONFIRMATION_REQUIRED =
  "GOOGLE_DRIVE_RECORDING_REPAIR_CONFIRMATION_REQUIRED";
// These folders are created and managed by staff. The interview bot never
// classifies a candidate or creates/moves/deletes these folders; it only
// recognizes an already archived candidate folder after a human moves it.
const MANUAL_CLASSIFICATION_FOLDER_NAMES = new Set(["合格", "不合格"]);

type DrivePermission = {
  type?: string;
  role?: string;
  allowFileDiscovery?: boolean;
};

type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  md5Checksum?: string;
  sha1Checksum?: string;
  sha256Checksum?: string;
  version?: string;
  modifiedTime?: string;
  trashed?: boolean;
  webViewLink?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
  permissions?: DrivePermission[];
};

type DriveFilePage = {
  files?: DriveFile[];
  nextPageToken?: string;
};

type ArchiveSource = NonNullable<Awaited<ReturnType<typeof getInterviewArchiveSource>>>;

type RecordingDuplicateProof = {
  canonicalId: string;
  duplicateId: string;
  byteSize: number;
  fingerprintAlgorithm: "sha256Checksum" | "bounded-range-sha256";
  fingerprint: string;
};

type PreparedDriveArchive = {
  rootFolderId: string;
  expectedParentId: string;
  candidateFolder: DriveFile;
  folderUrl: string;
  uploaded: GoogleDriveSyncResult["uploaded"];
  artifactTargetIds: Record<string, string | null | undefined>;
  transcriptDuplicateId: string | null;
  recordingDuplicateProof: RecordingDuplicateProof | null;
  transcriptAvailable: boolean;
  transcriptKind: string;
  expectedContentHashes: Partial<Record<DriveArtifactKey, string>>;
  expectedContentSizes: Partial<Record<DriveArtifactKey, number>>;
  sharingRisk: DriveSharingRisk;
  recordingRepairHistory?: Array<Record<string, unknown>>;
};

export type DriveArtifactKey =
  | "transcript"
  | "evaluation_json"
  | "report_doc"
  | "report_pdf"
  | "manifest"
  | "recording";

export type DriveSharingRisk = "anyone_writer" | "anyone_reader" | "restricted" | "unknown";

export type DriveArtifactIntegrityReceipt = {
  fileId: string;
  mimeType: string | null;
  size: number | null;
  version: string;
  modifiedTime: string;
  contentSha256: string;
  fingerprintSource:
    | "sha256Checksum"
    | "bounded-content-sha256"
    | "google-doc-text-sha256";
};

export type GoogleDriveArchiveIntegrity = {
  schemaVersion: "2026-08-14-v1";
  status: "verified" | "drift" | "unknown";
  checkedAt: string;
  errorCode: string | null;
  sharingRisk: DriveSharingRisk;
  folder: {
    fileId: string;
    parentId: string;
    version: string;
    modifiedTime: string;
  };
  artifacts: Partial<Record<DriveArtifactKey, DriveArtifactIntegrityReceipt>>;
};

export type GoogleDriveSyncResult = {
  status: "completed" | "pending";
  folderId: string;
  folderUrl: string;
  uploaded: Record<string, { id: string; name: string; size: number | null }>;
  recordingIncluded: boolean;
  transcriptAvailable: boolean;
  transcriptKind: string;
  reportPresentationVersion: string;
  integrity?: GoogleDriveArchiveIntegrity;
};

function safeErrorCode(error: unknown) {
  const code = error instanceof Error ? error.message : "GOOGLE_DRIVE_SYNC_FAILED";
  return /^[A-Z0-9_:-]{3,120}$/.test(code) ? code.slice(0, 120) : "GOOGLE_DRIVE_SYNC_FAILED";
}

function isTransientDriveError(error: unknown) {
  const code = safeErrorCode(error);
  return /^(?:GOOGLE_DRIVE_(?:API|EXPORT|RESUMABLE_INIT|RESUMABLE_UPLOAD)_)(?:429|500|502|503|504)$/.test(code) ||
    code === "GOOGLE_DRIVE_TOKEN_REFRESH_TRANSIENT" ||
    code === "GOOGLE_DRIVE_ROOT_LOOKUP_FAILED" ||
    // safeErrorCode() falls back to this generic code for any error whose message
    // isn't already one of our own UPPER_CASE codes above (e.g. `TypeError: fetch
    // failed` / DNS failures thrown by fetch() itself). Those raw network failures
    // are exactly the kind of transient condition this retry exists for; without
    // this, an ordinary network blip skips the retry and fails the whole sync.
    code === "GOOGLE_DRIVE_SYNC_FAILED";
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { ...init, signal: controller.signal }).catch((error) => {
    clearTimeout(timer);
    throw error;
  });
  if (!response.body) {
    clearTimeout(timer);
    return response;
  }
  const finish = () => clearTimeout(timer);
  const timedBody = new Proxy(response.body, {
    get(target, property) {
      if (property === "cancel") {
        return async (...args: Parameters<ReadableStream["cancel"]>) => {
          try { return await target.cancel(...args); } finally { finish(); }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(response, {
    get(target, property) {
      if (property === "body") return timedBody;
      if (["arrayBuffer", "blob", "formData", "json", "text"].includes(String(property))) {
        return async (...args: unknown[]) => {
          try {
            const method = Reflect.get(target, property, target) as (...methodArgs: unknown[]) => Promise<unknown>;
            return await method.apply(target, args);
          } finally {
            finish();
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function driveQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function safeFolderSegment(value: string) {
  const normalized = value.normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return normalized || "氏名未確認";
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function japaneseDate(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "未確認";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function speakerLabel(speaker: "candidate" | "interviewer") {
  return speaker === "candidate" ? "応募者" : "オンライン採用担当者 茂木";
}

/**
 * A Drive transcript is an actual interview record only when it contains at
 * least one substantive candidate utterance. The legacy recorded-fallback IDs
 * represented questions/placeholders rather than transcribed candidate audio,
 * so their presence invalidates the whole transcript receipt.
 */
function hasActualCandidateTranscript(source: ArchiveSource) {
  return hasVerifiedCandidateTranscript(source.transcript, source.auditEvents);
}

function isTechnicalEvidenceArchiveSource(source: ArchiveSource) {
  return technicalEvidenceArchiveTranscript(source) !== null;
}

function archiveTranscript(source: ArchiveSource) {
  return isTechnicalEvidenceArchiveSource(source)
    ? technicalEvidenceArchiveTranscript(source) ?? []
    : source.transcript;
}

function archiveTranscriptKind(source: ArchiveSource) {
  if (isTechnicalEvidenceArchiveSource(source)) return TECHNICAL_EVIDENCE_TRANSCRIPT_KIND;
  if (hasActualCandidateTranscript(source)) return "actual_transcript";
  return "recorded_fallback_placeholder";
}

function buildTranscriptText(source: ArchiveSource) {
  const transcript = archiveTranscript(source);
  const technicalEvidence = isTechnicalEvidenceArchiveSource(source);
  const technicalReason = technicalEvidenceArchiveReason(source);
  const isTextInterview = source.recordingStatus === "not_applicable";
  const isRecordedFallbackPlaceholder = transcript.some((turn) =>
    turn.id.startsWith("recorded-fallback-answer-"));
  const lines = [
    technicalEvidence
      ? technicalReason === "recording_missing"
        ? "TOKYO DOGS オンライン一次面接 技術保留記録（録画未受領・人手確認必須）"
        : "TOKYO DOGS オンライン一次面接 技術保留記録（一部文字起こし・人手確認必須）"
      : isRecordedFallbackPlaceholder
      ? "TOKYO DOGS 録画式一次面接 質問記録（文字起こし未実施）"
      : "TOKYO DOGS オンライン一次面接 文字起こし",
    `面接ID: ${source.sessionId}`,
    `応募者氏名: ${source.candidateName}`,
    `雇用形態: ${source.employment}`,
    `入職希望対象店舗: ${source.preferredLocation}`,
    technicalEvidence
      ? `技術保留日時: ${japaneseDate(source.updatedAt)}`
      : `面接完了日時: ${japaneseDate(source.completedAt)}`,
    technicalEvidence
      ? technicalReason === "recording_missing"
        ? "確認区分: 面接終了時の通信中断により録画を最後まで受領できず、面接は技術保留。以下はハッシュ照合済みの完全な文字起こし記録だが、録画との人手照合はできない"
        : "確認区分: 回答音声の一部文字起こし欠落により面接は未完了。以下は受領済みの途中記録であり、録画との人手照合が必要"
      : isRecordedFallbackPlaceholder
      ? "確認区分: 録画式予備面接の質問記録。応募者の発言本文は文字起こし未実施"
      : isTextInterview
      ? "確認区分: 応募者が文字入力した回答記録（録画なし）"
      : "確認区分: 応募者端末で生成された文字起こし（録画との照合が必要）",
    "",
  ];
  for (const turn of transcript) {
    lines.push(`[${japaneseDate(turn.createdAt)}] ${speakerLabel(turn.speaker)}`);
    lines.push(turn.text);
    lines.push("");
  }
  return lines.join("\n");
}

function scoreLabel(score: number | null) {
  return score === null ? "未確認" : `${score}/5`;
}

function buildReportHtml(source: ArchiveSource) {
  const technicalEvidence = isTechnicalEvidenceArchiveSource(source);
  const technicalReason = technicalEvidenceArchiveReason(source);
  const isTextInterview = source.recordingStatus === "not_applicable";
  const evaluation = source.evaluation;
  const questionAnswers = buildInterviewQuestionAnswers(archiveTranscript(source));
  const valueHighlights = buildCandidateValueHighlights(evaluation);
  const outline = buildCandidateReviewOutline(evaluation);
  const questionAnswerHtml = questionAnswers.length
    ? questionAnswers.map((item) => `<section class="qa">
      <h3>Q${item.number}. ${escapeHtml(item.question)}</h3>
      <p>${escapeHtml(item.answer)}</p>
    </section>`).join("")
    : "<p>質問と実回答の組み合わせを確認できません。未確定記録または録画を人が確認してください。</p>";
  const valueHighlightsHtml = valueHighlights.length
    ? `<div class="value-grid">${valueHighlights.map((item) => `<section><h3>${escapeHtml(item.label)}</h3><p>${escapeHtml(item.text)}</p>${item.evidenceCount > 0 ? `<small>回答根拠 ${item.evidenceCount}件</small>` : ""}</section>`).join("")}</div>`
    : "<p>回答根拠を伴う価値観・考え方の要約は未作成です。</p>";
  const dimensions = evaluation?.dimensions.map((dimension) => `
    <section>
      <h3>${escapeHtml(dimension.name)} — ${scoreLabel(dimension.score)}</h3>
      <p><strong>確信度:</strong> ${escapeHtml(dimension.confidence)}</p>
      <p>${escapeHtml(dimension.rationale)}</p>
      <ul>${dimension.evidence.length
        ? dimension.evidence.map((evidence) => `<li>「${escapeHtml(evidence.quote)}」 (${escapeHtml(evidence.turnId)}) — ${escapeHtml(evidence.relevance)}</li>`).join("")
        : "<li>照合できる回答根拠なし</li>"}</ul>
    </section>`).join("") ?? "<p>回答評価は未作成です。</p>";
  const humanReviews = isTextInterview
    ? "<p>文字入力方式のため、映像確認は対象外です。参加方法の違いは評価に使用しません。</p>"
    : source.humanReviews.length
    ? source.humanReviews.map((review) => `
      <section>
        <h3>採用担当者 ${escapeHtml(review.reviewerName)}</h3>
        <ul>${review.videoScores.map((score) => `<li><strong>${escapeHtml(score.name)}:</strong> ${scoreLabel(score.score)} ${score.note ? `— ${escapeHtml(score.note)}` : ""}</li>`).join("")}</ul>
        <p><strong>総合メモ:</strong> ${escapeHtml(review.overallNote || "記載なし")}</p>
      </section>`).join("")
    : "<p>採用担当者による映像確認は未登録です。</p>";
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>TOKYO DOGS オンライン一次面接レポート</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP","Yu Gothic",sans-serif;color:#12324b;line-height:1.65;margin:42px}h1{font-size:24px;border-bottom:3px solid #0c4168;padding-bottom:12px}h2{font-size:18px;margin-top:30px;background:#e8f4fb;padding:9px 12px}h3{font-size:15px;margin-bottom:5px;white-space:pre-line}table{border-collapse:collapse;width:100%}th,td{border:1px solid #b7c8d3;padding:8px;text-align:left;vertical-align:top}th{width:28%;background:#f4f8fa}section{break-inside:avoid}footer{margin-top:32px;font-size:11px;color:#526c7e}.notice{border:1px solid #8fb4ca;background:#f5fbff;padding:12px}.value-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.value-grid section,.qa{border:1px solid #c7d9e3;border-radius:8px;padding:10px 12px;margin:0 0 10px}.value-grid p,.qa p{margin:5px 0;white-space:pre-line}.value-grid small{color:#526c7e}.qa h3{color:#0c4168;margin-top:0}.candidate-summary{font-size:14px;font-weight:600}</style></head><body>
<h1>TOKYO DOGS オンライン一次面接レポート</h1>
<table>
<tr><th>面接ID</th><td>${escapeHtml(source.sessionId)}</td></tr>
<tr><th>応募者氏名</th><td>${escapeHtml(source.candidateName)}</td></tr>
<tr><th>雇用形態</th><td>${escapeHtml(source.employment)}</td></tr>
<tr><th>入職希望対象店舗</th><td>${escapeHtml(source.preferredLocation)}</td></tr>
<tr><th>${technicalEvidence ? "技術保留日時" : "面接完了日時"}</th><td>${escapeHtml(japaneseDate(technicalEvidence ? source.updatedAt : source.completedAt))}</td></tr>
<tr><th>録画状態</th><td>${escapeHtml(source.recordingStatus)}</td></tr>
</table>
<p class="notice">${technicalEvidence
  ? technicalReason === "recording_missing"
    ? "本件は面接終了時の通信中断により録画を最後まで受領できなかった技術保留です。文字起こしはハッシュ照合済みの完全な記録ですが、録画との照合はできません。自動評価・合否判断・面接完了の証明には使用せず、通信不具合を応募者の不利益に使用しないでください。"
    : "本件は回答音声の一部文字起こしを確認できず、面接未完了の技術保留です。録画と途中文字起こしを採用担当者が人手で照合してください。自動評価・合否判断・面接完了の証明には使用できません。通信・録音・文字起こしの不具合を応募者の不利益に使用しません。"
  : isTextInterview
  ? "本資料は採用担当者の確認資料です。システムは合否を自動決定しません。文字入力方式では映像・音声を取得せず、参加方法の違いを不利益な評価に使用しません。"
  : "本資料は採用担当者の確認資料です。システムは合否を自動決定しません。文字起こしは応募者端末由来のため録画との照合が必要です。通信・録音・文字起こしの不具合や、顔立ち・容姿・表情・声質等を不利益な評価に使用しません。"}</p>
<h2>受験者の要点</h2>
<p class="candidate-summary">${escapeHtml(outline.summary)}</p>
<h3>価値観・考え方</h3>
${valueHighlightsHtml}
<p><strong>強み:</strong> ${escapeHtml(outline.strengths.join(" / ") || "未確認")}</p>
<p><strong>希望条件:</strong> ${escapeHtml(outline.conditions.join(" / ") || "未確認")}</p>
<p><strong>追加確認:</strong> ${escapeHtml(outline.missingTopics.join(" / ") || "なし")}</p>
<p><strong>懸念・要確認:</strong> ${escapeHtml(outline.concerns.join(" / ") || "なし")}</p>
<h2>質問事項からの返答（${questionAnswers.length}組）</h2>
<p>面接順の質問・確認と応募者回答を、発言を言い換えずに整理しています。</p>
${questionAnswerHtml}
<h2>回答評価</h2>
<p>${escapeHtml(evaluation?.summary || "回答評価は未作成です。")}</p>
${evaluation?.evidenceValidationWarnings.length
    ? `<div class="notice"><strong>評価本文の要確認事項</strong><ul>${evaluation.evidenceValidationWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>`
    : ""}
${dimensions}
<h2>${isTextInterview ? "参加方法" : "映像確認"}</h2>
${humanReviews}
<h2>確認事項</h2>
<p><strong>強み:</strong> ${escapeHtml(evaluation?.strengths.join(" / ") || "未確認")}</p>
<p><strong>懸念:</strong> ${escapeHtml(evaluation?.concerns.join(" / ") || "未確認")}</p>
<p><strong>追加確認:</strong> ${escapeHtml(evaluation?.missingTopics.join(" / ") || "なし")}</p>
<p><strong>勤務条件:</strong> ${escapeHtml(evaluation?.conditions.join(" / ") || "未確認")}</p>
<footer>同意文面版 ${escapeHtml(source.consentVersion)} / 保存方針 ${escapeHtml(source.retentionPolicy)} / 作成 ${escapeHtml(japaneseDate(new Date().toISOString()))}</footer>
</body></html>`;
}

function buildResultJson(source: ArchiveSource) {
  const transcriptKind = archiveTranscriptKind(source);
  const questionAnswers = buildInterviewQuestionAnswers(archiveTranscript(source));
  return JSON.stringify({
    schemaVersion: "2026-08-23-v2",
    reportPresentationVersion: INTERVIEW_REPORT_PRESENTATION_VERSION,
    generatedAt: new Date().toISOString(),
    interview: {
      sessionId: source.sessionId,
      candidateName: source.candidateName,
      employment: source.employment,
      preferredLocation: source.preferredLocation,
      status: source.status,
      recordingStatus: source.recordingStatus,
      consentVersion: source.consentVersion,
      consentedAt: source.consentedAt,
      retentionPolicy: source.retentionPolicy,
      createdAt: source.createdAt,
      completedAt: source.completedAt,
    },
    evaluation: source.evaluation,
    candidateReviewOutline: buildCandidateReviewOutline(source.evaluation),
    candidateValueHighlights: buildCandidateValueHighlights(source.evaluation),
    questionAnswers,
    transcriptKind,
    technicalHold: transcriptKind === TECHNICAL_EVIDENCE_TRANSCRIPT_KIND,
    technicalHoldReason: technicalEvidenceArchiveReason(source),
    automaticEvaluationPerformed: source.evaluation !== null,
    humanReviews: source.humanReviews,
    technicalEvents: source.auditEvents.filter((event) => [
      "audio_playback_blocked",
      "transcription_failed",
      "recording_unavailable",
      "connection_failed",
      "candidate_requested_stop",
      "safety_escalation",
      "completion_reason_invalid",
      "time_limit_reached",
      "reasonable_accommodation_text_selected",
      "orphaned_sealed_voice_draft_recovered",
      "recording_recovery_part_missing",
      "recording_recovery_manual_attention",
    ].includes(event.type)),
    humanDecisionRequired: true,
  }, null, 2);
}

async function driveJson<T>(url: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetchWithTimeout(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  }, DRIVE_RECORDING_REQUEST_TIMEOUT_MS);
  if (!response.ok) throw new Error(`GOOGLE_DRIVE_API_${response.status}`);
  return await response.json() as T;
}

async function findChild(
  accessToken: string,
  parentId: string,
  query: string,
) {
  const params = new URLSearchParams({
    q: `'${driveQueryValue(parentId)}' in parents and trashed = false and ${query}`,
    pageSize: "10",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "files(id,name,mimeType,size,version,modifiedTime,webViewLink,parents,appProperties)",
  });
  const result = await driveJson<{ files?: DriveFile[] }>(`${DRIVE_API_ENDPOINT}/files?${params}`, accessToken);
  return result.files?.[0] ?? null;
}

async function listExactFolders(
  accessToken: string,
  parentId: string,
  propertyKey: string,
  propertyValue: string,
) {
  const propertyQuery = `mimeType = '${FOLDER_MIME_TYPE}' and appProperties has { key='${driveQueryValue(propertyKey)}' and value='${driveQueryValue(propertyValue)}' }`;
  const params = new URLSearchParams({
    q: `'${driveQueryValue(parentId)}' in parents and trashed = false and ${propertyQuery}`,
    pageSize: "100",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "nextPageToken,files(id,name,mimeType,version,modifiedTime,trashed,webViewLink,parents,appProperties)",
  });
  const result = await driveJson<DriveFilePage>(`${DRIVE_API_ENDPOINT}/files?${params}`, accessToken);
  if (result.nextPageToken) throw new Error("GOOGLE_DRIVE_HIERARCHY_DUPLICATE");
  return result.files ?? [];
}

async function getDriveFolderById(accessToken: string, folderId: string) {
  return await driveJson<DriveFile>(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=${encodeURIComponent("id,name,mimeType,version,modifiedTime,trashed,webViewLink,parents,appProperties")}`,
    accessToken,
  );
}

async function listExactNamedFolders(
  accessToken: string,
  parentId: string,
  name: string,
) {
  const params = new URLSearchParams({
    q: `'${driveQueryValue(parentId)}' in parents and trashed = false and mimeType = '${FOLDER_MIME_TYPE}' and name = '${driveQueryValue(name)}'`,
    pageSize: "3",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "nextPageToken,files(id,name,mimeType,version,modifiedTime,trashed,webViewLink,parents,appProperties)",
  });
  const result = await driveJson<DriveFilePage>(`${DRIVE_API_ENDPOINT}/files?${params}`, accessToken);
  if (result.nextPageToken || (result.files?.length ?? 0) > 1) {
    throw new Error("GOOGLE_DRIVE_CLASSIFICATION_FOLDER_DUPLICATE");
  }
  return result.files ?? [];
}

async function listGlobalRecordingCandidates(input: {
  accessToken: string;
  sessionId: string;
}) {
  const baseQueries = [
    `name contains '${driveQueryValue(input.sessionId)}' and mimeType contains 'video/'`,
    `appProperties has { key='tokyoDogsInterviewSession' and value='${driveQueryValue(input.sessionId)}' } and appProperties has { key='tokyoDogsArtifact' and value='recording' }`,
  ];
  const pages = await Promise.all(baseQueries.flatMap((baseQuery) =>
    [false, true].map(async (trashed) => {
      const params = new URLSearchParams({
        q: `${baseQuery} and trashed = ${trashed ? "true" : "false"}`,
        pageSize: "10",
        spaces: "drive",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        fields: "nextPageToken,files(id,name,mimeType,size,sha256Checksum,version,modifiedTime,trashed,parents,appProperties)",
      });
      const page = await driveJson<DriveFilePage>(
        `${DRIVE_API_ENDPOINT}/files?${params}`,
        input.accessToken,
      );
      if (page.nextPageToken) {
        throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
      }
      return page.files ?? [];
    })),
  );
  const unique = new Map<string, DriveFile>();
  for (const file of pages.flat()) {
    if (typeof file.id === "string" && file.id) unique.set(file.id, file);
  }
  return [...unique.values()];
}

/**
 * Verifies that a session folder is either directly under its canonical month
 * or exactly one level below the staff-managed 合格/不合格 folder. No Drive
 * mutation is performed here. Unexpected nesting and duplicate classification
 * folders stay fail-closed.
 */
async function verifyCandidateFolderLocation(input: {
  accessToken: string;
  folder: DriveFile;
  sessionId: string;
  canonicalMonthId?: string;
}) {
  if (
    input.folder.mimeType !== FOLDER_MIME_TYPE ||
    input.folder.trashed === true ||
    input.folder.parents?.length !== 1 ||
    input.folder.appProperties?.tokyoDogsInterviewSession !== input.sessionId
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  const currentParentId = input.folder.parents[0];
  if (input.canonicalMonthId && currentParentId === input.canonicalMonthId) {
    return { canonicalMonthId: input.canonicalMonthId, manuallyClassified: false };
  }

  const currentParent = await getDriveFolderById(input.accessToken, currentParentId);
  if (
    currentParent.mimeType === FOLDER_MIME_TYPE &&
    currentParent.trashed !== true &&
    currentParent.parents?.length === 1 &&
    typeof currentParent.name === "string" &&
    MANUAL_CLASSIFICATION_FOLDER_NAMES.has(currentParent.name)
  ) {
    const canonicalMonthId = currentParent.parents[0];
    if (input.canonicalMonthId && canonicalMonthId !== input.canonicalMonthId) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
    }
    const exactClassificationFolders = await listExactNamedFolders(
      input.accessToken,
      canonicalMonthId,
      currentParent.name,
    );
    if (
      exactClassificationFolders.length !== 1 ||
      exactClassificationFolders[0].id !== currentParent.id
    ) {
      throw new Error("GOOGLE_DRIVE_CLASSIFICATION_FOLDER_DUPLICATE");
    }
    return { canonicalMonthId, manuallyClassified: true };
  }

  if (input.canonicalMonthId) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  return { canonicalMonthId: currentParentId, manuallyClassified: false };
}

async function canonicalMonthFromStoredParent(
  accessToken: string,
  storedParentId: string,
) {
  const storedParent = await getDriveFolderById(accessToken, storedParentId);
  if (
    storedParent.mimeType === FOLDER_MIME_TYPE &&
    storedParent.trashed !== true &&
    storedParent.parents?.length === 1 &&
    typeof storedParent.name === "string" &&
    MANUAL_CLASSIFICATION_FOLDER_NAMES.has(storedParent.name)
  ) {
    const monthId = storedParent.parents[0];
    const exact = await listExactNamedFolders(accessToken, monthId, storedParent.name);
    if (exact.length !== 1 || exact[0].id !== storedParent.id) {
      throw new Error("GOOGLE_DRIVE_CLASSIFICATION_FOLDER_DUPLICATE");
    }
    return monthId;
  }
  return storedParentId;
}

async function listAllowedCandidateFolderMatches(input: {
  accessToken: string;
  canonicalMonthId: string;
  sessionId: string;
}) {
  const propertyKey = "tokyoDogsInterviewSession";
  const matches = await listExactFolders(
    input.accessToken,
    input.canonicalMonthId,
    propertyKey,
    input.sessionId,
  );
  for (const classificationName of MANUAL_CLASSIFICATION_FOLDER_NAMES) {
    const classificationFolders = await listExactNamedFolders(
      input.accessToken,
      input.canonicalMonthId,
      classificationName,
    );
    if (classificationFolders.length === 0) continue;
    matches.push(...await listExactFolders(
      input.accessToken,
      classificationFolders[0].id,
      propertyKey,
      input.sessionId,
    ));
  }
  return matches;
}

async function resolveCandidateArchiveFolder(input: {
  accessToken: string;
  canonicalMonthId: string;
  sessionId: string;
  name: string;
  trustedFolderId?: string | null;
}) {
  if (!input.trustedFolderId) {
    return await ensureFolder(
      input.accessToken,
      input.canonicalMonthId,
      input.name,
      "tokyoDogsInterviewSession",
      input.sessionId,
    );
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.trustedFolderId)) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  const folder = await getDriveFolderById(input.accessToken, input.trustedFolderId);
  if (folder.id !== input.trustedFolderId) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  await verifyCandidateFolderLocation({
    accessToken: input.accessToken,
    folder,
    sessionId: input.sessionId,
    canonicalMonthId: input.canonicalMonthId,
  });
  const matches = await listAllowedCandidateFolderMatches({
    accessToken: input.accessToken,
    canonicalMonthId: input.canonicalMonthId,
    sessionId: input.sessionId,
  });
  const matchingIds = new Set(matches.map((match) => match.id));
  if (
    matchingIds.size > 1 ||
    [...matchingIds].some((folderId) => folderId !== input.trustedFolderId)
  ) {
    throw new Error("GOOGLE_DRIVE_HIERARCHY_DUPLICATE");
  }
  return folder;
}

function assertHierarchyFolder(input: {
  folder: DriveFile;
  folderId: string;
  parentId: string;
  name: string;
  propertyKey: string;
  propertyValue: string;
}) {
  if (
    input.folder.id !== input.folderId ||
    input.folder.name !== input.name ||
    input.folder.mimeType !== FOLDER_MIME_TYPE ||
    input.folder.trashed === true ||
    input.folder.parents?.length !== 1 ||
    input.folder.parents[0] !== input.parentId ||
    input.folder.appProperties?.tokyoDogsKind !== input.propertyKey ||
    input.folder.appProperties?.[input.propertyKey] !== input.propertyValue
  ) {
    throw new Error("GOOGLE_DRIVE_HIERARCHY_CANONICAL_MISMATCH");
  }
}

async function acquireHierarchyLeaseWithRetry(nodeKey: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const lease = await acquireDriveHierarchyNodeLease(nodeKey);
    if (lease) return lease;
    if (attempt < 39) await wait(50);
  }
  throw new Error("GOOGLE_DRIVE_HIERARCHY_BUSY");
}

async function ensureCanonicalHierarchyFolder(input: {
  accessToken: string;
  nodeKey: string;
  parentId: string;
  name: string;
  propertyKey: string;
  propertyValue: string;
  reportProgress: DriveSyncProgress;
}) {
  const lease = await acquireHierarchyLeaseWithRetry(input.nodeKey);
  let leaseHeld = true;
  const renew = async () => {
    if (!await renewDriveHierarchyNodeLease({ nodeKey: input.nodeKey, leaseToken: lease.leaseToken })) {
      leaseHeld = false;
      throw new Error("GOOGLE_DRIVE_HIERARCHY_LEASE_LOST");
    }
  };
  const release = async () => {
    if (!leaseHeld) return;
    await releaseDriveHierarchyNodeLease({ nodeKey: input.nodeKey, leaseToken: lease.leaseToken });
    leaseHeld = false;
  };
  try {
    let canonicalFolder: DriveFile;
    let canonicalStored = Boolean(lease.canonicalFolderId);
    if (lease.canonicalFolderId) {
      await renew();
      canonicalFolder = await getDriveFolderById(input.accessToken, lease.canonicalFolderId);
      assertHierarchyFolder({ ...input, folder: canonicalFolder, folderId: lease.canonicalFolderId });
    } else {
      await renew();
      const existing = await listExactFolders(
        input.accessToken,
        input.parentId,
        input.propertyKey,
        input.propertyValue,
      );
      if (existing.length > 1) throw new Error("GOOGLE_DRIVE_HIERARCHY_DUPLICATE");
      if (existing.length === 1) {
        await renew();
        canonicalFolder = await getDriveFolderById(input.accessToken, existing[0].id);
        assertHierarchyFolder({ ...input, folder: canonicalFolder, folderId: existing[0].id });
      } else {
        if (lease.creationAttemptedAt) {
          throw new Error("GOOGLE_DRIVE_HIERARCHY_CREATION_UNCERTAIN");
        }
        await renew();
        await input.reportProgress();
        await markDriveHierarchyNodeCreationAttempt({
          nodeKey: input.nodeKey,
          leaseToken: lease.leaseToken,
        });
        const created = await createFolder(input.accessToken, input.parentId, input.name, {
          tokyoDogsKind: input.propertyKey,
          [input.propertyKey]: input.propertyValue,
        });
        // Persist the returned ID before any additional outbound request. If
        // the Worker is canceled after the POST response, the next owner uses
        // exact-ID verification and can never issue a second create.
        await setDriveHierarchyNodeCanonicalFolder({
          nodeKey: input.nodeKey,
          leaseToken: lease.leaseToken,
          folderId: created.id,
        });
        canonicalStored = true;
        await renew();
        canonicalFolder = await getDriveFolderById(input.accessToken, created.id);
        assertHierarchyFolder({ ...input, folder: canonicalFolder, folderId: created.id });
      }
      if (!canonicalStored) {
        await renew();
        await setDriveHierarchyNodeCanonicalFolder({
          nodeKey: input.nodeKey,
          leaseToken: lease.leaseToken,
          folderId: canonicalFolder.id,
        });
      }
    }

    await renew();
    const exact = await listExactFolders(
      input.accessToken,
      input.parentId,
      input.propertyKey,
      input.propertyValue,
    );
    if (exact.length !== 1 || exact[0].id !== canonicalFolder.id) {
      throw new Error("GOOGLE_DRIVE_HIERARCHY_DUPLICATE");
    }
    await release();
    return canonicalFolder;
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

async function listFolderChildren(accessToken: string, parentId: string) {
  const params = new URLSearchParams({
    q: `'${driveQueryValue(parentId)}' in parents and trashed = false`,
    pageSize: "100",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,sha1Checksum,sha256Checksum,version,modifiedTime,trashed,webViewLink,parents,appProperties,permissions(type,role,allowFileDiscovery))",
  });
  const result = await driveJson<DriveFilePage>(`${DRIVE_API_ENDPOINT}/files?${params}`, accessToken);
  if (result.nextPageToken) throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  return result.files ?? [];
}

async function markLegacyDuplicateArtifact(input: {
  accessToken: string;
  fileId: string;
  artifactKey: string;
  canonicalFileId?: string;
  duplicateSha256?: string;
}) {
  const legacyArtifactKey = `legacy_duplicate_${input.artifactKey}`;
  if (legacyArtifactKey.length > 124 || input.artifactKey.length > 124) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_CANONICAL_ID_INVALID");
  }
  if (
    input.canonicalFileId !== undefined &&
    (!/^[A-Za-z0-9_-]{1,124}$/.test(input.canonicalFileId) ||
      !/^[a-f0-9]{64}$/.test(input.duplicateSha256 ?? ""))
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_CANONICAL_ID_INVALID");
  }
  const response = await fetchWithTimeout(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(input.fileId)}?supportsAllDrives=true&fields=${encodeURIComponent("id,name,mimeType,size,md5Checksum,sha1Checksum,sha256Checksum,version,modifiedTime,trashed,webViewLink,parents,appProperties")}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        appProperties: {
          tokyoDogsArtifact: legacyArtifactKey,
          tokyoDogsLegacyArtifact: input.artifactKey,
          ...(input.canonicalFileId ? {
            tokyoDogsCanonicalFileId: input.canonicalFileId,
            tokyoDogsDuplicateSha256: input.duplicateSha256,
          } : {}),
        },
      }),
    },
    DRIVE_RECORDING_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`GOOGLE_DRIVE_API_${response.status}`);
  return await response.json() as DriveFile;
}


async function readSmallDriveFile(input: {
  accessToken: string;
  file: DriveFile;
  maximumBytes: number;
}) {
  const declaredSize = typeof input.file.size === "string" && /^\d+$/.test(input.file.size)
    ? Number(input.file.size)
    : Number.NaN;
  if (
    !Number.isSafeInteger(declaredSize) ||
    declaredSize < 0 ||
    declaredSize > input.maximumBytes
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const response = await fetchWithTimeout(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(input.file.id)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${input.accessToken}` } },
    DRIVE_RECORDING_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error([429, 500, 502, 503, 504].includes(response.status)
      ? `GOOGLE_DRIVE_API_${response.status}`
      : "GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const contentLength = response.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > input.maximumBytes)
  ) {
    await response.body?.cancel();
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== declaredSize || bytes.byteLength > input.maximumBytes) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return bytes;
}

/**
 * A completed manifest is a durable Drive-side receipt that the recording was
 * already finalized once. When a redundant request arrives after that point,
 * adopt the exact tagged recording and let finalizeDriveArchive re-read every
 * artifact instead of opening another large resumable upload.
 *
 * Metadata alone is deliberately insufficient: the receipt must name the same
 * session, folder, transcript mode and canonical recording ID/size. Any
 * mismatch fails closed and preserves both the R2 source and Drive evidence.
 */
async function finalizedRecordingFromDriveManifest(input: {
  accessToken: string;
  source: ArchiveSource;
  prepared: PreparedDriveArchive;
}) {
  if (!input.source.recording) return null;
  const children = await listFolderChildren(input.accessToken, input.prepared.candidateFolder.id);
  const recordings = children.filter((file) =>
    file.appProperties?.tokyoDogsArtifact === "recording" &&
    file.appProperties?.tokyoDogsProvider === DRIVE_PROVIDER,
  );
  const manifests = children.filter((file) =>
    file.appProperties?.tokyoDogsArtifact === "manifest" &&
    file.appProperties?.tokyoDogsProvider === DRIVE_PROVIDER,
  );
  if (recordings.length === 0 || manifests.length === 0) return null;
  if (recordings.length !== 1 || manifests.length !== 1) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const recording = recordings[0];
  const manifest = manifests[0];
  const trustedRecordingId = input.prepared.artifactTargetIds.recording;
  const trustedManifestId = input.prepared.artifactTargetIds.manifest;
  if (
    (typeof trustedRecordingId === "string" && recording.id !== trustedRecordingId) ||
    (typeof trustedManifestId === "string" && manifest.id !== trustedManifestId)
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const recordingId = recording.id;
  const extension = input.source.recording.contentType.includes("mp4") ? "mp4" : "webm";
  const recordingName = `${input.source.sessionId}_面接録画.${extension}`;
  if (
    !recordingFileMatchesTrustedUpload({
      file: recording,
      folderId: input.prepared.candidateFolder.id,
      name: recordingName,
      contentType: input.source.recording.contentType,
      byteSize: input.source.recording.byteSize,
    }) ||
    manifest.trashed === true ||
    manifest.name !== `${input.source.sessionId}_格納結果.json` ||
    manifest.mimeType !== "application/json" ||
    !exactDriveParent(manifest, input.prepared.candidateFolder.id) ||
    manifest.appProperties?.tokyoDogsArtifact !== "manifest" ||
    manifest.appProperties?.tokyoDogsProvider !== DRIVE_PROVIDER
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }

  const bytes = await readSmallDriveFile({
    accessToken: input.accessToken,
    file: manifest,
    maximumBytes: 64 * 1024,
  });
  let receipt: Record<string, unknown>;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    receipt = decoded as Record<string, unknown>;
  } catch {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const files = receipt.files && typeof receipt.files === "object" && !Array.isArray(receipt.files)
    ? receipt.files as Record<string, unknown>
    : null;
  const recorded = files?.recording && typeof files.recording === "object" && !Array.isArray(files.recording)
    ? files.recording as Record<string, unknown>
    : null;
  if (
    receipt.schemaVersion !== "2026-08-23-v2" ||
    receipt.sessionId !== input.source.sessionId ||
    receipt.rootFolderId !== input.prepared.rootFolderId ||
    receipt.folderId !== input.prepared.candidateFolder.id ||
    receipt.recordingIncluded !== true ||
    receipt.transcriptAvailable !== input.prepared.transcriptAvailable ||
    receipt.transcriptKind !== input.prepared.transcriptKind ||
    receipt.technicalHold !== (input.prepared.transcriptKind === TECHNICAL_EVIDENCE_TRANSCRIPT_KIND) ||
    receipt.automaticEvaluationPerformed !== (input.source.evaluation !== null) ||
    recorded?.id !== recordingId ||
    recorded?.name !== recordingName ||
    Number(recorded?.size) !== input.source.recording.byteSize
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return recording;
}

async function sha256Bytes(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function safeDriveVersion(file: DriveFile) {
  if (typeof file.version !== "string" || !/^\d+$/.test(file.version)) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return file.version;
}

function safeDriveModifiedTime(file: DriveFile) {
  if (typeof file.modifiedTime !== "string" || !Number.isFinite(Date.parse(file.modifiedTime))) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return file.modifiedTime;
}

function sharingRiskFromPermissions(permissions: DrivePermission[] | undefined): DriveSharingRisk {
  if (!Array.isArray(permissions)) return "unknown";
  const publicRoles = permissions
    .filter((permission) => permission.type === "anyone")
    .map((permission) => permission.role);
  if (publicRoles.some((role) => role === "owner" || role === "organizer" || role === "fileOrganizer" || role === "writer")) {
    return "anyone_writer";
  }
  if (publicRoles.some((role) => role === "reader" || role === "commenter")) {
    return "anyone_reader";
  }
  return "restricted";
}

function highestSharingRisk(risks: DriveSharingRisk[]) {
  if (risks.includes("anyone_writer")) return "anyone_writer" as const;
  if (risks.includes("anyone_reader")) return "anyone_reader" as const;
  if (risks.includes("unknown")) return "unknown" as const;
  return "restricted" as const;
}

function exactDriveParent(file: DriveFile, folderId: string) {
  return file.parents?.length === 1 && file.parents[0] === folderId;
}

function safeDriveFileSize(file: DriveFile) {
  if (typeof file.size !== "string" || !/^\d+$/.test(file.size)) return null;
  const size = Number(file.size);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function recordingFileMatchesTrustedUpload(input: {
  file: DriveFile;
  folderId: string;
  name: string;
  contentType: string;
  byteSize: number;
}) {
  return Boolean(
    input.file.id && input.file.name === input.name &&
    input.file.mimeType === input.contentType &&
    safeDriveFileSize(input.file) === input.byteSize &&
    exactDriveParent(input.file, input.folderId) &&
    input.file.trashed !== true &&
    input.file.appProperties?.tokyoDogsArtifact === "recording" &&
    input.file.appProperties?.tokyoDogsProvider === DRIVE_PROVIDER,
  );
}

function validatedDriveChecksums(file: DriveFile) {
  const result = new Map<"sha256Checksum" | "sha1Checksum" | "md5Checksum", string>();
  for (const [field, length] of [
    ["sha256Checksum", 64],
    ["sha1Checksum", 40],
    ["md5Checksum", 32],
  ] as const) {
    const raw = file[field];
    if (raw === undefined) continue;
    const normalized = raw.toLowerCase();
    if (!new RegExp(`^[a-f0-9]{${length}}$`).test(normalized)) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    result.set(field, normalized);
  }
  return result;
}

async function readDriveRecordingRange(input: {
  accessToken: string;
  fileId: string;
  start: number;
  end: number;
  totalBytes: number;
}) {
  const expectedBytes = input.end - input.start + 1;
  const response = await fetchWithTimeout(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(input.fileId)}?alt=media&supportsAllDrives=true`,
    {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Range: `bytes=${input.start}-${input.end}`,
      },
    },
    DRIVE_RECORDING_REQUEST_TIMEOUT_MS,
  );
  if ([429, 500, 502, 503, 504].includes(response.status)) {
    await response.body?.cancel();
    throw new Error(`GOOGLE_DRIVE_API_${response.status}`);
  }
  const completeSingleRange = input.start === 0 && expectedBytes === input.totalBytes;
  if (response.status !== 206 && !(completeSingleRange && response.status === 200)) {
    await response.body?.cancel();
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  if (response.status === 206) {
    const contentRange = response.headers.get("Content-Range");
    if (contentRange !== `bytes ${input.start}-${input.end}/${input.totalBytes}`) {
      await response.body?.cancel();
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
  }
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== expectedBytes)) {
    await response.body?.cancel();
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== expectedBytes || bytes.byteLength > DRIVE_DUPLICATE_RECORDING_RANGE_BYTES) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return await sha256Bytes(bytes);
}

async function boundedRecordingPairFingerprint(input: {
  accessToken: string;
  canonicalId: string;
  duplicateId: string;
  byteSize: number;
}) {
  if (
    input.byteSize < 1 ||
    input.byteSize > DRIVE_DUPLICATE_RECORDING_FALLBACK_MAX_BYTES
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const chunkHashes: string[] = [];
  for (let start = 0; start < input.byteSize; start += DRIVE_DUPLICATE_RECORDING_RANGE_BYTES) {
    const end = Math.min(start + DRIVE_DUPLICATE_RECORDING_RANGE_BYTES, input.byteSize) - 1;
    const [canonicalHash, duplicateHash] = await Promise.all([
      readDriveRecordingRange({
        accessToken: input.accessToken,
        fileId: input.canonicalId,
        start,
        end,
        totalBytes: input.byteSize,
      }),
      readDriveRecordingRange({
        accessToken: input.accessToken,
        fileId: input.duplicateId,
        start,
        end,
        totalBytes: input.byteSize,
      }),
    ]);
    if (canonicalHash !== duplicateHash) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    chunkHashes.push(canonicalHash);
  }
  return await sha256Bytes(new TextEncoder().encode(
    `${input.byteSize}:${DRIVE_DUPLICATE_RECORDING_RANGE_BYTES}:${chunkHashes.join(":")}`,
  ));
}

async function proveRecordingDuplicate(input: {
  accessToken: string;
  folderId: string;
  canonical: DriveFile;
  duplicate: DriveFile;
  expectedByteSize: number;
  expectedName: string;
  expectedContentType: string;
}) : Promise<RecordingDuplicateProof> {
  if (
    !input.canonical.id || !input.duplicate.id || input.canonical.id === input.duplicate.id ||
    input.canonical.trashed === true || input.duplicate.trashed === true ||
    !exactDriveParent(input.canonical, input.folderId) ||
    !exactDriveParent(input.duplicate, input.folderId) ||
    input.canonical.appProperties?.tokyoDogsArtifact !== "recording" ||
    !["recording", "legacy_duplicate_recording"].includes(
      input.duplicate.appProperties?.tokyoDogsArtifact ?? "",
    ) ||
    (input.duplicate.appProperties?.tokyoDogsArtifact === "legacy_duplicate_recording" &&
      (
        input.duplicate.appProperties?.tokyoDogsLegacyArtifact !== "recording" ||
        input.duplicate.appProperties?.tokyoDogsCanonicalFileId !== input.canonical.id ||
        !/^[a-f0-9]{64}$/.test(input.duplicate.appProperties?.tokyoDogsDuplicateSha256 ?? "")
      )) ||
    input.canonical.appProperties?.tokyoDogsProvider !== DRIVE_PROVIDER ||
    input.duplicate.appProperties?.tokyoDogsProvider !== DRIVE_PROVIDER ||
    input.canonical.name !== input.expectedName || input.duplicate.name !== input.expectedName ||
    input.canonical.mimeType !== input.expectedContentType ||
    input.duplicate.mimeType !== input.expectedContentType
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const canonicalSize = safeDriveFileSize(input.canonical);
  const duplicateSize = safeDriveFileSize(input.duplicate);
  if (
    !Number.isSafeInteger(input.expectedByteSize) || input.expectedByteSize < 1 ||
    canonicalSize !== input.expectedByteSize || duplicateSize !== input.expectedByteSize
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const canonicalChecksums = validatedDriveChecksums(input.canonical);
  const duplicateChecksums = validatedDriveChecksums(input.duplicate);
  const canonicalChecksum = canonicalChecksums.get("sha256Checksum");
  const duplicateChecksum = duplicateChecksums.get("sha256Checksum");
  // Production recordings are far larger than the bounded read fallback. For
  // those files Drive must provide SHA-256 on both exact file IDs; weaker
  // digests and equal size/name alone are never content identity.
  if (input.expectedByteSize > DRIVE_DUPLICATE_RECORDING_FALLBACK_MAX_BYTES) {
    if (!canonicalChecksum || !duplicateChecksum || canonicalChecksum !== duplicateChecksum) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    if (
      input.duplicate.appProperties?.tokyoDogsArtifact === "legacy_duplicate_recording" &&
      input.duplicate.appProperties?.tokyoDogsDuplicateSha256 !== canonicalChecksum
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    return {
      canonicalId: input.canonical.id,
      duplicateId: input.duplicate.id,
      byteSize: input.expectedByteSize,
      fingerprintAlgorithm: "sha256Checksum",
      fingerprint: canonicalChecksum,
    };
  }
  if (canonicalChecksum || duplicateChecksum) {
    if (!canonicalChecksum || !duplicateChecksum || canonicalChecksum !== duplicateChecksum) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    return {
      canonicalId: input.canonical.id,
      duplicateId: input.duplicate.id,
      byteSize: input.expectedByteSize,
      fingerprintAlgorithm: "sha256Checksum",
      fingerprint: canonicalChecksum,
    };
  }
  const fingerprint = await boundedRecordingPairFingerprint({
    accessToken: input.accessToken,
    canonicalId: input.canonical.id,
    duplicateId: input.duplicate.id,
    byteSize: input.expectedByteSize,
  });
  if (
    input.duplicate.appProperties?.tokyoDogsArtifact === "legacy_duplicate_recording" &&
    input.duplicate.appProperties?.tokyoDogsDuplicateSha256 !== fingerprint
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return {
    canonicalId: input.canonical.id,
    duplicateId: input.duplicate.id,
    byteSize: input.expectedByteSize,
    fingerprintAlgorithm: "bounded-range-sha256",
    fingerprint,
  };
}

function sameRecordingDuplicateProof(left: RecordingDuplicateProof, right: RecordingDuplicateProof) {
  return left.canonicalId === right.canonicalId &&
    left.duplicateId === right.duplicateId &&
    left.byteSize === right.byteSize &&
    left.fingerprintAlgorithm === right.fingerprintAlgorithm &&
    left.fingerprint === right.fingerprint;
}

function indexDriveArtifacts(files: DriveFile[]) {
  const byArtifact = new Map<string, DriveFile[]>();
  for (const file of files) {
    const key = file.appProperties?.tokyoDogsArtifact;
    if (!key) continue;
    byArtifact.set(key, [...(byArtifact.get(key) ?? []), file]);
  }
  return byArtifact;
}

async function preflightDriveArchive(input: {
  accessToken: string;
  folderId: string;
  recordingIncluded: boolean;
  expectedRecordingByteSize: number | null;
  expectedRecordingName: string | null;
  expectedRecordingContentType: string | null;
  expectedTranscript: Uint8Array;
  trustedTargetIds?: Record<string, string | null | undefined>;
  expectedDuplicateId?: string | null;
}) {
  const required = ["transcript", "evaluation_json", "report_doc", "report_pdf", "manifest"];
  if (input.recordingIncluded) required.push("recording");
  const files = await listFolderChildren(input.accessToken, input.folderId);
  const byArtifact = indexDriveArtifacts(files);
  const artifactTargetIds: Record<string, string | null | undefined> = {};
  let transcriptDuplicateId: string | null = null;
  let recordingDuplicateProof: RecordingDuplicateProof | null = null;
  const legacyRecordingFiles = byArtifact.get("legacy_duplicate_recording") ?? [];
  const recordingNamedFiles = input.expectedRecordingName
    ? files.filter((file) => file.name === input.expectedRecordingName)
    : [];
  if (
    legacyRecordingFiles.length > 1 ||
    legacyRecordingFiles.some((file) =>
      file.appProperties?.tokyoDogsLegacyArtifact !== "recording" ||
      file.trashed === true ||
      !exactDriveParent(file, input.folderId)) ||
    (!input.recordingIncluded && legacyRecordingFiles.length > 0)
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  if (
    input.recordingIncluded &&
    recordingNamedFiles.some((file) => !["recording", "legacy_duplicate_recording"].includes(
      file.appProperties?.tokyoDogsArtifact ?? "",
    ))
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  if (input.expectedDuplicateId) {
    const knownDuplicate = files.find((file) => file.id === input.expectedDuplicateId);
    if (
      !knownDuplicate || knownDuplicate.trashed === true || !exactDriveParent(knownDuplicate, input.folderId) ||
      !["transcript", "legacy_duplicate_transcript"].includes(knownDuplicate.appProperties?.tokyoDogsArtifact ?? "") ||
      (knownDuplicate.appProperties?.tokyoDogsArtifact === "legacy_duplicate_transcript" &&
        knownDuplicate.appProperties?.tokyoDogsLegacyArtifact !== "transcript")
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    transcriptDuplicateId = knownDuplicate.id;
  }

  for (const artifactKey of required) {
    const taggedFiles = byArtifact.get(artifactKey) ?? [];
    const trustedId = input.trustedTargetIds?.[artifactKey];
    if (taggedFiles.some((file) => file.trashed === true || !exactDriveParent(file, input.folderId))) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    if (artifactKey === "recording") {
      if (taggedFiles.length <= 1 && legacyRecordingFiles.length === 0) {
        if (trustedId && taggedFiles[0]?.id !== trustedId) {
          throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
        }
        const onlyRecording = taggedFiles[0];
        if (onlyRecording && (
          !input.expectedRecordingName || !input.expectedRecordingContentType ||
          input.expectedRecordingByteSize === null ||
          onlyRecording.name !== input.expectedRecordingName ||
          onlyRecording.mimeType !== input.expectedRecordingContentType ||
          safeDriveFileSize(onlyRecording) !== input.expectedRecordingByteSize ||
          onlyRecording.appProperties?.tokyoDogsProvider !== DRIVE_PROVIDER
        )) {
          throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
        }
        artifactTargetIds.recording = taggedFiles[0]?.id ?? null;
        continue;
      }
      // A duplicate recording is repairable only after the current resumable
      // upload has supplied its exact canonical ID. Never choose by Drive list
      // order, filename, timestamp, or lexicographic ID.
      if (
        !trustedId || input.expectedRecordingByteSize === null ||
        !input.expectedRecordingName || !input.expectedRecordingContentType ||
        !(
          (taggedFiles.length === 2 && legacyRecordingFiles.length === 0) ||
          (taggedFiles.length === 1 && legacyRecordingFiles.length === 1)
        )
      ) {
        throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
      }
      const canonical = taggedFiles.find((file) => file.id === trustedId);
      const duplicate = taggedFiles.length === 2
        ? taggedFiles.find((file) => file.id !== trustedId)
        : legacyRecordingFiles[0];
      if (!canonical || !duplicate) {
        throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
      }
      recordingDuplicateProof = await proveRecordingDuplicate({
        accessToken: input.accessToken,
        folderId: input.folderId,
        canonical,
        duplicate,
        expectedByteSize: input.expectedRecordingByteSize,
        expectedName: input.expectedRecordingName,
        expectedContentType: input.expectedRecordingContentType,
      });
      artifactTargetIds.recording = canonical.id;
      continue;
    }
    if (taggedFiles.length <= 1) {
      if (trustedId && taggedFiles[0]?.id !== trustedId) {
        throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
      }
      artifactTargetIds[artifactKey] = taggedFiles[0]?.id ?? null;
      continue;
    }
    if (artifactKey !== "transcript" || taggedFiles.length !== 2) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    if (input.expectedTranscript.byteLength > 1024 * 1024) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    const transcriptBytes = await Promise.all(taggedFiles.map((file) => readSmallDriveFile({
      accessToken: input.accessToken,
      file,
      maximumBytes: 1024 * 1024,
    })));
    const expectedHash = await sha256Bytes(input.expectedTranscript);
    const transcriptHashes = await Promise.all(transcriptBytes.map(sha256Bytes));
    if (transcriptBytes.some((bytes, index) =>
      bytes.byteLength !== input.expectedTranscript.byteLength || transcriptHashes[index] !== expectedHash)) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    const canonical = (trustedId && taggedFiles.find((file) => file.id === trustedId)) ||
      [...taggedFiles].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)[0];
    if (trustedId && canonical.id !== trustedId) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    artifactTargetIds.transcript = canonical.id;
    const duplicate = taggedFiles.find((file) => file.id !== canonical.id);
    if (input.expectedDuplicateId && duplicate?.id !== input.expectedDuplicateId) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    transcriptDuplicateId = duplicate?.id ?? null;
    if (!transcriptDuplicateId) throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  if (recordingDuplicateProof && transcriptDuplicateId) {
    // Keep this P1 repair deliberately single-purpose. A folder containing a
    // second active duplicate class requires separate manual review.
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return { artifactTargetIds, transcriptDuplicateId, recordingDuplicateProof };
}

async function createFolder(
  accessToken: string,
  parentId: string,
  name: string,
  appProperties: Record<string, string>,
) {
  return await driveJson<DriveFile>(
    `${DRIVE_API_ENDPOINT}/files?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,parents,appProperties`,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME_TYPE, parents: [parentId], appProperties }),
    },
  );
}

async function ensureFolder(
  accessToken: string,
  parentId: string,
  name: string,
  propertyKey: string,
  propertyValue: string,
) {
  const propertyQuery = `mimeType = '${FOLDER_MIME_TYPE}' and appProperties has { key='${driveQueryValue(propertyKey)}' and value='${driveQueryValue(propertyValue)}' }`;
  const existing = await findChild(accessToken, parentId, propertyQuery);
  if (existing) return existing;
  return await createFolder(accessToken, parentId, name, {
    tokyoDogsKind: propertyKey,
    [propertyKey]: propertyValue,
  });
}

async function findArtifact(accessToken: string, folderId: string, artifactKey: string) {
  const params = new URLSearchParams({
    q: `'${driveQueryValue(folderId)}' in parents and trashed = false and appProperties has { key='tokyoDogsArtifact' and value='${driveQueryValue(artifactKey)}' }`,
    pageSize: "3",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "nextPageToken,files(id,name,mimeType,size,version,modifiedTime,trashed,webViewLink,parents,appProperties)",
  });
  const result = await driveJson<DriveFilePage>(`${DRIVE_API_ENDPOINT}/files?${params}`, accessToken);
  if (result.nextPageToken || (result.files?.length ?? 0) > 1) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return result.files?.[0] ?? null;
}

async function uploadSmallFile(input: {
  accessToken: string;
  folderId: string;
  name: string;
  artifactKey: string;
  contentType: string;
  body: string | Uint8Array;
  googleMimeType?: string;
  targetFileId?: string | null;
}) {
  const targetFileId = input.targetFileId === undefined
    ? (await findArtifact(input.accessToken, input.folderId, input.artifactKey))?.id ?? null
    : input.targetFileId;
  const metadata: Record<string, unknown> = {
    name: input.name,
    appProperties: {
      tokyoDogsArtifact: input.artifactKey,
      tokyoDogsProvider: DRIVE_PROVIDER,
    },
  };
  if (!targetFileId) metadata.parents = [input.folderId];
  if (input.googleMimeType) metadata.mimeType = input.googleMimeType;
  const formData = new FormData();
  formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json; charset=UTF-8" }));
  const bytes = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
  // Copy into an ArrayBuffer-backed view. Cloudflare streams may expose an
  // ArrayBufferLike view, while the standards Blob constructor accepts only an
  // ArrayBuffer-backed BlobPart under strict TypeScript checking.
  const blobBytes = Uint8Array.from(bytes);
  formData.append("media", new Blob([blobBytes.buffer], { type: input.contentType }));
  const url = targetFileId
    ? `${DRIVE_UPLOAD_ENDPOINT}/files/${encodeURIComponent(targetFileId)}?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink`
    : `${DRIVE_UPLOAD_ENDPOINT}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink`;
  const uploaded = await driveJson<DriveFile>(url, input.accessToken, {
    method: targetFileId ? "PATCH" : "POST",
    body: formData,
  });
  if (targetFileId && uploaded.id !== targetFileId) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return uploaded;
}

async function exportGoogleDocToPdf(accessToken: string, fileId: string) {
  const response = await fetchWithTimeout(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent("application/pdf")}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    DRIVE_RECORDING_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`GOOGLE_DRIVE_EXPORT_${response.status}`);
  const contentLength = response.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > DRIVE_INTEGRITY_SMALL_FILE_MAX_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > DRIVE_INTEGRITY_SMALL_FILE_MAX_BYTES) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return bytes;
}

async function exportGoogleDocToText(accessToken: string, fileId: string) {
  const response = await fetchWithTimeout(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent("text/plain")}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    DRIVE_RECORDING_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`GOOGLE_DRIVE_EXPORT_${response.status}`);
  const contentLength = response.headers.get("Content-Length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > DRIVE_INTEGRITY_SMALL_FILE_MAX_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > DRIVE_INTEGRITY_SMALL_FILE_MAX_BYTES) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return bytes;
}

async function uploadRecording(input: {
  accessToken: string;
  folderId: string;
  name: string;
  contentType: string;
  byteSize: number;
  sessionId: string;
  targetFileId?: string | null;
}) {
  const targetFileId = input.targetFileId === undefined
    ? (await findArtifact(input.accessToken, input.folderId, "recording"))?.id ?? null
    : input.targetFileId;
  const metadata: Record<string, unknown> = {
    name: input.name,
    appProperties: {
      tokyoDogsArtifact: "recording",
      tokyoDogsProvider: DRIVE_PROVIDER,
      tokyoDogsInterviewSession: input.sessionId,
    },
  };
  if (!targetFileId) metadata.parents = [input.folderId];
  const initUrl = targetFileId
    ? `${DRIVE_UPLOAD_ENDPOINT}/files/${encodeURIComponent(targetFileId)}?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,sha256Checksum,trashed,webViewLink,parents,appProperties`
    : `${DRIVE_UPLOAD_ENDPOINT}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,sha256Checksum,trashed,webViewLink,parents,appProperties`;
  const initResponse = await fetchWithTimeout(initUrl, {
    method: targetFileId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": input.contentType,
      "X-Upload-Content-Length": String(input.byteSize),
    },
    body: JSON.stringify(metadata),
  }, DRIVE_RECORDING_REQUEST_TIMEOUT_MS);
  let uploadLocation = initResponse.headers.get("Location");
  if (!initResponse.ok || !uploadLocation) throw new Error(`GOOGLE_DRIVE_RESUMABLE_INIT_${initResponse.status}`);

  async function queryCommittedBytes() {
    const response = await fetchWithTimeout(uploadLocation as string, {
      method: "PUT",
      // Drive uses HTTP 308 as an application-level "Resume Incomplete"
      // response and can supply a replacement upload URI. Automatic redirect
      // handling would replay the same PUT instead of returning control to this
      // resumable-upload state machine.
      redirect: "manual",
      headers: {
        "Content-Length": "0",
        "Content-Range": `bytes */${input.byteSize}`,
      },
    }, DRIVE_RECORDING_REQUEST_TIMEOUT_MS);
    if (response.ok) return { complete: true as const, file: await response.json() as DriveFile };
    if (response.status !== 308) throw new Error(`GOOGLE_DRIVE_RESUMABLE_UPLOAD_${response.status}`);
    uploadLocation = response.headers.get("Location") || uploadLocation;
    const range = response.headers.get("Range")?.match(/^bytes=0-(\d+)$/);
    await response.body?.cancel();
    return { complete: false as const, committedBytes: range ? Number(range[1]) + 1 : 0 };
  }

  async function putChunk(bytes: Uint8Array, start: number) {
    const end = start + bytes.byteLength - 1;
    let nextOffset = start;
    let lastStatus = 0;
    for (let attempt = 0; attempt < DRIVE_RECORDING_CHUNK_ATTEMPTS; attempt += 1) {
      try {
        const remaining = bytes.subarray(nextOffset - start);
        const response = await fetchWithTimeout(uploadLocation as string, {
          method: "PUT",
          redirect: "manual",
          headers: {
            "Content-Type": input.contentType,
            "Content-Length": String(remaining.byteLength),
            "Content-Range": `bytes ${nextOffset}-${end}/${input.byteSize}`,
          },
          body: Uint8Array.from(remaining).buffer,
        }, DRIVE_RECORDING_REQUEST_TIMEOUT_MS);
        lastStatus = response.status;
        if (response.ok) return { complete: true as const, file: await response.json() as DriveFile };
        if (response.status === 308) {
          uploadLocation = response.headers.get("Location") || uploadLocation;
          const range = response.headers.get("Range")?.match(/^bytes=0-(\d+)$/);
          await response.body?.cancel();
          const committedBytes = range ? Number(range[1]) + 1 : 0;
          if (committedBytes >= end + 1) return { complete: false as const };
          if (committedBytes < nextOffset || committedBytes > end) {
            throw new Error("GOOGLE_DRIVE_RESUMABLE_RANGE_MISMATCH");
          }
          nextOffset = committedBytes;
          continue;
        }
        if (![429, 500, 502, 503, 504].includes(response.status)) {
          throw new Error(`GOOGLE_DRIVE_RESUMABLE_UPLOAD_${response.status}`);
        }
        await response.body?.cancel();
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "GOOGLE_DRIVE_RESUMABLE_RANGE_MISMATCH" || /^GOOGLE_DRIVE_RESUMABLE_UPLOAD_(?!429|500|502|503|504)/.test(code)) {
          throw error;
        }
      }

      await wait(TRANSIENT_DRIVE_RETRY_DELAY_MS * (attempt + 1));
      try {
        const status = await queryCommittedBytes();
        if (status.complete) return status;
        if (status.committedBytes >= end + 1) return { complete: false as const };
        if (status.committedBytes < start || status.committedBytes > end) {
          throw new Error("GOOGLE_DRIVE_RESUMABLE_RANGE_MISMATCH");
        }
        nextOffset = status.committedBytes;
      } catch (error) {
        if (attempt === DRIVE_RECORDING_CHUNK_ATTEMPTS - 1) throw error;
      }
    }
    throw new Error(`GOOGLE_DRIVE_RESUMABLE_UPLOAD_${lastStatus || 503}`);
  }

  let uploadedBytes = 0;
  let completedFile: DriveFile | null = null;
  while (uploadedBytes < input.byteSize) {
    const expectedLength = Math.min(DRIVE_RECORDING_CHUNK_BYTES, input.byteSize - uploadedBytes);
    const sourceChunk = await getInterviewRecordingChunk({
      sessionId: input.sessionId,
      offset: uploadedBytes,
      length: expectedLength,
    });
    if (!sourceChunk || sourceChunk.byteSize !== input.byteSize || sourceChunk.contentType !== input.contentType) {
      throw new Error("INTERVIEW_RECORDING_ARTIFACT_MISSING");
    }
    const chunk = sourceChunk.bytes;
    const uploaded = await putChunk(chunk, uploadedBytes);
    uploadedBytes += chunk.byteLength;
    if (uploaded.complete) completedFile = uploaded.file;
  }
  if (uploadedBytes !== input.byteSize) throw new Error("GOOGLE_DRIVE_RECORDING_SOURCE_SIZE_MISMATCH");
  if (!completedFile) {
    const status = await queryCommittedBytes();
    if (status.complete) completedFile = status.file;
  }
  if (!completedFile) throw new Error("GOOGLE_DRIVE_RESUMABLE_UPLOAD_INCOMPLETE");
  return completedFile;
}

async function initiateRecordingUpload(input: {
  accessToken: string;
  folderId: string;
  name: string;
  contentType: string;
  byteSize: number;
  sessionId: string;
  targetFileId?: string | null;
}) {
  const targetFileId = input.targetFileId === undefined
    ? (await findArtifact(input.accessToken, input.folderId, "recording"))?.id ?? null
    : input.targetFileId;
  const metadata: Record<string, unknown> = {
    name: input.name,
    appProperties: {
      tokyoDogsArtifact: "recording",
      tokyoDogsProvider: DRIVE_PROVIDER,
      tokyoDogsInterviewSession: input.sessionId,
    },
  };
  if (!targetFileId) metadata.parents = [input.folderId];
  const initUrl = targetFileId
    ? `${DRIVE_UPLOAD_ENDPOINT}/files/${encodeURIComponent(targetFileId)}?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,sha256Checksum,trashed,webViewLink,parents,appProperties`
    : `${DRIVE_UPLOAD_ENDPOINT}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,sha256Checksum,trashed,webViewLink,parents,appProperties`;
  const response = await fetchWithTimeout(initUrl, {
    method: targetFileId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": input.contentType,
      "X-Upload-Content-Length": String(input.byteSize),
    },
    body: JSON.stringify(metadata),
  }, DRIVE_RECORDING_REQUEST_TIMEOUT_MS);
  const uploadLocation = response.headers.get("Location");
  if (!response.ok || !uploadLocation) {
    await response.body?.cancel();
    throw new Error(`GOOGLE_DRIVE_RESUMABLE_INIT_${response.status}`);
  }
  await response.body?.cancel();
  return uploadLocation;
}

type ResumableStatus =
  | { complete: true; file: DriveFile; uploadLocation: string }
  | { complete: false; committedBytes: number; uploadLocation: string };

async function queryResumableStatus(uploadLocation: string, totalBytes: number): Promise<ResumableStatus> {
  const response = await fetchWithTimeout(uploadLocation, {
    method: "PUT",
    redirect: "manual",
    headers: {
      "Content-Length": "0",
      "Content-Range": `bytes */${totalBytes}`,
    },
  }, DRIVE_RECORDING_REQUEST_TIMEOUT_MS);
  if (response.ok) {
    return { complete: true, file: await response.json() as DriveFile, uploadLocation };
  }
  const nextLocation = response.headers.get("Location") || uploadLocation;
  if (response.status !== 308) {
    await response.body?.cancel();
    throw new Error(`GOOGLE_DRIVE_RESUMABLE_UPLOAD_${response.status}`);
  }
  const range = response.headers.get("Range")?.match(/^bytes=0-(\d+)$/);
  await response.body?.cancel();
  return {
    complete: false,
    committedBytes: range ? Number(range[1]) + 1 : 0,
    uploadLocation: nextLocation,
  };
}

async function putOneRecordingChunk(input: {
  uploadLocation: string;
  contentType: string;
  totalBytes: number;
  offset: number;
  bytes: Uint8Array;
}): Promise<ResumableStatus> {
  const end = input.offset + input.bytes.byteLength - 1;
  const response = await fetchWithTimeout(input.uploadLocation, {
    method: "PUT",
    redirect: "manual",
    headers: {
      "Content-Type": input.contentType,
      "Content-Length": String(input.bytes.byteLength),
      "Content-Range": `bytes ${input.offset}-${end}/${input.totalBytes}`,
    },
    body: Uint8Array.from(input.bytes).buffer,
  }, DRIVE_RECORDING_REQUEST_TIMEOUT_MS);
  if (response.ok) {
    return { complete: true, file: await response.json() as DriveFile, uploadLocation: input.uploadLocation };
  }
  const nextLocation = response.headers.get("Location") || input.uploadLocation;
  if (response.status !== 308) {
    await response.body?.cancel();
    throw new Error(`GOOGLE_DRIVE_RESUMABLE_UPLOAD_${response.status}`);
  }
  const range = response.headers.get("Range")?.match(/^bytes=0-(\d+)$/);
  await response.body?.cancel();
  const committedBytes = range ? Number(range[1]) + 1 : 0;
  if (committedBytes < input.offset || committedBytes > end + 1) {
    throw new Error("GOOGLE_DRIVE_RESUMABLE_RANGE_MISMATCH");
  }
  return { complete: false, committedBytes, uploadLocation: nextLocation };
}

function fileSummary(file: DriveFile, fallbackName: string) {
  const numericSize = file.size && Number.isFinite(Number(file.size)) ? Number(file.size) : null;
  return { id: file.id, name: file.name || fallbackName, size: numericSize };
}

async function readArtifactIntegrityReceipt(input: {
  accessToken: string;
  artifactKey: DriveArtifactKey;
  file: DriveFile;
  expectedContentHash?: string;
  expectedContentSize?: number;
}) : Promise<DriveArtifactIntegrityReceipt> {
  const version = safeDriveVersion(input.file);
  const modifiedTime = safeDriveModifiedTime(input.file);
  let contentSha256: string;
  let contentByteSize: number;
  let fingerprintSource: DriveArtifactIntegrityReceipt["fingerprintSource"];

  if (input.artifactKey === "report_doc") {
    const exported = await exportGoogleDocToText(input.accessToken, input.file.id);
    contentSha256 = await sha256Bytes(exported);
    contentByteSize = exported.byteLength;
    fingerprintSource = "google-doc-text-sha256";
  } else if (input.artifactKey === "recording") {
    const size = safeDriveFileSize(input.file);
    if (size === null || size < 1) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    const checksum = validatedDriveChecksums(input.file).get("sha256Checksum");
    if (!checksum) throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    contentSha256 = checksum;
    fingerprintSource = "sha256Checksum";
    contentByteSize = size;
  } else {
    const bytes = await readSmallDriveFile({
      accessToken: input.accessToken,
      file: input.file,
      maximumBytes: DRIVE_INTEGRITY_SMALL_FILE_MAX_BYTES,
    });
    contentSha256 = await sha256Bytes(bytes);
    contentByteSize = bytes.byteLength;
    fingerprintSource = "bounded-content-sha256";
  }

  if (
    (input.expectedContentHash && contentSha256 !== input.expectedContentHash) ||
    (input.expectedContentSize !== undefined && contentByteSize !== input.expectedContentSize)
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  return {
    fileId: input.file.id,
    mimeType: typeof input.file.mimeType === "string" ? input.file.mimeType : null,
    size: safeDriveFileSize(input.file) ?? contentByteSize,
    version,
    modifiedTime,
    contentSha256,
    fingerprintSource,
  };
}

async function verifyDriveArchive(input: {
  accessToken: string;
  folder: DriveFile;
  expectedParentId: string;
  sessionId: string;
  recordingByteSize: number | null;
  recordingName: string | null;
  recordingContentType: string | null;
  canonicalFileIds: Record<string, string>;
  expectedTranscript: Uint8Array;
  reportProgress: DriveSyncProgress;
  transcriptDuplicateId: string | null;
  recordingDuplicateProof: RecordingDuplicateProof | null;
  expectedContentHashes: Partial<Record<DriveArtifactKey, string>>;
  expectedContentSizes: Partial<Record<DriveArtifactKey, number>>;
  sharingRisk: DriveSharingRisk;
}) {
  const fields = "id,name,mimeType,version,modifiedTime,trashed,parents,appProperties,webViewLink,permissions(type,role,allowFileDiscovery)";
  const folder = await driveJson<DriveFile & { trashed?: boolean }>(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(input.folder.id)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
    input.accessToken,
  );
  if (
    folder.id !== input.folder.id ||
    folder.mimeType !== FOLDER_MIME_TYPE ||
    folder.trashed === true ||
    folder.appProperties?.tokyoDogsInterviewSession !== input.sessionId
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  const location = await verifyCandidateFolderLocation({
    accessToken: input.accessToken,
    folder,
    sessionId: input.sessionId,
    canonicalMonthId: input.expectedParentId,
  });
  if (location.canonicalMonthId !== input.expectedParentId) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  const folderVersion = safeDriveVersion(folder);
  const folderModifiedTime = safeDriveModifiedTime(folder);
  const required = ["transcript", "evaluation_json", "report_doc", "report_pdf", "manifest"];
  if (input.recordingByteSize !== null) required.push("recording");

  const firstFiles = await listFolderChildren(input.accessToken, folder.id);
  const firstByArtifact = indexDriveArtifacts(firstFiles);
  let transcriptDuplicate: DriveFile | null = null;
  let recordingDuplicate: DriveFile | null = null;
  for (const artifactKey of required) {
    const canonicalFileId = input.canonicalFileIds[artifactKey];
    const taggedFiles = firstByArtifact.get(artifactKey) ?? [];
    const canonicalFiles = taggedFiles.filter((file) => file.id === canonicalFileId);
    if (
      !canonicalFileId ||
      canonicalFiles.length !== 1 ||
      canonicalFiles[0].trashed === true ||
      !exactDriveParent(canonicalFiles[0], folder.id) ||
      canonicalFiles[0].appProperties?.tokyoDogsArtifact !== artifactKey ||
      canonicalFiles[0].appProperties?.tokyoDogsProvider !== DRIVE_PROVIDER
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    const extras = taggedFiles.filter((file) => file.id !== canonicalFileId);
    if (extras.length > 0) {
      // Only one exact duplicate of the small transcript can be proven safe to
      // quarantine. Other Drive artifact types may encode different content or
      // be expensive to download, so they remain fail-closed for manual review.
      if (artifactKey === "recording") {
        if (
          taggedFiles.length !== 2 || extras.length !== 1 ||
          !input.recordingDuplicateProof ||
          input.recordingDuplicateProof.canonicalId !== canonicalFileId ||
          input.recordingDuplicateProof.duplicateId !== extras[0].id
        ) {
          throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
        }
        recordingDuplicate = extras[0];
        continue;
      }
      if (artifactKey !== "transcript" || taggedFiles.length !== 2 || extras.length !== 1) {
        throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
      }
      if (extras[0].trashed === true || !exactDriveParent(extras[0], folder.id)) {
        throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
      }
      if (!input.transcriptDuplicateId || extras[0].id !== input.transcriptDuplicateId) {
        throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
      }
      transcriptDuplicate = extras[0];
    }
  }

  const recording = firstByArtifact.get("recording")?.find((file) =>
    file.id === input.canonicalFileIds.recording);
  if (
    input.recordingByteSize !== null &&
    (!recording?.size || Number(recording.size) !== input.recordingByteSize)
  ) {
    throw new Error("GOOGLE_DRIVE_RECORDING_SIZE_MISMATCH");
  }
  const plannedDuplicateAlreadyQuarantined = input.transcriptDuplicateId
    ? firstFiles.find((file) =>
      file.id === input.transcriptDuplicateId &&
      file.appProperties?.tokyoDogsArtifact === "legacy_duplicate_transcript" &&
      file.appProperties?.tokyoDogsLegacyArtifact === "transcript" &&
      file.trashed !== true && exactDriveParent(file, folder.id))
    : null;
  if (input.transcriptDuplicateId && !transcriptDuplicate && !plannedDuplicateAlreadyQuarantined) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const plannedRecordingAlreadyQuarantined = input.recordingDuplicateProof
    ? firstFiles.find((file) =>
      file.id === input.recordingDuplicateProof?.duplicateId &&
      file.appProperties?.tokyoDogsArtifact === "legacy_duplicate_recording" &&
      file.appProperties?.tokyoDogsLegacyArtifact === "recording" &&
      file.trashed !== true && exactDriveParent(file, folder.id))
    : null;
  if (
    input.recordingDuplicateProof && !recordingDuplicate &&
    !plannedRecordingAlreadyQuarantined
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }

  if (transcriptDuplicate) {
    const canonicalTranscript = firstByArtifact.get("transcript")?.find((file) =>
      file.id === input.canonicalFileIds.transcript);
    if (!canonicalTranscript || input.expectedTranscript.byteLength > 1024 * 1024) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    const [canonicalBytes, duplicateBytes] = await Promise.all([
      readSmallDriveFile({
        accessToken: input.accessToken,
        file: canonicalTranscript,
        maximumBytes: 1024 * 1024,
      }),
      readSmallDriveFile({
        accessToken: input.accessToken,
        file: transcriptDuplicate,
        maximumBytes: 1024 * 1024,
      }),
    ]);
    const [expectedHash, canonicalHash, duplicateHash] = await Promise.all([
      sha256Bytes(input.expectedTranscript),
      sha256Bytes(canonicalBytes),
      sha256Bytes(duplicateBytes),
    ]);
    if (
      canonicalBytes.byteLength !== input.expectedTranscript.byteLength ||
      duplicateBytes.byteLength !== input.expectedTranscript.byteLength ||
      canonicalHash !== expectedHash ||
      duplicateHash !== expectedHash
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    // Never delete an unexpected Drive file. Remove only its current artifact
    // identity so the canonical file remains the sole active receipt, while
    // retaining the original key and canonical ID as auditable appProperties.
    await input.reportProgress();
    const quarantined = await markLegacyDuplicateArtifact({
      accessToken: input.accessToken,
      fileId: transcriptDuplicate.id,
      artifactKey: "transcript",
    });
    if (
      quarantined.id !== transcriptDuplicate.id ||
      quarantined.trashed === true ||
      !quarantined.parents?.includes(folder.id) ||
      quarantined.appProperties?.tokyoDogsArtifact !== "legacy_duplicate_transcript" ||
      quarantined.appProperties?.tokyoDogsLegacyArtifact !== "transcript"
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
  }

  if (recordingDuplicate) {
    const canonicalRecording = firstByArtifact.get("recording")?.find((file) =>
      file.id === input.canonicalFileIds.recording);
    if (
      !canonicalRecording || input.recordingByteSize === null ||
      !input.recordingName || !input.recordingContentType
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    // Re-prove the complete recording pair immediately before the sole
    // metadata mutation. This detects bytes/size/tag/parent changes since the
    // finalizing preflight and makes the PATCH plan bound to immutable facts.
    const currentProof = await proveRecordingDuplicate({
      accessToken: input.accessToken,
      folderId: folder.id,
      canonical: canonicalRecording,
      duplicate: recordingDuplicate,
      expectedByteSize: input.recordingByteSize,
      expectedName: input.recordingName,
      expectedContentType: input.recordingContentType,
    });
    if (!sameRecordingDuplicateProof(currentProof, input.recordingDuplicateProof as RecordingDuplicateProof)) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    await input.reportProgress();
    const quarantined = await markLegacyDuplicateArtifact({
      accessToken: input.accessToken,
      fileId: recordingDuplicate.id,
      artifactKey: "recording",
      canonicalFileId: currentProof.canonicalId,
      duplicateSha256: currentProof.fingerprint,
    });
    if (
      quarantined.id !== recordingDuplicate.id ||
      quarantined.trashed === true ||
      !exactDriveParent(quarantined, folder.id) ||
      quarantined.appProperties?.tokyoDogsArtifact !== "legacy_duplicate_recording" ||
      quarantined.appProperties?.tokyoDogsLegacyArtifact !== "recording" ||
      quarantined.appProperties?.tokyoDogsCanonicalFileId !== currentProof.canonicalId ||
      quarantined.appProperties?.tokyoDogsDuplicateSha256 !== currentProof.fingerprint ||
      quarantined.appProperties?.tokyoDogsProvider !== DRIVE_PROVIDER ||
      quarantined.name !== recordingDuplicate.name ||
      quarantined.mimeType !== recordingDuplicate.mimeType ||
      safeDriveFileSize(quarantined) !== input.recordingByteSize ||
      quarantined.sha256Checksum !== recordingDuplicate.sha256Checksum
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
  }

  const verifiedFiles = transcriptDuplicate || recordingDuplicate
    ? await listFolderChildren(input.accessToken, folder.id)
    : firstFiles;
  const byArtifact = indexDriveArtifacts(verifiedFiles);
  for (const artifactKey of required) {
    const files = byArtifact.get(artifactKey) ?? [];
    if (files.length !== 1 || files[0].id !== input.canonicalFileIds[artifactKey]) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    if (files[0].trashed === true || !exactDriveParent(files[0], folder.id)) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    if (
      files[0].appProperties?.tokyoDogsArtifact !== artifactKey ||
      files[0].appProperties?.tokyoDogsProvider !== DRIVE_PROVIDER
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
  }
  if (input.transcriptDuplicateId) {
    const quarantined = verifiedFiles.find((file) => file.id === input.transcriptDuplicateId);
    if (
      !quarantined || quarantined.trashed === true ||
      !exactDriveParent(quarantined, folder.id) ||
      quarantined.appProperties?.tokyoDogsArtifact !== "legacy_duplicate_transcript" ||
      quarantined.appProperties?.tokyoDogsLegacyArtifact !== "transcript"
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
  }
  if (input.recordingDuplicateProof) {
    const quarantined = verifiedFiles.find((file) =>
      file.id === input.recordingDuplicateProof?.duplicateId);
    const canonical = (byArtifact.get("recording") ?? []).find((file) =>
      file.id === input.recordingDuplicateProof?.canonicalId);
    if (
      !quarantined || !canonical || quarantined.trashed === true || canonical.trashed === true ||
      !exactDriveParent(quarantined, folder.id) || !exactDriveParent(canonical, folder.id) ||
      quarantined.appProperties?.tokyoDogsArtifact !== "legacy_duplicate_recording" ||
      quarantined.appProperties?.tokyoDogsLegacyArtifact !== "recording" ||
      quarantined.appProperties?.tokyoDogsCanonicalFileId !== input.recordingDuplicateProof.canonicalId ||
      quarantined.appProperties?.tokyoDogsDuplicateSha256 !== input.recordingDuplicateProof.fingerprint ||
      safeDriveFileSize(quarantined) !== input.recordingDuplicateProof.byteSize ||
      safeDriveFileSize(canonical) !== input.recordingDuplicateProof.byteSize ||
      quarantined.sha256Checksum !== canonical.sha256Checksum
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
  }
  const files = Object.fromEntries(required.map((key) => {
    const file = byArtifact.get(key)?.[0] as DriveFile;
    return [key, fileSummary(file, file.name || key)];
  }));
  const integrityEntries = await Promise.all(required.map(async (key) => {
    const artifactKey = key as DriveArtifactKey;
    const file = byArtifact.get(key)?.[0] as DriveFile;
    return [artifactKey, await readArtifactIntegrityReceipt({
      accessToken: input.accessToken,
      artifactKey,
      file,
      expectedContentHash: input.expectedContentHashes[artifactKey],
      expectedContentSize: input.expectedContentSizes[artifactKey],
    })] as const;
  }));
  return {
    files,
    integrity: {
      schemaVersion: "2026-08-14-v1",
      status: "verified",
      checkedAt: new Date().toISOString(),
      errorCode: null,
      sharingRisk: highestSharingRisk([
        input.sharingRisk,
        sharingRiskFromPermissions(folder.permissions),
        ...required.map((key) => sharingRiskFromPermissions(
          (byArtifact.get(key)?.[0] as DriveFile | undefined)?.permissions,
        )),
      ]),
      folder: {
        fileId: folder.id,
        parentId: input.expectedParentId,
        version: folderVersion,
        modifiedTime: folderModifiedTime,
      },
      artifacts: Object.fromEntries(integrityEntries),
    } satisfies GoogleDriveArchiveIntegrity,
  };
}

function receiptFileId(
  files: Record<string, unknown>,
  artifactKey: DriveArtifactKey,
) {
  const aliases: Record<DriveArtifactKey, string[]> = {
    transcript: ["transcript"],
    evaluation_json: ["evaluation_json", "evaluation"],
    report_doc: ["report_doc", "reportDocument"],
    report_pdf: ["report_pdf", "reportPdf"],
    manifest: ["manifest"],
    recording: ["recording"],
  };
  for (const alias of aliases[artifactKey]) {
    const value = files[alias];
    if (!value || typeof value !== "object") continue;
    const id = (value as Record<string, unknown>).fileId ?? (value as Record<string, unknown>).id;
    if (typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id)) return id;
  }
  return null;
}

export function googleDriveIntegrityReceiptsMatch(
  stored: GoogleDriveArchiveIntegrity,
  observed: GoogleDriveArchiveIntegrity,
) {
  if (
    stored.folder.fileId !== observed.folder.fileId ||
    stored.folder.parentId !== observed.folder.parentId ||
    stored.folder.version !== observed.folder.version ||
    stored.folder.modifiedTime !== observed.folder.modifiedTime
  ) return false;
  const storedKeys = Object.keys(stored.artifacts).sort();
  const observedKeys = Object.keys(observed.artifacts).sort();
  if (storedKeys.join("\0") !== observedKeys.join("\0")) return false;
  return storedKeys.every((key) => {
    const artifactKey = key as DriveArtifactKey;
    const left = stored.artifacts[artifactKey];
    const right = observed.artifacts[artifactKey];
    return Boolean(
      left && right &&
      left.fileId === right.fileId &&
      left.mimeType === right.mimeType &&
      left.size === right.size &&
      left.version === right.version &&
      left.modifiedTime === right.modifiedTime &&
      left.contentSha256 === right.contentSha256 &&
      left.fingerprintSource === right.fingerprintSource,
    );
  });
}

export function googleDriveRecordingReceiptCanBeReused(input: {
  stored: GoogleDriveArchiveIntegrity;
  observed: GoogleDriveArchiveIntegrity;
  sourceByteSize: number;
  sourceContentType: string;
}) {
  if (!googleDriveIntegrityReceiptsMatch(input.stored, input.observed)) return false;
  const stored = input.stored.artifacts.recording;
  const observed = input.observed.artifacts.recording;
  return Boolean(
    stored && observed &&
    stored.fileId === observed.fileId &&
    stored.size === input.sourceByteSize &&
    observed.size === input.sourceByteSize &&
    stored.mimeType === input.sourceContentType &&
    observed.mimeType === input.sourceContentType &&
    stored.fingerprintSource === "sha256Checksum" &&
    observed.fingerprintSource === "sha256Checksum" &&
    stored.contentSha256 === observed.contentSha256 &&
    stored.version === observed.version &&
    stored.modifiedTime === observed.modifiedTime,
  );
}

export function googleDriveIntegrityFailureStatus(error: unknown) {
  const code = safeErrorCode(error);
  if (
    code === "GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH" ||
    code === "GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH" ||
    code === DRIVE_RECORDING_MISSING_CODE ||
    code === DRIVE_RECORDING_MOVED_CODE ||
    code === DRIVE_RECORDING_TRASHED_CODE ||
    code === "GOOGLE_DRIVE_RECORDING_SIZE_MISMATCH" ||
    code === "GOOGLE_DRIVE_CLASSIFICATION_FOLDER_DUPLICATE" ||
    code === "GOOGLE_DRIVE_API_404" ||
    code === "GOOGLE_DRIVE_API_410"
  ) return "drift" as const;
  return "unknown" as const;
}

/**
 * Performs only bounded Drive reads. The caller owns cooldown/claim persistence
 * and must keep the original receipt when this snapshot differs or fails.
 */
export async function readGoogleDriveArchiveIntegritySnapshot(input: {
  sessionId: string;
  folderId: string;
  files: Record<string, unknown>;
  recordingIncluded: boolean;
  previous?: GoogleDriveArchiveIntegrity;
  accessToken?: string;
}) : Promise<GoogleDriveArchiveIntegrity> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.folderId)) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  const accessToken = input.accessToken ?? await fetchGoogleDriveAccessToken();
  const fields = "id,name,mimeType,version,modifiedTime,trashed,parents,appProperties,permissions(type,role,allowFileDiscovery)";
  const folder = await driveJson<DriveFile>(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(input.folderId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
    accessToken,
  );
  if (
    folder.id !== input.folderId ||
    folder.mimeType !== FOLDER_MIME_TYPE ||
    folder.trashed === true ||
    folder.appProperties?.tokyoDogsInterviewSession !== input.sessionId
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  let location;
  try {
    location = await verifyCandidateFolderLocation({
      accessToken,
      folder,
      sessionId: input.sessionId,
      canonicalMonthId: input.previous?.folder.parentId,
    });
  } catch (error) {
    // A receipt produced before this compatibility change may itself contain
    // 合格/不合格 as the stored parent. Resolve its month only when a later
    // human move changes the parent again. All duplicate/location errors stay
    // fail-closed and are never reinterpreted.
    if (
      !input.previous ||
      safeErrorCode(error) !== "GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH"
    ) throw error;
    const canonicalMonthId = await canonicalMonthFromStoredParent(
      accessToken,
      input.previous.folder.parentId,
    );
    if (canonicalMonthId === input.previous.folder.parentId) throw error;
    location = await verifyCandidateFolderLocation({
      accessToken,
      folder,
      sessionId: input.sessionId,
      canonicalMonthId,
    });
  }
  const parentId = input.previous?.folder.parentId ?? location.canonicalMonthId;
  const required: DriveArtifactKey[] = [
    "transcript", "evaluation_json", "report_doc", "report_pdf", "manifest",
  ];
  if (input.recordingIncluded) required.push("recording");
  const children = await listFolderChildren(accessToken, folder.id);
  const byArtifact = indexDriveArtifacts(children);
  const canonicalFiles = new Map<DriveArtifactKey, DriveFile>();
  for (const artifactKey of required) {
    const storedId = receiptFileId(input.files, artifactKey);
    const previousId = input.previous?.artifacts[artifactKey]?.fileId ?? null;
    if (storedId && previousId && storedId !== previousId) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    const expectedId = previousId ?? storedId;
    const matches = byArtifact.get(artifactKey) ?? [];
    if (artifactKey === "recording" && expectedId && matches.length === 0) {
      throw new Error(DRIVE_RECORDING_MISSING_CODE);
    }
    if (
      !expectedId || matches.length !== 1 || matches[0].id !== expectedId ||
      matches[0].trashed === true || !exactDriveParent(matches[0], folder.id) ||
      matches[0].appProperties?.tokyoDogsArtifact !== artifactKey ||
      matches[0].appProperties?.tokyoDogsProvider !== DRIVE_PROVIDER
    ) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    canonicalFiles.set(artifactKey, matches[0]);
  }
  const artifactEntries = await Promise.all(required.map(async (artifactKey) => [
    artifactKey,
    await readArtifactIntegrityReceipt({
      accessToken,
      artifactKey,
      file: canonicalFiles.get(artifactKey) as DriveFile,
    }),
  ] as const));
  return {
    schemaVersion: "2026-08-14-v1",
    status: "verified",
    checkedAt: new Date().toISOString(),
    errorCode: null,
    sharingRisk: highestSharingRisk([
      sharingRiskFromPermissions(folder.permissions),
      ...required.map((key) => sharingRiskFromPermissions(canonicalFiles.get(key)?.permissions)),
    ]),
    folder: {
      fileId: folder.id,
      parentId,
      // A staff classification move changes only the candidate folder's
      // parent/version/modifiedTime. Preserve the original folder receipt in
      // that one explicitly allowed case while still re-reading and hashing
      // every archived artifact below it.
      version: location.manuallyClassified && input.previous
        ? input.previous.folder.version
        : safeDriveVersion(folder),
      modifiedTime: location.manuallyClassified && input.previous
        ? input.previous.folder.modifiedTime
        : safeDriveModifiedTime(folder),
    },
    artifacts: Object.fromEntries(artifactEntries),
  };
}

function storedGoogleDriveIntegrity(value: unknown): GoogleDriveArchiveIntegrity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as Partial<GoogleDriveArchiveIntegrity>;
  if (
    receipt.schemaVersion !== "2026-08-14-v1" ||
    !["verified", "drift", "unknown"].includes(String(receipt.status)) ||
    typeof receipt.checkedAt !== "string" ||
    !receipt.folder || typeof receipt.folder !== "object" ||
    typeof receipt.folder.fileId !== "string" ||
    typeof receipt.folder.parentId !== "string" ||
    typeof receipt.folder.version !== "string" ||
    typeof receipt.folder.modifiedTime !== "string" ||
    !receipt.artifacts || typeof receipt.artifacts !== "object"
  ) return undefined;
  return receipt as GoogleDriveArchiveIntegrity;
}

export async function revalidateCompletedGoogleDriveArchive(sessionId: string) {
  const claim = await claimExternalSyncIntegrityCheck(sessionId);
  if (!claim) return null;
  const files = claim.manifest.files && typeof claim.manifest.files === "object" &&
    !Array.isArray(claim.manifest.files)
    ? claim.manifest.files as Record<string, unknown>
    : {};
  const previous = storedGoogleDriveIntegrity(claim.manifest.integrity);
  const recordingIncluded = claim.manifest.recordingIncluded === true;
  try {
    const observed = await readGoogleDriveArchiveIntegritySnapshot({
      sessionId,
      folderId: claim.folderId,
      files,
      recordingIncluded,
      previous,
    });
    const matches = !previous || googleDriveIntegrityReceiptsMatch(previous, observed);
    const integrity = previous
      ? {
          ...previous,
          status: matches ? "verified" as const : "drift" as const,
          checkedAt: observed.checkedAt,
          errorCode: matches ? null : "GOOGLE_DRIVE_ARCHIVE_INTEGRITY_DRIFT",
          sharingRisk: observed.sharingRisk === "unknown"
            ? previous.sharingRisk
            : observed.sharingRisk,
        }
      : observed;
    await finishExternalSyncIntegrityCheck({
      claim,
      manifest: { ...claim.manifest, integrity },
    });
    return integrity;
  } catch (error) {
    const status = googleDriveIntegrityFailureStatus(error);
    const checkedAt = new Date().toISOString();
    const sourceErrorCode = safeErrorCode(error);
    const errorCode = status === "drift"
      ? sourceErrorCode === DRIVE_RECORDING_MISSING_CODE || sourceErrorCode === DRIVE_RECORDING_MOVED_CODE
        ? sourceErrorCode
        : "GOOGLE_DRIVE_ARCHIVE_INTEGRITY_DRIFT"
      : sourceErrorCode;
    const integrity = previous
      ? { ...previous, status, checkedAt, errorCode }
      : {
          schemaVersion: "2026-08-14-v1",
          status,
          checkedAt,
          errorCode,
          sharingRisk: "unknown",
          folder: null,
          artifacts: {},
        };
    await finishExternalSyncIntegrityCheck({
      claim,
      manifest: { ...claim.manifest, integrity },
    });
    return integrity;
  }
}

/**
 * Reports progress on the claim and confirms this worker still owns it. Called
 * before every Drive write so a worker whose claim was reclaimed as stale stops
 * before creating a second copy of a file in the candidate folder.
 */
type DriveSyncProgress = () => Promise<void>;

const DRIVE_CLAIM_HEARTBEAT_INTERVAL_MS = 60_000;

function startDriveClaimHeartbeat(sessionId: string, startedAt: string) {
  let stopped = false;
  let failure: unknown = null;
  let inFlight = Promise.resolve();

  const pulse = () => {
    inFlight = inFlight.then(async () => {
      if (stopped || failure) return;
      if (!await heartbeatExternalSync(sessionId, startedAt)) {
        throw new Error("GOOGLE_DRIVE_SYNC_CLAIM_LOST");
      }
    }).catch((error) => {
      failure = error;
    });
  };

  const timer = setInterval(pulse, DRIVE_CLAIM_HEARTBEAT_INTERVAL_MS);
  return {
    reportProgress: async () => {
      await inFlight;
      if (failure) throw failure;
      if (!await heartbeatExternalSync(sessionId, startedAt)) {
        failure = new Error("GOOGLE_DRIVE_SYNC_CLAIM_LOST");
        throw failure;
      }
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      if (failure) throw failure;
    },
  };
}

async function performDriveSync(
  source: ArchiveSource,
  reportProgress: DriveSyncProgress,
): Promise<GoogleDriveSyncResult> {
  assertArchiveReady(source);
  await reportProgress();
  const accessToken = await fetchGoogleDriveAccessToken();
  const prepared = await prepareDriveArchive(source, accessToken, reportProgress);
  let recordingFile: DriveFile | null = null;
  if (source.recording) {
    await reportProgress();
    const extension = source.recording.contentType.includes("mp4") ? "mp4" : "webm";
    recordingFile = await uploadRecording({
      accessToken,
      folderId: prepared.candidateFolder.id,
      name: `${source.sessionId}_面接録画.${extension}`,
      contentType: source.recording.contentType,
      byteSize: source.recording.byteSize,
      sessionId: source.sessionId,
      targetFileId: prepared.artifactTargetIds.recording,
    });
  }
  return finalizeDriveArchive(source, accessToken, prepared, recordingFile, reportProgress);
}

function assertArchiveReady(source: ArchiveSource) {
  if (source.auditEvents.some((event) => [
    "candidate_requested_stop",
    "safety_escalation",
    "completion_reason_invalid",
  ].includes(event.type))) {
    throw new Error("INTERVIEW_NOT_READY_FOR_DRIVE_SYNC");
  }
  if (isTechnicalEvidenceArchiveSource(source)) return;
  if (source.status !== "completed" || !source.evaluation) {
    throw new Error("INTERVIEW_NOT_READY_FOR_DRIVE_SYNC");
  }
  // A camera/microphone interview is not archive-ready until its recording
  // artifact is durable. Previously evaluation completion raced recording
  // finalization, permanently marking a five-file, video-less Drive archive as
  // completed before the final recording part had been committed.
  if (source.recordingStatus !== "stored" && source.recordingStatus !== "not_applicable") {
    throw new Error("INTERVIEW_RECORDING_NOT_READY_FOR_DRIVE_SYNC");
  }
  if (source.recordingStatus === "stored" && !source.recording) {
    throw new Error("INTERVIEW_RECORDING_ARTIFACT_MISSING");
  }
  if (!hasActualCandidateTranscript(source)) {
    throw new Error("INTERVIEW_TRANSCRIPT_NOT_READY_FOR_DRIVE_SYNC");
  }
}

async function prepareDriveArchive(
  source: ArchiveSource,
  accessToken: string,
  reportProgress: DriveSyncProgress,
): Promise<PreparedDriveArchive> {
  const root = await validateGoogleDriveRoot(accessToken);
  const date = new Date(source.completedAt || source.createdAt);
  if (!Number.isFinite(date.getTime())) throw new Error("INTERVIEW_DATE_INVALID");
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? String(date.getUTCFullYear());
  const month = parts.find((part) => part.type === "month")?.value ?? String(date.getUTCMonth() + 1).padStart(2, "0");
  const yearFolder = await ensureCanonicalHierarchyFolder({
    accessToken,
    nodeKey: `year:${root.id}:${year}`,
    parentId: root.id,
    name: year,
    propertyKey: "tokyoDogsInterviewYear",
    propertyValue: year,
    reportProgress,
  });
  const monthKey = `${year}-${month}`;
  const monthFolder = await ensureCanonicalHierarchyFolder({
    accessToken,
    nodeKey: `month:${yearFolder.id}:${monthKey}`,
    parentId: yearFolder.id,
    name: month,
    propertyKey: "tokyoDogsInterviewMonth",
    propertyValue: monthKey,
    reportProgress,
  });
  await reportProgress();
  const existingSync = await getExternalSyncStatus(source.sessionId);
  const candidateFolder = await resolveCandidateArchiveFolder({
    accessToken,
    canonicalMonthId: monthFolder.id,
    sessionId: source.sessionId,
    name: `${safeFolderSegment(source.candidateName)}_${source.sessionId}`,
    trustedFolderId: existingSync?.folderId,
  });
  const transcript = buildTranscriptText(source);
  // assertArchiveReady() runs before any Drive access. Recompute here for the
  // persisted receipt so a future refactor cannot accidentally label a
  // placeholder/interviewer-only transcript as an actual candidate transcript.
  const transcriptKind = archiveTranscriptKind(source);
  const transcriptAvailable = transcriptKind === "actual_transcript" ||
    transcriptKind === TECHNICAL_EVIDENCE_TRANSCRIPT_KIND;
  const resultJson = buildResultJson(source);
  const reportHtml = buildReportHtml(source);
  const transcriptBytes = new TextEncoder().encode(transcript);
  const resultJsonBytes = new TextEncoder().encode(resultJson);
  const filePrefix = source.sessionId;
  const recordingExtension = source.recording?.contentType.includes("mp4") ? "mp4" : "webm";
  const expectedRecordingName = source.recording
    ? `${source.sessionId}_面接録画.${recordingExtension}`
    : null;
  const uploaded: GoogleDriveSyncResult["uploaded"] = {};
  // Resolve every existing artifact before the first content upload. This
  // prevents an unordered Drive search from overwriting an arbitrary duplicate
  // before we have proved that the folder is safe to repair.
  await reportProgress();
  const preflight = await preflightDriveArchive({
    accessToken,
    folderId: candidateFolder.id,
    recordingIncluded: Boolean(source.recording),
    expectedRecordingByteSize: source.recording?.byteSize ?? null,
    expectedRecordingName,
    expectedRecordingContentType: source.recording?.contentType ?? null,
    expectedTranscript: transcriptBytes,
  });
  await reportProgress();
  const transcriptFileName = transcriptKind === TECHNICAL_EVIDENCE_TRANSCRIPT_KIND
    ? `${filePrefix}_技術保留_受領済み文字起こし_人手確認必須.txt`
    : transcriptAvailable
    ? `${filePrefix}_文字起こし.txt`
    : `${filePrefix}_録画式面接_質問記録_文字起こし未実施.txt`;
  const transcriptFile = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: transcriptFileName,
    artifactKey: "transcript",
    contentType: "text/plain; charset=utf-8",
    body: transcript,
    targetFileId: preflight.artifactTargetIds.transcript,
  });
  uploaded.transcript = fileSummary(transcriptFile, transcriptFileName);
  preflight.artifactTargetIds.transcript = transcriptFile.id;
  await reportProgress();
  const resultFile = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: `${filePrefix}_評価データ.json`,
    artifactKey: "evaluation_json",
    contentType: "application/json; charset=utf-8",
    body: resultJson,
    targetFileId: preflight.artifactTargetIds.evaluation_json,
  });
  uploaded.evaluation = fileSummary(resultFile, `${filePrefix}_評価データ.json`);
  preflight.artifactTargetIds.evaluation_json = resultFile.id;
  await reportProgress();
  const reportDoc = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: `${filePrefix}_オンライン一次面接レポート`,
    artifactKey: "report_doc",
    contentType: "text/html; charset=utf-8",
    body: reportHtml,
    googleMimeType: GOOGLE_DOC_MIME_TYPE,
    targetFileId: preflight.artifactTargetIds.report_doc,
  });
  uploaded.reportDocument = fileSummary(reportDoc, `${filePrefix}_オンライン一次面接レポート`);
  preflight.artifactTargetIds.report_doc = reportDoc.id;
  await reportProgress();
  const pdf = await exportGoogleDocToPdf(accessToken, reportDoc.id);
  const [transcriptHash, resultJsonHash, reportPdfHash] = await Promise.all([
    sha256Bytes(transcriptBytes),
    sha256Bytes(resultJsonBytes),
    sha256Bytes(pdf),
  ]);
  await reportProgress();
  const reportPdf = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: `${filePrefix}_オンライン一次面接レポート.pdf`,
    artifactKey: "report_pdf",
    contentType: "application/pdf",
    body: pdf,
    targetFileId: preflight.artifactTargetIds.report_pdf,
  });
  uploaded.reportPdf = fileSummary(reportPdf, `${filePrefix}_オンライン一次面接レポート.pdf`);
  preflight.artifactTargetIds.report_pdf = reportPdf.id;
  return {
    rootFolderId: root.id,
    expectedParentId: monthFolder.id,
    candidateFolder,
    folderUrl: candidateFolder.webViewLink || `https://drive.google.com/drive/folders/${candidateFolder.id}`,
    uploaded,
    artifactTargetIds: preflight.artifactTargetIds,
    transcriptDuplicateId: preflight.transcriptDuplicateId,
    recordingDuplicateProof: preflight.recordingDuplicateProof,
    transcriptAvailable,
    transcriptKind,
    expectedContentHashes: {
      transcript: transcriptHash,
      evaluation_json: resultJsonHash,
      report_pdf: reportPdfHash,
    },
    expectedContentSizes: {
      transcript: transcriptBytes.byteLength,
      evaluation_json: resultJsonBytes.byteLength,
      report_pdf: pdf.byteLength,
    },
    sharingRisk: root.sharingRisk,
  };
}

async function finalizeDriveArchive(
  source: ArchiveSource,
  accessToken: string,
  prepared: PreparedDriveArchive,
  recordingFile: DriveFile | null,
  reportProgress: DriveSyncProgress,
  persistPreparedContext?: (prepared: PreparedDriveArchive) => Promise<void>,
): Promise<GoogleDriveSyncResult> {
  const uploaded = { ...prepared.uploaded };
  const filePrefix = source.sessionId;
  if (source.recording) {
    if (!recordingFile) throw new Error("GOOGLE_DRIVE_RESUMABLE_UPLOAD_INCOMPLETE");
    const extension = source.recording.contentType.includes("mp4") ? "mp4" : "webm";
    const expectedRecordingName = `${filePrefix}_面接録画.${extension}`;
    if (!recordingFileMatchesTrustedUpload({
      file: recordingFile,
      folderId: prepared.candidateFolder.id,
      name: expectedRecordingName,
      contentType: source.recording.contentType,
      byteSize: source.recording.byteSize,
    })) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    if (prepared.artifactTargetIds.recording && recordingFile.id !== prepared.artifactTargetIds.recording) {
      throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    }
    uploaded.recording = fileSummary(recordingFile, expectedRecordingName);
    prepared.expectedContentSizes.recording = source.recording.byteSize;
  }
  // A stored upload step may predate artifact-target persistence, and the
  // folder can change while a multi-request recording upload is in flight.
  // Re-run the read-only preflight before the manifest write and trust only the
  // exact file IDs already returned by Drive for this run.
  await reportProgress();
  const refreshed = await preflightDriveArchive({
    accessToken,
    folderId: prepared.candidateFolder.id,
    recordingIncluded: Boolean(source.recording),
    expectedRecordingByteSize: source.recording?.byteSize ?? null,
    expectedRecordingName: source.recording
      ? `${source.sessionId}_面接録画.${source.recording.contentType.includes("mp4") ? "mp4" : "webm"}`
      : null,
    expectedRecordingContentType: source.recording?.contentType ?? null,
    expectedTranscript: new TextEncoder().encode(buildTranscriptText(source)),
    trustedTargetIds: {
      transcript: uploaded.transcript.id,
      evaluation_json: uploaded.evaluation.id,
      report_doc: uploaded.reportDocument.id,
      report_pdf: uploaded.reportPdf.id,
      recording: uploaded.recording?.id,
      manifest: prepared.artifactTargetIds.manifest,
    },
    expectedDuplicateId: prepared.transcriptDuplicateId,
  });
  prepared.artifactTargetIds = refreshed.artifactTargetIds;
  prepared.transcriptDuplicateId = refreshed.transcriptDuplicateId;
  prepared.recordingDuplicateProof = refreshed.recordingDuplicateProof;
  if (prepared.recordingDuplicateProof) {
    if (!persistPreparedContext) {
      throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_CONTEXT_INVALID");
    }
    // The exact canonical/duplicate IDs, byte size, and full-content proof must
    // survive a lost Drive PATCH response. Persist this plan under the current
    // D1 lease before the manifest or duplicate metadata can be written.
    await persistPreparedContext(prepared);
  }
  const manifest = {
    schemaVersion: "2026-08-23-v2",
    reportPresentationVersion: INTERVIEW_REPORT_PRESENTATION_VERSION,
    generatedAt: new Date().toISOString(),
    sessionId: source.sessionId,
    rootFolderId: prepared.rootFolderId,
    folderId: prepared.candidateFolder.id,
    recordingIncluded: Boolean(source.recording),
    transcriptAvailable: prepared.transcriptAvailable,
    transcriptKind: prepared.transcriptKind,
    technicalHold: prepared.transcriptKind === TECHNICAL_EVIDENCE_TRANSCRIPT_KIND,
    automaticEvaluationPerformed: source.evaluation !== null,
    files: uploaded,
    recordingRepairHistory: prepared.recordingRepairHistory,
  };
  const manifestBody = JSON.stringify(manifest, null, 2);
  const manifestBytes = new TextEncoder().encode(manifestBody);
  prepared.expectedContentHashes.manifest = await sha256Bytes(manifestBytes);
  prepared.expectedContentSizes.manifest = manifestBytes.byteLength;
  await reportProgress();
  const manifestFile = await uploadSmallFile({
    accessToken,
    folderId: prepared.candidateFolder.id,
    name: `${filePrefix}_格納結果.json`,
    artifactKey: "manifest",
    contentType: "application/json; charset=utf-8",
    body: manifestBody,
    // `null` means the preflight saw no manifest. If a previous finalization
    // POST reached Drive but its response was lost, re-resolve a single exact
    // artifact instead of blindly POSTing a duplicate. findArtifact fails
    // closed when more than one active manifest exists.
    targetFileId: prepared.artifactTargetIds.manifest ?? undefined,
  });
  uploaded.manifest = fileSummary(manifestFile, `${filePrefix}_格納結果.json`);
  prepared.artifactTargetIds.manifest = manifestFile.id;
  const canonicalFileIds: Record<string, string> = {
    transcript: uploaded.transcript.id,
    evaluation_json: uploaded.evaluation.id,
    report_doc: uploaded.reportDocument.id,
    report_pdf: uploaded.reportPdf.id,
    manifest: uploaded.manifest.id,
  };
  if (uploaded.recording) canonicalFileIds.recording = uploaded.recording.id;
  await reportProgress();
  const verified = await verifyDriveArchive({
    accessToken,
    folder: prepared.candidateFolder,
    expectedParentId: prepared.expectedParentId,
    sessionId: source.sessionId,
    recordingByteSize: source.recording?.byteSize ?? null,
    recordingName: source.recording
      ? `${source.sessionId}_面接録画.${source.recording.contentType.includes("mp4") ? "mp4" : "webm"}`
      : null,
    recordingContentType: source.recording?.contentType ?? null,
    canonicalFileIds,
    expectedTranscript: new TextEncoder().encode(buildTranscriptText(source)),
    reportProgress,
    transcriptDuplicateId: prepared.transcriptDuplicateId,
    recordingDuplicateProof: prepared.recordingDuplicateProof,
    expectedContentHashes: prepared.expectedContentHashes,
    expectedContentSizes: prepared.expectedContentSizes,
    sharingRisk: prepared.sharingRisk,
  });
  return {
    status: "completed",
    folderId: prepared.candidateFolder.id,
    folderUrl: prepared.folderUrl,
    uploaded: verified.files,
    recordingIncluded: Boolean(source.recording),
    transcriptAvailable: prepared.transcriptAvailable,
    transcriptKind: prepared.transcriptKind,
    reportPresentationVersion: INTERVIEW_REPORT_PRESENTATION_VERSION,
    integrity: verified.integrity,
  };
}

async function syncInterviewToGoogleDriveOnce(sessionId: string): Promise<GoogleDriveSyncResult> {
  await requestExternalSync(sessionId);
  let lastCompleted: GoogleDriveSyncResult | null = null;
  for (let pass = 0; pass < 2; pass += 1) {
    const startedAt = await claimExternalSync(sessionId);
    if (!startedAt) {
      const current = await getExternalSyncStatus(sessionId);
      if (current?.status === "completed" && current.folderId && current.folderUrl) {
        return {
          status: "completed",
          folderId: current.folderId,
          folderUrl: current.folderUrl,
          uploaded: (current.manifest?.files ?? {}) as GoogleDriveSyncResult["uploaded"],
          recordingIncluded: current.manifest?.recordingIncluded === true,
          transcriptAvailable: current.manifest?.transcriptAvailable === true,
          transcriptKind: typeof current.manifest?.transcriptKind === "string" ? current.manifest.transcriptKind : "unknown",
          reportPresentationVersion: typeof current.manifest?.reportPresentationVersion === "string"
            ? current.manifest.reportPresentationVersion
            : "unknown",
          integrity: current.manifest?.integrity as GoogleDriveArchiveIntegrity | undefined,
        };
      }
      throw new Error("GOOGLE_DRIVE_SYNC_ALREADY_RUNNING");
    }
    const claimHeartbeat = startDriveClaimHeartbeat(sessionId, startedAt);
    try {
      const source = await getInterviewArchiveSource(sessionId);
      if (!source) throw new Error("INTERVIEW_NOT_FOUND");
      lastCompleted = await performDriveSync(source, claimHeartbeat.reportProgress);
      await claimHeartbeat.stop();
      const retryRequested = await completeExternalSync({
        sessionId,
        startedAt,
        folderId: lastCompleted.folderId,
        folderUrl: lastCompleted.folderUrl,
        manifest: {
          files: lastCompleted.uploaded,
          recordingIncluded: lastCompleted.recordingIncluded,
          transcriptAvailable: lastCompleted.transcriptAvailable,
          transcriptKind: lastCompleted.transcriptKind,
          reportPresentationVersion: lastCompleted.reportPresentationVersion,
          integrity: lastCompleted.integrity,
        },
      });
      if (!retryRequested) return lastCompleted;
    } catch (error) {
      await claimHeartbeat.stop().catch(() => undefined);
      await failExternalSync({ sessionId, startedAt, errorCode: safeErrorCode(error) });
      throw error;
    }
  }
  if (lastCompleted) return { ...lastCompleted, status: "pending" };
  throw new Error("GOOGLE_DRIVE_SYNC_DEFERRED");
}

export type GoogleDriveArchiveStepResult = GoogleDriveSyncResult | {
  status: "pending";
  phase: "initializing" | "uploading" | "finalizing" | "busy" | "retrying";
  folderId: string | null;
  folderUrl: string | null;
  recordingIncluded: boolean;
  committedOffset: number;
  totalBytes: number;
  retryAfterMs: number;
};

function completedResultFromStatus(status: NonNullable<Awaited<ReturnType<typeof getExternalSyncStatus>>>) {
  if (status.status !== "completed" || !status.folderId || !status.folderUrl) return null;
  return {
    status: "completed" as const,
    folderId: status.folderId,
    folderUrl: status.folderUrl,
    uploaded: (status.manifest?.files ?? {}) as GoogleDriveSyncResult["uploaded"],
    recordingIncluded: status.manifest?.recordingIncluded === true,
    transcriptAvailable: status.manifest?.transcriptAvailable === true,
    transcriptKind: typeof status.manifest?.transcriptKind === "string" ? status.manifest.transcriptKind : "unknown",
    reportPresentationVersion: typeof status.manifest?.reportPresentationVersion === "string"
      ? status.manifest.reportPresentationVersion
      : "unknown",
    integrity: status.manifest?.integrity as GoogleDriveArchiveIntegrity | undefined,
  };
}

function completedReceiptSatisfiesSource(
  receipt: GoogleDriveSyncResult,
  source: ArchiveSource,
) {
  const expectedTranscriptKind = archiveTranscriptKind(source);
  const transcriptVerified = receipt.transcriptAvailable === true &&
    receipt.transcriptKind === expectedTranscriptKind &&
    (expectedTranscriptKind === "actual_transcript" ||
      expectedTranscriptKind === TECHNICAL_EVIDENCE_TRANSCRIPT_KIND);
  const recordingVerified = isTechnicalEvidenceArchiveSource(source)
    ? receipt.recordingIncluded === Boolean(source.recording)
    : source.recordingStatus === "not_applicable" ||
      (source.recordingStatus === "stored" && receipt.recordingIncluded === true);
  return transcriptVerified && recordingVerified;
}

function completedReceiptNeedsRecordingRepair(
  status: NonNullable<Awaited<ReturnType<typeof getExternalSyncStatus>>>,
  source: ArchiveSource,
) {
  if (source.recordingStatus !== "stored" || !source.recording) return false;
  if (status.manifest?.recordingIncluded !== true) return false;
  const integrity = storedGoogleDriveIntegrity(status.manifest?.integrity);
  return integrity?.status === "drift" &&
    integrity.errorCode === DRIVE_RECORDING_MISSING_CODE &&
    Boolean(integrity.artifacts.recording);
}

function sameDriveArtifactIntegrityReceipt(
  left: DriveArtifactIntegrityReceipt | undefined,
  right: DriveArtifactIntegrityReceipt | undefined,
) {
  return Boolean(
    left && right &&
    left.fileId === right.fileId &&
    left.mimeType === right.mimeType &&
    left.size === right.size &&
    left.version === right.version &&
    left.modifiedTime === right.modifiedTime &&
    left.contentSha256 === right.contentSha256 &&
    left.fingerprintSource === right.fingerprintSource,
  );
}

function verifiedSmallArtifactsUnchanged(
  stored: GoogleDriveArchiveIntegrity,
  observed: GoogleDriveArchiveIntegrity,
) {
  if (
    stored.folder.fileId !== observed.folder.fileId ||
    stored.folder.parentId !== observed.folder.parentId
  ) return false;
  const required: DriveArtifactKey[] = [
    "transcript", "evaluation_json", "report_doc", "report_pdf", "manifest",
  ];
  return required.every((key) =>
    sameDriveArtifactIntegrityReceipt(stored.artifacts[key], observed.artifacts[key]));
}

function driveManifestFiles(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Builds a recording-only repair plan without writing any of the four human
 * review artifacts. It is deliberately stricter than a normal archive:
 * every prior small-file receipt must still match, the old on-Drive manifest
 * must identify the same canonical recording, and no active recording or
 * same-named file may remain in the candidate folder. Moved and trashed files
 * are manual-attention conditions; replacement is allowed only after an
 * authenticated confirmation plus zero active/trash matches across Drive.
 */
async function prepareRecordingOnlyDriveRepair(input: {
  source: ArchiveSource;
  status: NonNullable<Awaited<ReturnType<typeof getExternalSyncStatus>>>;
  accessToken: string;
  reportProgress: DriveSyncProgress;
  confirmedMissingAcrossDrive: boolean;
}): Promise<PreparedDriveArchive> {
  const { source, status, accessToken, reportProgress } = input;
  if (
    !source.recording || source.recordingStatus !== "stored" ||
    !status.folderId || !status.folderUrl ||
    status.manifest?.recordingIncluded !== true
  ) {
    throw new Error("GOOGLE_DRIVE_RECORDING_REPAIR_SOURCE_INVALID");
  }
  const stored = storedGoogleDriveIntegrity(status.manifest.integrity);
  const files = driveManifestFiles(status.manifest.files);
  const storedRecording = stored?.artifacts.recording;
  const storedRecordingId = files ? receiptFileId(files, "recording") : null;
  if (
    !stored || stored.status !== "drift" || !files || !storedRecording ||
    storedRecordingId !== storedRecording.fileId ||
    storedRecording.size !== source.recording.byteSize ||
    storedRecording.mimeType !== source.recording.contentType ||
    storedRecording.fingerprintSource !== "sha256Checksum"
  ) {
    throw new Error("GOOGLE_DRIVE_RECORDING_REPAIR_RECEIPT_INVALID");
  }

  await reportProgress();
  const candidateFolder = await getDriveFolderById(accessToken, status.folderId);
  if (
    candidateFolder.id !== status.folderId ||
    candidateFolder.mimeType !== FOLDER_MIME_TYPE ||
    candidateFolder.trashed === true ||
    candidateFolder.appProperties?.tokyoDogsInterviewSession !== source.sessionId
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  const expectedName = `${source.sessionId}_面接録画.${source.recording.contentType.includes("mp4") ? "mp4" : "webm"}`;
  await reportProgress();
  const children = await listFolderChildren(accessToken, status.folderId);
  const activeRecordingCandidates = children.filter((file) =>
    file.name === expectedName ||
    ["recording", "legacy_duplicate_recording"].includes(
      file.appProperties?.tokyoDogsArtifact ?? "",
    ));
  if (activeRecordingCandidates.length > 0) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }

  let oldRecording: DriveFile | null = null;
  let oldRecordingReadErrorCode: string | null = null;
  try {
    oldRecording = await driveJson<DriveFile>(
      `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(storedRecording.fileId)}` +
      `?supportsAllDrives=true&fields=${encodeURIComponent("id,name,mimeType,size,sha256Checksum,version,modifiedTime,trashed,parents,appProperties")}`,
      accessToken,
    );
  } catch (error) {
    const code = safeErrorCode(error);
    oldRecordingReadErrorCode = code;
  }
  const initialBlockCode = recordingReplacementBlockCode({
    oldRecording,
    oldReadErrorCode: oldRecordingReadErrorCode,
    expectedFolderId: status.folderId,
    confirmedMissingAcrossDrive: input.confirmedMissingAcrossDrive,
    globalCandidates: null,
  });
  if (initialBlockCode) throw new Error(initialBlockCode);
  if (oldRecordingReadErrorCode) {
    await reportProgress();
    const globalCandidates = await listGlobalRecordingCandidates({
      accessToken,
      sessionId: source.sessionId,
    });
    const globalBlockCode = recordingReplacementBlockCode({
      oldRecording: null,
      oldReadErrorCode: oldRecordingReadErrorCode,
      expectedFolderId: status.folderId,
      confirmedMissingAcrossDrive: input.confirmedMissingAcrossDrive,
      globalCandidates,
    });
    if (globalBlockCode) throw new Error(globalBlockCode);
  }

  const storedSmall: GoogleDriveArchiveIntegrity = {
    ...stored,
    status: "verified",
    errorCode: null,
    artifacts: Object.fromEntries(Object.entries(stored.artifacts)
      .filter(([key]) => key !== "recording")),
  };
  await reportProgress();
  const observedSmall = await readGoogleDriveArchiveIntegritySnapshot({
    sessionId: source.sessionId,
    folderId: status.folderId,
    files,
    recordingIncluded: false,
    previous: storedSmall,
    accessToken,
  });
  if (!verifiedSmallArtifactsUnchanged(storedSmall, observedSmall)) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }

  const manifestId = receiptFileId(files, "manifest");
  const manifestFile = children.find((file) => file.id === manifestId);
  if (!manifestFile || manifestFile.appProperties?.tokyoDogsArtifact !== "manifest") {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const manifestBytes = await readSmallDriveFile({
    accessToken,
    file: manifestFile,
    maximumBytes: 64 * 1024,
  });
  let archivedManifest: Record<string, unknown>;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    archivedManifest = decoded as Record<string, unknown>;
  } catch {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const archivedFiles = driveManifestFiles(archivedManifest.files);
  if (
    archivedManifest.sessionId !== source.sessionId ||
    archivedManifest.folderId !== status.folderId ||
    archivedManifest.recordingIncluded !== true ||
    !archivedFiles || receiptFileId(archivedFiles, "recording") !== storedRecording.fileId
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }

  await reportProgress();
  const root = await validateGoogleDriveRoot(accessToken);
  if (archivedManifest.rootFolderId !== root.id) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  const byArtifact = indexDriveArtifacts(children);
  const required: DriveArtifactKey[] = [
    "transcript", "evaluation_json", "report_doc", "report_pdf", "manifest",
  ];
  const canonical = Object.fromEntries(required.map((key) => {
    const expectedId = receiptFileId(files, key);
    const matches = (byArtifact.get(key) ?? []).filter((file) => file.id === expectedId);
    if (matches.length !== 1) throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    return [key, matches[0]];
  })) as Record<Exclude<DriveArtifactKey, "recording">, DriveFile>;
  const uploaded: GoogleDriveSyncResult["uploaded"] = {
    transcript: fileSummary(canonical.transcript, canonical.transcript.name || `${source.sessionId}_文字起こし.txt`),
    evaluation: fileSummary(canonical.evaluation_json, canonical.evaluation_json.name || `${source.sessionId}_評価データ.json`),
    reportDocument: fileSummary(canonical.report_doc, canonical.report_doc.name || `${source.sessionId}_オンライン一次面接レポート`),
    reportPdf: fileSummary(canonical.report_pdf, canonical.report_pdf.name || `${source.sessionId}_オンライン一次面接レポート.pdf`),
    manifest: fileSummary(canonical.manifest, canonical.manifest.name || `${source.sessionId}_格納結果.json`),
  };
  const expectedContentHashes: Partial<Record<DriveArtifactKey, string>> = {};
  const expectedContentSizes: Partial<Record<DriveArtifactKey, number>> = {};
  for (const key of required) {
    const receipt = observedSmall.artifacts[key];
    if (!receipt) throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
    expectedContentHashes[key] = receipt.contentSha256;
    // A native Google Doc reports a Drive logical size, whereas integrity
    // verification hashes its exported plain-text representation. The receipt
    // does not store that export byte length, so constrain the hash/ID/version
    // here and leave byte-size comparison to binary/text file artifacts.
    if (key !== "report_doc" && receipt.size !== null) {
      expectedContentSizes[key] = receipt.size;
    }
  }
  return {
    rootFolderId: root.id,
    expectedParentId: observedSmall.folder.parentId,
    candidateFolder,
    folderUrl: status.folderUrl,
    uploaded,
    artifactTargetIds: {
      transcript: canonical.transcript.id,
      evaluation_json: canonical.evaluation_json.id,
      report_doc: canonical.report_doc.id,
      report_pdf: canonical.report_pdf.id,
      manifest: canonical.manifest.id,
      recording: null,
    },
    transcriptDuplicateId: null,
    recordingDuplicateProof: null,
    transcriptAvailable: status.manifest.transcriptAvailable === true,
    transcriptKind: typeof status.manifest.transcriptKind === "string"
      ? status.manifest.transcriptKind
      : "unknown",
    expectedContentHashes,
    expectedContentSizes,
    sharingRisk: observedSmall.sharingRisk === "unknown"
      ? root.sharingRisk
      : observedSmall.sharingRisk,
    recordingRepairHistory: [
      ...(Array.isArray(status.manifest.recordingRepairHistory)
        ? status.manifest.recordingRepairHistory.slice(-4).filter((entry) =>
            entry && typeof entry === "object" && !Array.isArray(entry)) as Array<Record<string, unknown>>
        : []),
      {
        detectedAt: stored.checkedAt,
        previousFile: files.recording,
        previousIntegrity: storedRecording,
        reason: DRIVE_RECORDING_MISSING_CODE,
      },
    ],
  };
}

/**
 * Refreshes only the five small presentation artifacts of an already verified
 * archive. The durable recording is resolved by its exact canonical Drive ID
 * and is never uploaded or content-PATCHed again. This is used when a report
 * layout improves while the underlying interview evidence remains unchanged.
 */
async function refreshCompletedDriveReportPresentation(
  sessionId: string,
  source: ArchiveSource,
): Promise<GoogleDriveArchiveStepResult> {
  await requestExternalSync(sessionId);
  const startedAt = await claimExternalSync(sessionId);
  if (!startedAt) return pendingStep({ phase: "busy" });
  const claimHeartbeat = startDriveClaimHeartbeat(sessionId, startedAt);
  try {
    assertArchiveReady(source);
    await claimHeartbeat.reportProgress();
    const accessToken = await fetchGoogleDriveAccessToken();
    const prepared = await prepareDriveArchive(source, accessToken, claimHeartbeat.reportProgress);
    let recordingFile: DriveFile | null = null;
    if (source.recording) {
      const recordingId = prepared.artifactTargetIds.recording;
      if (typeof recordingId !== "string") {
        throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
      }
      await claimHeartbeat.reportProgress();
      const children = await listFolderChildren(accessToken, prepared.candidateFolder.id);
      recordingFile = children.find((file) => file.id === recordingId) ?? null;
      const extension = source.recording.contentType.includes("mp4") ? "mp4" : "webm";
      if (!recordingFile || !recordingFileMatchesTrustedUpload({
        file: recordingFile,
        folderId: prepared.candidateFolder.id,
        name: `${source.sessionId}_面接録画.${extension}`,
        contentType: source.recording.contentType,
        byteSize: source.recording.byteSize,
      })) {
        throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
      }
    }
    const result = await finalizeDriveArchive(
      source,
      accessToken,
      prepared,
      recordingFile,
      claimHeartbeat.reportProgress,
    );
    await claimHeartbeat.stop();
    const retryRequested = await completeExternalSync({
      sessionId,
      startedAt,
      folderId: result.folderId,
      folderUrl: result.folderUrl,
      manifest: {
        files: result.uploaded,
        recordingIncluded: result.recordingIncluded,
        transcriptAvailable: result.transcriptAvailable,
        transcriptKind: result.transcriptKind,
        reportPresentationVersion: INTERVIEW_REPORT_PRESENTATION_VERSION,
        integrity: result.integrity,
      },
    });
    return retryRequested ? { ...result, status: "pending" } : result;
  } catch (error) {
    await claimHeartbeat.stop().catch(() => undefined);
    await failExternalSync({ sessionId, startedAt, errorCode: safeErrorCode(error) });
    throw error;
  }
}

function pendingStep(input: {
  phase: "initializing" | "uploading" | "finalizing" | "busy" | "retrying";
  folderId?: string | null;
  folderUrl?: string | null;
  committedOffset?: number;
  totalBytes?: number;
}): GoogleDriveArchiveStepResult {
  return {
    status: "pending",
    phase: input.phase,
    folderId: input.folderId ?? null,
    folderUrl: input.folderUrl ?? null,
    recordingIncluded: true,
    committedOffset: input.committedOffset ?? 0,
    totalBytes: input.totalBytes ?? 0,
    retryAfterMs: input.phase === "busy" ? 1_500 : 250,
  };
}

function preparedArchiveFromContext(value: Record<string, unknown>): PreparedDriveArchive {
  const candidateFolder = value.candidateFolder as DriveFile | undefined;
  const uploaded = value.uploaded as GoogleDriveSyncResult["uploaded"] | undefined;
  if (
    typeof value.rootFolderId !== "string" ||
    typeof value.expectedParentId !== "string" ||
    typeof value.folderUrl !== "string" ||
    typeof value.transcriptAvailable !== "boolean" ||
    typeof value.transcriptKind !== "string" ||
    !candidateFolder || typeof candidateFolder.id !== "string" ||
    !uploaded || typeof uploaded !== "object"
  ) {
    throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_CONTEXT_INVALID");
  }
  const storedTargets = value.artifactTargetIds && typeof value.artifactTargetIds === "object"
    ? value.artifactTargetIds as Record<string, unknown>
    : {};
  const artifactTargetIds: Record<string, string | null | undefined> = {
    transcript: typeof storedTargets.transcript === "string"
      ? storedTargets.transcript
      : typeof uploaded.transcript?.id === "string" ? uploaded.transcript.id : null,
    evaluation_json: typeof storedTargets.evaluation_json === "string"
      ? storedTargets.evaluation_json
      : typeof uploaded.evaluation?.id === "string" ? uploaded.evaluation.id : null,
    report_doc: typeof storedTargets.report_doc === "string"
      ? storedTargets.report_doc
      : typeof uploaded.reportDocument?.id === "string" ? uploaded.reportDocument.id : null,
    report_pdf: typeof storedTargets.report_pdf === "string"
      ? storedTargets.report_pdf
      : typeof uploaded.reportPdf?.id === "string" ? uploaded.reportPdf.id : null,
    manifest: Object.prototype.hasOwnProperty.call(storedTargets, "manifest")
      ? typeof storedTargets.manifest === "string" ? storedTargets.manifest : null
      : undefined,
    recording: Object.prototype.hasOwnProperty.call(storedTargets, "recording")
      ? typeof storedTargets.recording === "string" ? storedTargets.recording : null
      : undefined,
  };
  const storedRecordingDuplicate = value.recordingDuplicateProof &&
    typeof value.recordingDuplicateProof === "object"
    ? value.recordingDuplicateProof as Record<string, unknown>
    : null;
  const recordingDuplicateProof: RecordingDuplicateProof | null = storedRecordingDuplicate &&
    typeof storedRecordingDuplicate.canonicalId === "string" &&
    typeof storedRecordingDuplicate.duplicateId === "string" &&
    typeof storedRecordingDuplicate.byteSize === "number" &&
    ["sha256Checksum", "bounded-range-sha256"].includes(
      String(storedRecordingDuplicate.fingerprintAlgorithm),
    ) &&
    typeof storedRecordingDuplicate.fingerprint === "string"
    ? storedRecordingDuplicate as unknown as RecordingDuplicateProof
    : null;
  const storedHashes = value.expectedContentHashes && typeof value.expectedContentHashes === "object"
    ? value.expectedContentHashes as Record<string, unknown>
    : {};
  const storedSizes = value.expectedContentSizes && typeof value.expectedContentSizes === "object"
    ? value.expectedContentSizes as Record<string, unknown>
    : {};
  const expectedContentHashes = Object.fromEntries(
    Object.entries(storedHashes).filter(([key, hash]) =>
      ["transcript", "evaluation_json", "report_doc", "report_pdf", "manifest", "recording"].includes(key) &&
      typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)),
  ) as Partial<Record<DriveArtifactKey, string>>;
  const expectedContentSizes = Object.fromEntries(
    Object.entries(storedSizes).filter(([key, size]) =>
      ["transcript", "evaluation_json", "report_doc", "report_pdf", "manifest", "recording"].includes(key) &&
      typeof size === "number" && Number.isSafeInteger(size) && size >= 0),
  ) as Partial<Record<DriveArtifactKey, number>>;
  const sharingRisk = ["anyone_writer", "anyone_reader", "restricted", "unknown"].includes(String(value.sharingRisk))
    ? value.sharingRisk as DriveSharingRisk
    : "unknown";
  return {
    rootFolderId: value.rootFolderId,
    expectedParentId: value.expectedParentId,
    candidateFolder,
    folderUrl: value.folderUrl,
    uploaded,
    artifactTargetIds,
    transcriptDuplicateId: typeof value.transcriptDuplicateId === "string"
      ? value.transcriptDuplicateId
      : null,
    recordingDuplicateProof,
    transcriptAvailable: value.transcriptAvailable,
    transcriptKind: value.transcriptKind,
    expectedContentHashes,
    expectedContentSizes,
    sharingRisk,
    recordingRepairHistory: Array.isArray(value.recordingRepairHistory)
      ? value.recordingRepairHistory.slice(-5).filter((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)) as Array<Record<string, unknown>>
      : undefined,
  };
}

function preparedArchiveContext(prepared: PreparedDriveArchive): Record<string, unknown> {
  return {
    rootFolderId: prepared.rootFolderId,
    expectedParentId: prepared.expectedParentId,
    candidateFolder: prepared.candidateFolder,
    folderUrl: prepared.folderUrl,
    uploaded: prepared.uploaded,
    artifactTargetIds: prepared.artifactTargetIds,
    transcriptDuplicateId: prepared.transcriptDuplicateId,
    recordingDuplicateProof: prepared.recordingDuplicateProof,
    transcriptAvailable: prepared.transcriptAvailable,
    transcriptKind: prepared.transcriptKind,
    expectedContentHashes: prepared.expectedContentHashes,
    expectedContentSizes: prepared.expectedContentSizes,
    sharingRisk: prepared.sharingRisk,
    recordingRepairHistory: prepared.recordingRepairHistory,
  };
}

async function completeSteppedArchive(input: {
  sessionId: string;
  startedAt: string;
  source: ArchiveSource;
  accessToken: string;
  prepared: PreparedDriveArchive;
  recordingFile: DriveFile;
  reportProgress: DriveSyncProgress;
  leaseToken: string;
}) {
  const result = await finalizeDriveArchive(
    input.source,
    input.accessToken,
    input.prepared,
    input.recordingFile,
    input.reportProgress,
    async (prepared) => {
      await updateDriveUploadStepContext({
        sessionId: input.sessionId,
        startedAt: input.startedAt,
        leaseToken: input.leaseToken,
        context: preparedArchiveContext(prepared),
      });
    },
  );
  // Finalization performs readback after its last Drive mutation. Renew once
  // more so both the completion receipt and capability deletion are fenced by
  // the same still-live step owner.
  await input.reportProgress();
  const retryRequested = await completeExternalSync({
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    folderId: result.folderId,
    folderUrl: result.folderUrl,
    manifest: {
      files: result.uploaded,
      recordingIncluded: result.recordingIncluded,
      transcriptAvailable: input.prepared.transcriptAvailable,
      transcriptKind: input.prepared.transcriptKind,
      reportPresentationVersion: INTERVIEW_REPORT_PRESENTATION_VERSION,
      integrity: result.integrity,
      recordingRepairHistory: input.prepared.recordingRepairHistory,
    },
    driveUploadStepLeaseToken: input.leaseToken,
  });
  await deleteDriveUploadStep({
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    leaseToken: input.leaseToken,
  });
  return retryRequested ? { ...result, status: "pending" as const } : result;
}

/**
 * Advances a candidate archive by at most one Drive recording chunk. The
 * resumable capability and committed byte offset live in D1, so a Worker
 * cancellation or browser retry resumes the same Google upload instead of
 * replaying a 70 MB transfer inside one public HTTP request.
 */
export async function stepInterviewToGoogleDrive(
  sessionId: string,
  options: {
    confirmMissingRecordingAcrossDrive?: boolean;
    missingRecordingRepairReviewer?: AuthorizedReviewer;
  } = {},
): Promise<GoogleDriveArchiveStepResult> {
  if ((await missingGoogleDriveConfiguration()).length > 0) {
    throw new Error("GOOGLE_DRIVE_CONFIGURATION_MISSING");
  }

  let current = await getExternalSyncStatus(sessionId);
  let recordingRepairAuthorized = false;
  let recordingRepairPrepared: PreparedDriveArchive | null = null;
  let recordingRepairAccessToken: string | null = null;
  const durableCompletedRepairAuthorization = current?.status === "completed"
    ? await hasDurableMissingRecordingRepairAuthorization(sessionId)
    : false;
  if (options.confirmMissingRecordingAcrossDrive === true && current?.status !== "completed") {
    // A second click must not turn into an extra upload-advancing request. The
    // already authorized fenced repair is advanced by the normal poll path.
    throw new Error(DRIVE_RECORDING_REPAIR_CONFIRMATION_REQUIRED);
  }
  if (current?.retryBlockedAt) {
    // A permanent or exhausted failure is a durable operational hold. Never
    // reopen it from candidate polling, staff polling, or cron: doing so caused
    // the production 404 storm and could create duplicate Drive artifacts.
    throw new Error("GOOGLE_DRIVE_SYNC_MANUAL_ATTENTION_REQUIRED");
  }
  const alreadyCompleted = current ? completedResultFromStatus(current) : null;
  if (alreadyCompleted) {
    const source = await getInterviewArchiveSource(sessionId);
    if (!source) throw new Error("INTERVIEW_NOT_FOUND");
    // Receipt flags are not sufficient proof on their own: older rows could be
    // mislabeled while containing only a question placeholder. Cross-check the
    // durable D1 transcript before acknowledging even an otherwise complete
    // Drive receipt.
    if (!hasActualCandidateTranscript(source) && !isTechnicalEvidenceArchiveSource(source)) {
      throw new Error("INTERVIEW_TRANSCRIPT_NOT_READY_FOR_DRIVE_SYNC");
    }
    if (completedReceiptSatisfiesSource(alreadyCompleted, source)) {
      // If the worker stopped immediately after consuming the exact grant, the
      // completed receipt is still the same raw manifest. Do not rewrite its
      // checkedAt and invalidate that durable proof; the stricter repair
      // preflight below re-reads Drive, trash, R2, and all five small artifacts.
      if (!durableCompletedRepairAuthorization) {
        await revalidateCompletedGoogleDriveArchive(sessionId);
      }
      const refreshed = await getExternalSyncStatus(sessionId);
      const refreshedResult = refreshed ? completedResultFromStatus(refreshed) : null;
      if (refreshedResult?.integrity?.status === "verified") {
        if (refreshedResult.reportPresentationVersion !== INTERVIEW_REPORT_PRESENTATION_VERSION) {
          return await refreshCompletedDriveReportPresentation(sessionId, source);
        }
        return refreshedResult;
      }
      if (refreshed && completedReceiptNeedsRecordingRepair(refreshed, source)) {
        // The existing completed receipt remains the immutable repair proof in
        // manifest_json. Perform every Drive/R2/small-artifact preflight while
        // the receipt is still completed and before creating or consuming the
        // one-time authorization. A transient read failure therefore performs
        // zero Drive writes and cannot strand a consumed grant.
        assertArchiveReady(source);
        const accessToken = await fetchGoogleDriveAccessToken();
        recordingRepairAccessToken = accessToken;
        recordingRepairPrepared = await prepareRecordingOnlyDriveRepair({
          source,
          status: refreshed,
          accessToken,
          reportProgress: async () => {},
          confirmedMissingAcrossDrive: true,
        });
        if (durableCompletedRepairAuthorization) {
          // Resume only the already-consumed grant tied to this exact completed
          // manifest/old recording ID. This closes the consume→pending crash
          // window without minting or consuming a second authorization.
          recordingRepairAuthorized = true;
        } else {
          if (
            options.confirmMissingRecordingAcrossDrive !== true ||
            typeof options.missingRecordingRepairReviewer !== "string" ||
            !options.missingRecordingRepairReviewer
          ) {
            throw new Error(DRIVE_RECORDING_REPAIR_CONFIRMATION_REQUIRED);
          }
          // Authorization is created only after the latest integrity
          // revalidation and every read-only preflight has succeeded. Its CAS
          // binds to the current manifest hash, not a stale checkedAt.
          const authorization = await createMissingRecordingRepairAuthorization({
            sessionId,
            reviewer: options.missingRecordingRepairReviewer,
          });
          if (!authorization || !await consumeMissingRecordingRepairAuthorization({
            sessionId,
            nonce: authorization.nonce,
          })) {
            throw new Error(DRIVE_RECORDING_REPAIR_CONFIRMATION_REQUIRED);
          }
          recordingRepairAuthorized = true;
        }
        await requestExternalSync(sessionId);
        current = await getExternalSyncStatus(sessionId);
      } else {
        throw new Error(refreshedResult?.integrity?.status === "unknown"
          ? "GOOGLE_DRIVE_ARCHIVE_INTEGRITY_UNCONFIRMED"
          : "GOOGLE_DRIVE_ARCHIVE_INTEGRITY_DRIFT");
      }
    }

    // A legacy completed row can describe a five-file archive created before
    // the recording was durable, or a placeholder/unknown transcript. Never
    // return that row as a verified receipt. Validate that today's durable
    // source can repair it before reopening the fenced sync state; if it cannot,
    // fail without touching Drive or replacing the evidence of the bad receipt.
    assertArchiveReady(source);
    await requestExternalSync(sessionId);
    current = await getExternalSyncStatus(sessionId);
  }
  if (current?.status === "completed") {
    // A completed row without a usable folder receipt is also incomplete. It
    // cannot be claimed directly (claims are fenced to `pending`), so validate
    // the repair source and explicitly reopen it instead of returning `busy`
    // forever.
    const source = await getInterviewArchiveSource(sessionId);
    if (!source) throw new Error("INTERVIEW_NOT_FOUND");
    assertArchiveReady(source);
    await requestExternalSync(sessionId);
    current = await getExternalSyncStatus(sessionId);
  }
  let step = await getDriveUploadStep(sessionId);

  if (!step || current?.status !== "running" || step.startedAt !== current.startedAt) {
    if (current?.status === "running") {
      // Also performs the fenced stale-claim recovery. A live initializer keeps
      // its heartbeat and remains untouched; a canceled initializer becomes
      // claimable without creating a concurrent Drive writer.
      await requestExternalSync(sessionId);
      current = await getExternalSyncStatus(sessionId);
      if (current?.status === "running") {
        return pendingStep({ phase: "initializing" });
      }
    } else if (!current || current.status === "failed") {
      await requestExternalSync(sessionId);
      current = await getExternalSyncStatus(sessionId);
    }

    const startedAt = await claimExternalSync(sessionId);
    if (!startedAt) return pendingStep({ phase: "busy" });
    const reportProgress = async () => {
      if (!await heartbeatExternalSync(sessionId, startedAt)) {
        throw new Error("GOOGLE_DRIVE_SYNC_CLAIM_LOST");
      }
    };
    try {
      const source = await getInterviewArchiveSource(sessionId);
      if (!source) throw new Error("INTERVIEW_NOT_FOUND");
      assertArchiveReady(source);
      await reportProgress();
      // A previous upload may already have reached Drive and persisted the
      // returned file ID before finalization failed. Adopt that exact receipt
      // into this new claim before any folder/content write. Reinitializing the
      // row would clear recording_file_json and could POST a third recording.
      if (
        step?.phase === "finalizing" && source.recording &&
        step.totalBytes === source.recording.byteSize &&
        step.contentType === source.recording.contentType &&
        step.recordingName === `${source.sessionId}_面接録画.${source.recording.contentType.includes("mp4") ? "mp4" : "webm"}` &&
        step.recordingFile && typeof step.recordingFile.id === "string" &&
        recordingFileMatchesTrustedUpload({
          file: step.recordingFile as DriveFile,
          folderId: step.folderId,
          name: step.recordingName,
          contentType: step.contentType,
          byteSize: step.totalBytes,
        })
      ) {
        const adopted = await adoptFinalizingDriveUploadStep({
          sessionId,
          previousStartedAt: step.startedAt,
          nextStartedAt: startedAt,
          expectedTotalBytes: source.recording.byteSize,
          expectedContentType: source.recording.contentType,
        });
        if (!adopted) throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_ADOPTION_FAILED");
        return pendingStep({
          phase: "finalizing",
          folderId: adopted.folderId,
          folderUrl: adopted.folderUrl,
          committedOffset: adopted.committedOffset,
          totalBytes: adopted.totalBytes,
        });
      }
      const accessToken = recordingRepairAccessToken ??
        await fetchGoogleDriveAccessToken();
      const recordingOnlyRepair = Boolean(current && completedReceiptNeedsRecordingRepair(current, source));
      if (recordingOnlyRepair && !recordingRepairAuthorized) {
        recordingRepairAuthorized =
          await hasDurableMissingRecordingRepairAuthorization(sessionId);
      }
      const prepared = recordingOnlyRepair
        ? recordingRepairPrepared ?? await prepareRecordingOnlyDriveRepair({
            source,
            status: current as NonNullable<Awaited<ReturnType<typeof getExternalSyncStatus>>>,
            accessToken,
            reportProgress,
            confirmedMissingAcrossDrive: recordingRepairAuthorized,
          })
        : await prepareDriveArchive(source, accessToken, reportProgress);
      if (!source.recording) {
        const result = await finalizeDriveArchive(source, accessToken, prepared, null, reportProgress);
        await completeExternalSync({
          sessionId,
          startedAt,
          folderId: result.folderId,
          folderUrl: result.folderUrl,
          manifest: {
            files: result.uploaded,
            recordingIncluded: false,
            transcriptAvailable: prepared.transcriptAvailable,
            transcriptKind: prepared.transcriptKind,
            reportPresentationVersion: INTERVIEW_REPORT_PRESENTATION_VERSION,
            integrity: result.integrity,
            recordingRepairHistory: prepared.recordingRepairHistory,
          },
        });
        return result;
      }
      const finalizedRecording = await finalizedRecordingFromDriveManifest({
        accessToken,
        source,
        prepared,
      });
      if (finalizedRecording) {
        const result = await finalizeDriveArchive(
          source,
          accessToken,
          prepared,
          finalizedRecording,
          reportProgress,
        );
        const retryRequested = await completeExternalSync({
          sessionId,
          startedAt,
          folderId: result.folderId,
          folderUrl: result.folderUrl,
          manifest: {
            files: result.uploaded,
            recordingIncluded: true,
            transcriptAvailable: prepared.transcriptAvailable,
            transcriptKind: prepared.transcriptKind,
            reportPresentationVersion: INTERVIEW_REPORT_PRESENTATION_VERSION,
            integrity: result.integrity,
            recordingRepairHistory: prepared.recordingRepairHistory,
          },
        });
        return retryRequested ? { ...result, status: "pending" } : result;
      }
      const extension = source.recording.contentType.includes("mp4") ? "mp4" : "webm";
      const recordingName = `${source.sessionId}_面接録画.${extension}`;
      let uploadLocation: string;
      try {
        uploadLocation = await initiateRecordingUpload({
          accessToken,
          folderId: prepared.candidateFolder.id,
          name: recordingName,
          contentType: source.recording.contentType,
          byteSize: source.recording.byteSize,
          sessionId: source.sessionId,
          targetFileId: prepared.artifactTargetIds.recording,
        });
      } catch (error) {
        const code = safeErrorCode(error);
        if (
          recordingOnlyRepair &&
          (/^GOOGLE_DRIVE_RESUMABLE_INIT_(?:429|500|502|503|504|524)$/.test(code) ||
            code === "GOOGLE_DRIVE_SYNC_FAILED")
        ) {
          // A timeout/5xx after the repair's first POST cannot prove whether
          // Google created a resumable session. Do not issue another INIT from
          // candidate or cron polling; hold for one explicit staff retry, whose
          // strict preflight rechecks Drive-wide active/trash candidates first.
          throw new Error("GOOGLE_DRIVE_RECORDING_REPAIR_INIT_UNCONFIRMED");
        }
        throw error;
      }
      const encrypted = await encryptGoogleDriveUploadCapability(uploadLocation, sessionId);
      step = await initializeDriveUploadStep({
        sessionId,
        startedAt,
        uploadUrlCiphertext: encrypted.ciphertext,
        uploadUrlIv: encrypted.iv,
        totalBytes: source.recording.byteSize,
        contentType: source.recording.contentType,
        recordingName,
        folderId: prepared.candidateFolder.id,
        folderUrl: prepared.folderUrl,
        context: preparedArchiveContext(prepared),
      });
      return pendingStep({
        phase: "uploading",
        folderId: step.folderId,
        folderUrl: step.folderUrl,
        totalBytes: step.totalBytes,
      });
    } catch (error) {
      const errorCode = safeErrorCode(error);
      if (errorCode === "GOOGLE_DRIVE_HIERARCHY_BUSY") {
        // The hierarchy owner is healthy but still creating/verifying a shared
        // year or month node. Release this session's initializer claim and let
        // the foreground retry (or recovery tick) re-enter from pending state.
        await deferExternalSync({ sessionId, startedAt });
        return pendingStep({ phase: "initializing" });
      }
      await failExternalSync({ sessionId, startedAt, errorCode });
      throw error;
    }
  }

  const leaseToken = await acquireDriveUploadStepLease(sessionId, step.startedAt);
  if (!leaseToken) {
    return pendingStep({
      phase: "busy",
      folderId: step.folderId,
      folderUrl: step.folderUrl,
      committedOffset: step.committedOffset,
      totalBytes: step.totalBytes,
    });
  }
  let leaseHeld = true;
  const releaseLease = async () => {
    if (!leaseHeld) return;
    await releaseDriveUploadStepLease({ sessionId, startedAt: step.startedAt, leaseToken });
    leaseHeld = false;
  };
  const reportProgress = async () => {
    if (!await renewDriveUploadStepLease({
      sessionId,
      startedAt: step.startedAt,
      leaseToken,
    })) {
      throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_LEASE_LOST");
    }
    if (!await heartbeatExternalSync(sessionId, step.startedAt)) {
      throw new Error("GOOGLE_DRIVE_SYNC_CLAIM_LOST");
    }
  };
  try {
    await reportProgress();
    const source = await getInterviewArchiveSource(sessionId);
    if (!source) throw new Error("INTERVIEW_NOT_FOUND");
    assertArchiveReady(source);
    if (!source.recording || source.recording.byteSize !== step.totalBytes || source.recording.contentType !== step.contentType) {
      throw new Error("INTERVIEW_RECORDING_ARTIFACT_MISSING");
    }
    const prepared = preparedArchiveFromContext(step.context);
    const accessToken = await fetchGoogleDriveAccessToken();
    if (step.phase === "finalizing") {
      if (!step.recordingFile || typeof step.recordingFile.id !== "string") {
        throw new Error("GOOGLE_DRIVE_UPLOAD_STEP_CONTEXT_INVALID");
      }
      const result = await completeSteppedArchive({
        sessionId,
        startedAt: step.startedAt,
        source,
        accessToken,
        prepared,
        recordingFile: step.recordingFile as DriveFile,
        reportProgress,
        leaseToken,
      });
      leaseHeld = false;
      return result;
    }

    const finalizedRecording = await finalizedRecordingFromDriveManifest({
      accessToken,
      source,
      prepared,
    });
    if (finalizedRecording) {
      const result = await completeSteppedArchive({
        sessionId,
        startedAt: step.startedAt,
        source,
        accessToken,
        prepared,
        recordingFile: finalizedRecording,
        reportProgress,
        leaseToken,
      });
      leaseHeld = false;
      return result;
    }

    let uploadLocation = await decryptGoogleDriveUploadCapability(
      step.uploadUrlCiphertext,
      step.uploadUrlIv,
      sessionId,
    );
    const remote = await queryResumableStatus(uploadLocation, step.totalBytes);
    uploadLocation = remote.uploadLocation;
    let encryptedReplacement: { ciphertext: string; iv: string } | null = null;
    if (uploadLocation !== await decryptGoogleDriveUploadCapability(step.uploadUrlCiphertext, step.uploadUrlIv, sessionId)) {
      encryptedReplacement = await encryptGoogleDriveUploadCapability(uploadLocation, sessionId);
    }
    if (remote.complete) {
      await updateDriveUploadStep({
        sessionId,
        startedAt: step.startedAt,
        leaseToken,
        committedOffset: step.totalBytes,
        phase: "finalizing",
        recordingFile: remote.file as Record<string, unknown>,
        uploadUrlCiphertext: encryptedReplacement?.ciphertext,
        uploadUrlIv: encryptedReplacement?.iv,
      });
      const result = await completeSteppedArchive({
        sessionId,
        startedAt: step.startedAt,
        source,
        accessToken,
        prepared,
        recordingFile: remote.file,
        reportProgress,
        leaseToken,
      });
      leaseHeld = false;
      return result;
    }

    const committedOffset = remote.committedBytes;
    if (
      !Number.isInteger(committedOffset) || committedOffset < 0 || committedOffset > step.totalBytes ||
      (committedOffset !== step.totalBytes && committedOffset % (256 * 1024) !== 0)
    ) {
      throw new Error("GOOGLE_DRIVE_RESUMABLE_RANGE_MISMATCH");
    }
    await updateDriveUploadStep({
      sessionId,
      startedAt: step.startedAt,
      leaseToken,
      committedOffset,
      uploadUrlCiphertext: encryptedReplacement?.ciphertext,
      uploadUrlIv: encryptedReplacement?.iv,
    });
    const chunkLength = Math.min(DRIVE_RECORDING_CHUNK_BYTES, step.totalBytes - committedOffset);
    if (chunkLength <= 0) throw new Error("GOOGLE_DRIVE_RESUMABLE_UPLOAD_INCOMPLETE");
    const chunk = await getInterviewRecordingChunk({ sessionId, offset: committedOffset, length: chunkLength });
    if (!chunk || chunk.byteSize !== step.totalBytes || chunk.contentType !== step.contentType) {
      throw new Error("INTERVIEW_RECORDING_ARTIFACT_MISSING");
    }
    // R2 reads and resumable-status reconciliation can be slow. Renew directly
    // before the sole Drive data mutation so an expired worker sends no chunk.
    await reportProgress();
    const uploaded = await putOneRecordingChunk({
      uploadLocation,
      contentType: step.contentType,
      totalBytes: step.totalBytes,
      offset: committedOffset,
      bytes: chunk.bytes,
    });
    let uploadedLocationEncryption: { ciphertext: string; iv: string } | null = null;
    if (uploaded.uploadLocation !== uploadLocation) {
      uploadedLocationEncryption = await encryptGoogleDriveUploadCapability(uploaded.uploadLocation, sessionId);
    }
    if (uploaded.complete) {
      await updateDriveUploadStep({
        sessionId,
        startedAt: step.startedAt,
        leaseToken,
        committedOffset: step.totalBytes,
        phase: "finalizing",
        recordingFile: uploaded.file as Record<string, unknown>,
        uploadUrlCiphertext: uploadedLocationEncryption?.ciphertext,
        uploadUrlIv: uploadedLocationEncryption?.iv,
      });
      const result = await completeSteppedArchive({
        sessionId,
        startedAt: step.startedAt,
        source,
        accessToken,
        prepared,
        recordingFile: uploaded.file,
        reportProgress,
        leaseToken,
      });
      leaseHeld = false;
      return result;
    }
    await updateDriveUploadStep({
      sessionId,
      startedAt: step.startedAt,
      leaseToken,
      committedOffset: uploaded.committedBytes,
      uploadUrlCiphertext: uploadedLocationEncryption?.ciphertext,
      uploadUrlIv: uploadedLocationEncryption?.iv,
      releaseLease: true,
    });
    leaseHeld = false;
    return pendingStep({
      phase: "uploading",
      folderId: step.folderId,
      folderUrl: step.folderUrl,
      committedOffset: uploaded.committedBytes,
      totalBytes: step.totalBytes,
    });
  } catch (error) {
    const errorCode = safeErrorCode(error);
    if (errorCode === "GOOGLE_DRIVE_UPLOAD_STEP_LEASE_LOST") {
      // A newer worker may already own the same external-sync claim. The stale
      // worker must not mark that shared claim failed or perform any other
      // state write after its lease-expiry CAS returned zero.
      await releaseLease().catch(() => undefined);
      return pendingStep({
        phase: "busy",
        folderId: step.folderId,
        folderUrl: step.folderUrl,
        committedOffset: step.committedOffset,
        totalBytes: step.totalBytes,
      });
    }
    if (isTransientDriveError(error)) {
      await releaseLease().catch(() => undefined);
      return pendingStep({
        phase: "retrying",
        folderId: step.folderId,
        folderUrl: step.folderUrl,
        committedOffset: step.committedOffset,
        totalBytes: step.totalBytes,
      });
    }
    // Only a currently fenced owner may transition the shared external claim
    // to failed. If expiry happened while handling the error, leave the claim
    // untouched for the new owner and converge as a busy response.
    if (!await renewDriveUploadStepLease({
      sessionId,
      startedAt: step.startedAt,
      leaseToken,
    }).catch(() => false)) {
      leaseHeld = false;
      return pendingStep({
        phase: "busy",
        folderId: step.folderId,
        folderUrl: step.folderUrl,
        committedOffset: step.committedOffset,
        totalBytes: step.totalBytes,
      });
    }
    await failExternalSync({ sessionId, startedAt: step.startedAt, errorCode: safeErrorCode(error) });
    await releaseLease().catch(() => undefined);
    throw error;
  }
}

export async function syncInterviewToGoogleDrive(sessionId: string): Promise<GoogleDriveSyncResult> {
  if ((await missingGoogleDriveConfiguration()).length > 0) {
    throw new Error("GOOGLE_DRIVE_CONFIGURATION_MISSING");
  }
  try {
    return await syncInterviewToGoogleDriveOnce(sessionId);
  } catch (error) {
    if (!isTransientDriveError(error)) throw error;
    await wait(TRANSIENT_DRIVE_RETRY_DELAY_MS);
    return await syncInterviewToGoogleDriveOnce(sessionId);
  }
}
