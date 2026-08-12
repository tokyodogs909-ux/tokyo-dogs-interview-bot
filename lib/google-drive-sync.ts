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
  acquireDriveUploadStepLease,
  claimExternalSync,
  completeExternalSync,
  deleteDriveUploadStep,
  failExternalSync,
  getDriveUploadStep,
  getExternalSyncStatus,
  getInterviewArchiveSource,
  getInterviewRecordingChunk,
  heartbeatExternalSync,
  initializeDriveUploadStep,
  releaseDriveUploadStepLease,
  requestExternalSync,
  updateDriveUploadStep,
} from "@/lib/interview-persistence";
import { hasVerifiedCandidateTranscript } from "@/lib/interview-transcript-verification";

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

type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
};

type ArchiveSource = NonNullable<Awaited<ReturnType<typeof getInterviewArchiveSource>>>;

type PreparedDriveArchive = {
  rootFolderId: string;
  expectedParentId: string;
  candidateFolder: DriveFile;
  folderUrl: string;
  uploaded: GoogleDriveSyncResult["uploaded"];
  transcriptAvailable: boolean;
  transcriptKind: string;
};

export type GoogleDriveSyncResult = {
  status: "completed" | "pending";
  folderId: string;
  folderUrl: string;
  uploaded: Record<string, { id: string; name: string; size: number | null }>;
  recordingIncluded: boolean;
  transcriptAvailable: boolean;
  transcriptKind: string;
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
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

function buildTranscriptText(source: ArchiveSource) {
  const isTextInterview = source.recordingStatus === "not_applicable";
  const isRecordedFallbackPlaceholder = source.transcript.some((turn) =>
    turn.id.startsWith("recorded-fallback-answer-"));
  const lines = [
    isRecordedFallbackPlaceholder
      ? "TOKYO DOGS 録画式一次面接 質問記録（文字起こし未実施）"
      : "TOKYO DOGS オンライン一次面接 文字起こし",
    `面接ID: ${source.sessionId}`,
    `応募者氏名: ${source.candidateName}`,
    `雇用形態: ${source.employment}`,
    `入職希望対象店舗: ${source.preferredLocation}`,
    `面接完了日時: ${japaneseDate(source.completedAt)}`,
    isRecordedFallbackPlaceholder
      ? "確認区分: 録画式予備面接の質問記録。応募者の発言本文は文字起こし未実施"
      : isTextInterview
      ? "確認区分: 応募者が文字入力した回答記録（録画なし）"
      : "確認区分: 応募者端末で生成された文字起こし（録画との照合が必要）",
    "",
  ];
  for (const turn of source.transcript) {
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
  const isTextInterview = source.recordingStatus === "not_applicable";
  const evaluation = source.evaluation;
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
body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP","Yu Gothic",sans-serif;color:#12324b;line-height:1.65;margin:42px}h1{font-size:24px;border-bottom:3px solid #0c4168;padding-bottom:12px}h2{font-size:18px;margin-top:30px;background:#e8f4fb;padding:9px 12px}h3{font-size:15px;margin-bottom:5px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #b7c8d3;padding:8px;text-align:left;vertical-align:top}th{width:28%;background:#f4f8fa}section{break-inside:avoid}footer{margin-top:32px;font-size:11px;color:#526c7e}.notice{border:1px solid #8fb4ca;background:#f5fbff;padding:12px}</style></head><body>
<h1>TOKYO DOGS オンライン一次面接レポート</h1>
<table>
<tr><th>面接ID</th><td>${escapeHtml(source.sessionId)}</td></tr>
<tr><th>応募者氏名</th><td>${escapeHtml(source.candidateName)}</td></tr>
<tr><th>雇用形態</th><td>${escapeHtml(source.employment)}</td></tr>
<tr><th>入職希望対象店舗</th><td>${escapeHtml(source.preferredLocation)}</td></tr>
<tr><th>面接完了日時</th><td>${escapeHtml(japaneseDate(source.completedAt))}</td></tr>
<tr><th>録画状態</th><td>${escapeHtml(source.recordingStatus)}</td></tr>
</table>
<p class="notice">${isTextInterview
  ? "本資料は採用担当者の確認資料です。システムは合否を自動決定しません。文字入力方式では映像・音声を取得せず、参加方法の違いを不利益な評価に使用しません。"
  : "本資料は採用担当者の確認資料です。システムは合否を自動決定しません。文字起こしは応募者端末由来のため録画との照合が必要です。通信・録音・文字起こしの不具合や、顔立ち・容姿・表情・声質等を不利益な評価に使用しません。"}</p>
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
  return JSON.stringify({
    schemaVersion: "2026-07-29-v1",
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
    humanReviews: source.humanReviews,
    technicalEvents: source.auditEvents.filter((event) => [
      "audio_playback_blocked",
      "transcription_failed",
      "recording_unavailable",
      "connection_failed",
      "candidate_requested_stop",
      "time_limit_reached",
      "reasonable_accommodation_text_selected",
    ].includes(event.type)),
    humanDecisionRequired: true,
  }, null, 2);
}

async function driveJson<T>(url: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  });
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
    fields: "files(id,name,mimeType,size,webViewLink,parents,appProperties)",
  });
  const result = await driveJson<{ files?: DriveFile[] }>(`${DRIVE_API_ENDPOINT}/files?${params}`, accessToken);
  return result.files?.[0] ?? null;
}

async function listFolderChildren(accessToken: string, parentId: string) {
  const params = new URLSearchParams({
    q: `'${driveQueryValue(parentId)}' in parents and trashed = false`,
    pageSize: "100",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "files(id,name,mimeType,size,webViewLink,parents,appProperties)",
  });
  const result = await driveJson<{ files?: DriveFile[] }>(`${DRIVE_API_ENDPOINT}/files?${params}`, accessToken);
  return result.files ?? [];
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
  return await findChild(
    accessToken,
    folderId,
    `appProperties has { key='tokyoDogsArtifact' and value='${driveQueryValue(artifactKey)}' }`,
  );
}

async function uploadSmallFile(input: {
  accessToken: string;
  folderId: string;
  name: string;
  artifactKey: string;
  contentType: string;
  body: string | Uint8Array;
  googleMimeType?: string;
}) {
  const existing = await findArtifact(input.accessToken, input.folderId, input.artifactKey);
  const metadata: Record<string, unknown> = {
    name: input.name,
    appProperties: {
      tokyoDogsArtifact: input.artifactKey,
      tokyoDogsProvider: DRIVE_PROVIDER,
    },
  };
  if (!existing) metadata.parents = [input.folderId];
  if (input.googleMimeType) metadata.mimeType = input.googleMimeType;
  const formData = new FormData();
  formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json; charset=UTF-8" }));
  const bytes = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
  // Copy into an ArrayBuffer-backed view. Cloudflare streams may expose an
  // ArrayBufferLike view, while the standards Blob constructor accepts only an
  // ArrayBuffer-backed BlobPart under strict TypeScript checking.
  const blobBytes = Uint8Array.from(bytes);
  formData.append("media", new Blob([blobBytes.buffer], { type: input.contentType }));
  const url = existing
    ? `${DRIVE_UPLOAD_ENDPOINT}/files/${encodeURIComponent(existing.id)}?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink`
    : `${DRIVE_UPLOAD_ENDPOINT}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink`;
  return await driveJson<DriveFile>(url, input.accessToken, {
    method: existing ? "PATCH" : "POST",
    body: formData,
  });
}

async function exportGoogleDocToPdf(accessToken: string, fileId: string) {
  const response = await fetch(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent("application/pdf")}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) throw new Error(`GOOGLE_DRIVE_EXPORT_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function uploadRecording(input: {
  accessToken: string;
  folderId: string;
  name: string;
  contentType: string;
  byteSize: number;
  sessionId: string;
}) {
  const existing = await findArtifact(input.accessToken, input.folderId, "recording");
  const metadata: Record<string, unknown> = {
    name: input.name,
    appProperties: {
      tokyoDogsArtifact: "recording",
      tokyoDogsProvider: DRIVE_PROVIDER,
    },
  };
  if (!existing) metadata.parents = [input.folderId];
  const initUrl = existing
    ? `${DRIVE_UPLOAD_ENDPOINT}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink`
    : `${DRIVE_UPLOAD_ENDPOINT}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink`;
  const initResponse = await fetchWithTimeout(initUrl, {
    method: existing ? "PATCH" : "POST",
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
}) {
  const existing = await findArtifact(input.accessToken, input.folderId, "recording");
  const metadata: Record<string, unknown> = {
    name: input.name,
    appProperties: {
      tokyoDogsArtifact: "recording",
      tokyoDogsProvider: DRIVE_PROVIDER,
    },
  };
  if (!existing) metadata.parents = [input.folderId];
  const initUrl = existing
    ? `${DRIVE_UPLOAD_ENDPOINT}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents,appProperties`
    : `${DRIVE_UPLOAD_ENDPOINT}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents,appProperties`;
  const response = await fetchWithTimeout(initUrl, {
    method: existing ? "PATCH" : "POST",
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

async function verifyDriveArchive(input: {
  accessToken: string;
  folder: DriveFile;
  expectedParentId: string;
  sessionId: string;
  recordingByteSize: number | null;
}) {
  const fields = "id,name,mimeType,trashed,parents,appProperties,webViewLink";
  const folder = await driveJson<DriveFile & { trashed?: boolean }>(
    `${DRIVE_API_ENDPOINT}/files/${encodeURIComponent(input.folder.id)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`,
    input.accessToken,
  );
  if (
    folder.id !== input.folder.id ||
    folder.mimeType !== FOLDER_MIME_TYPE ||
    folder.trashed === true ||
    !folder.parents?.includes(input.expectedParentId) ||
    folder.appProperties?.tokyoDogsInterviewSession !== input.sessionId
  ) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FOLDER_READBACK_MISMATCH");
  }
  const files = await listFolderChildren(input.accessToken, folder.id);
  const byArtifact = new Map<string, DriveFile[]>();
  for (const file of files) {
    const key = file.appProperties?.tokyoDogsArtifact;
    if (!key) continue;
    byArtifact.set(key, [...(byArtifact.get(key) ?? []), file]);
  }
  const required = ["transcript", "evaluation_json", "report_doc", "report_pdf", "manifest"];
  if (input.recordingByteSize !== null) required.push("recording");
  if (required.some((key) => byArtifact.get(key)?.length !== 1)) {
    throw new Error("GOOGLE_DRIVE_ARCHIVE_FILE_READBACK_MISMATCH");
  }
  const recording = byArtifact.get("recording")?.[0];
  if (
    input.recordingByteSize !== null &&
    (!recording?.size || Number(recording.size) !== input.recordingByteSize)
  ) {
    throw new Error("GOOGLE_DRIVE_RECORDING_SIZE_MISMATCH");
  }
  return Object.fromEntries(required.map((key) => {
    const file = byArtifact.get(key)?.[0] as DriveFile;
    return [key, fileSummary(file, file.name || key)];
  }));
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
    });
  }
  return finalizeDriveArchive(source, accessToken, prepared, recordingFile, reportProgress);
}

function assertArchiveReady(source: ArchiveSource) {
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
  await reportProgress();
  const yearFolder = await ensureFolder(accessToken, root.id, year, "tokyoDogsInterviewYear", year);
  const monthKey = `${year}-${month}`;
  const monthFolder = await ensureFolder(accessToken, yearFolder.id, month, "tokyoDogsInterviewMonth", monthKey);
  const candidateFolder = await ensureFolder(
    accessToken,
    monthFolder.id,
    `${safeFolderSegment(source.candidateName)}_${source.sessionId}`,
    "tokyoDogsInterviewSession",
    source.sessionId,
  );
  const transcript = buildTranscriptText(source);
  // assertArchiveReady() runs before any Drive access. Recompute here for the
  // persisted receipt so a future refactor cannot accidentally label a
  // placeholder/interviewer-only transcript as an actual candidate transcript.
  const transcriptAvailable = hasActualCandidateTranscript(source);
  const transcriptKind = transcriptAvailable ? "actual_transcript" : "recorded_fallback_placeholder";
  const resultJson = buildResultJson(source);
  const reportHtml = buildReportHtml(source);
  const filePrefix = source.sessionId;
  const uploaded: GoogleDriveSyncResult["uploaded"] = {};
  await reportProgress();
  const transcriptFileName = transcriptAvailable
    ? `${filePrefix}_文字起こし.txt`
    : `${filePrefix}_録画式面接_質問記録_文字起こし未実施.txt`;
  const transcriptFile = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: transcriptFileName,
    artifactKey: "transcript",
    contentType: "text/plain; charset=utf-8",
    body: transcript,
  });
  uploaded.transcript = fileSummary(transcriptFile, transcriptFileName);
  await reportProgress();
  const resultFile = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: `${filePrefix}_評価データ.json`,
    artifactKey: "evaluation_json",
    contentType: "application/json; charset=utf-8",
    body: resultJson,
  });
  uploaded.evaluation = fileSummary(resultFile, `${filePrefix}_評価データ.json`);
  await reportProgress();
  const reportDoc = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: `${filePrefix}_オンライン一次面接レポート`,
    artifactKey: "report_doc",
    contentType: "text/html; charset=utf-8",
    body: reportHtml,
    googleMimeType: GOOGLE_DOC_MIME_TYPE,
  });
  uploaded.reportDocument = fileSummary(reportDoc, `${filePrefix}_オンライン一次面接レポート`);
  await reportProgress();
  const pdf = await exportGoogleDocToPdf(accessToken, reportDoc.id);
  await reportProgress();
  const reportPdf = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: `${filePrefix}_オンライン一次面接レポート.pdf`,
    artifactKey: "report_pdf",
    contentType: "application/pdf",
    body: pdf,
  });
  uploaded.reportPdf = fileSummary(reportPdf, `${filePrefix}_オンライン一次面接レポート.pdf`);
  return {
    rootFolderId: root.id,
    expectedParentId: monthFolder.id,
    candidateFolder,
    folderUrl: candidateFolder.webViewLink || `https://drive.google.com/drive/folders/${candidateFolder.id}`,
    uploaded,
    transcriptAvailable,
    transcriptKind,
  };
}

async function finalizeDriveArchive(
  source: ArchiveSource,
  accessToken: string,
  prepared: PreparedDriveArchive,
  recordingFile: DriveFile | null,
  reportProgress: DriveSyncProgress,
): Promise<GoogleDriveSyncResult> {
  const uploaded = { ...prepared.uploaded };
  const filePrefix = source.sessionId;
  if (source.recording) {
    if (!recordingFile) throw new Error("GOOGLE_DRIVE_RESUMABLE_UPLOAD_INCOMPLETE");
    const extension = source.recording.contentType.includes("mp4") ? "mp4" : "webm";
    uploaded.recording = fileSummary(recordingFile, `${filePrefix}_面接録画.${extension}`);
  }
  const manifest = {
    schemaVersion: "2026-07-29-v1",
    generatedAt: new Date().toISOString(),
    sessionId: source.sessionId,
    rootFolderId: prepared.rootFolderId,
    folderId: prepared.candidateFolder.id,
    recordingIncluded: Boolean(source.recording),
    transcriptAvailable: prepared.transcriptAvailable,
    transcriptKind: prepared.transcriptKind,
    files: uploaded,
  };
  await reportProgress();
  const manifestFile = await uploadSmallFile({
    accessToken,
    folderId: prepared.candidateFolder.id,
    name: `${filePrefix}_格納結果.json`,
    artifactKey: "manifest",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(manifest, null, 2),
  });
  uploaded.manifest = fileSummary(manifestFile, `${filePrefix}_格納結果.json`);
  await reportProgress();
  const verifiedFiles = await verifyDriveArchive({
    accessToken,
    folder: prepared.candidateFolder,
    expectedParentId: prepared.expectedParentId,
    sessionId: source.sessionId,
    recordingByteSize: source.recording?.byteSize ?? null,
  });
  return {
    status: "completed",
    folderId: prepared.candidateFolder.id,
    folderUrl: prepared.folderUrl,
    uploaded: verifiedFiles,
    recordingIncluded: Boolean(source.recording),
    transcriptAvailable: prepared.transcriptAvailable,
    transcriptKind: prepared.transcriptKind,
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
  };
}

function completedReceiptSatisfiesSource(
  receipt: GoogleDriveSyncResult,
  source: ArchiveSource,
) {
  const transcriptVerified = receipt.transcriptAvailable === true &&
    receipt.transcriptKind === "actual_transcript";
  const recordingVerified = source.recordingStatus === "not_applicable" ||
    (source.recordingStatus === "stored" && receipt.recordingIncluded === true);
  return transcriptVerified && recordingVerified;
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
  return {
    rootFolderId: value.rootFolderId,
    expectedParentId: value.expectedParentId,
    candidateFolder,
    folderUrl: value.folderUrl,
    uploaded,
    transcriptAvailable: value.transcriptAvailable,
    transcriptKind: value.transcriptKind,
  };
}

function preparedArchiveContext(prepared: PreparedDriveArchive): Record<string, unknown> {
  return {
    rootFolderId: prepared.rootFolderId,
    expectedParentId: prepared.expectedParentId,
    candidateFolder: prepared.candidateFolder,
    folderUrl: prepared.folderUrl,
    uploaded: prepared.uploaded,
    transcriptAvailable: prepared.transcriptAvailable,
    transcriptKind: prepared.transcriptKind,
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
}) {
  const result = await finalizeDriveArchive(
    input.source,
    input.accessToken,
    input.prepared,
    input.recordingFile,
    input.reportProgress,
  );
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
    },
  });
  await deleteDriveUploadStep(input.sessionId, input.startedAt);
  return retryRequested ? { ...result, status: "pending" as const } : result;
}

/**
 * Advances a candidate archive by at most one Drive recording chunk. The
 * resumable capability and committed byte offset live in D1, so a Worker
 * cancellation or browser retry resumes the same Google upload instead of
 * replaying a 70 MB transfer inside one public HTTP request.
 */
export async function stepInterviewToGoogleDrive(sessionId: string): Promise<GoogleDriveArchiveStepResult> {
  if ((await missingGoogleDriveConfiguration()).length > 0) {
    throw new Error("GOOGLE_DRIVE_CONFIGURATION_MISSING");
  }

  let current = await getExternalSyncStatus(sessionId);
  const alreadyCompleted = current ? completedResultFromStatus(current) : null;
  if (alreadyCompleted) {
    const source = await getInterviewArchiveSource(sessionId);
    if (!source) throw new Error("INTERVIEW_NOT_FOUND");
    // Receipt flags are not sufficient proof on their own: older rows could be
    // mislabeled while containing only a question placeholder. Cross-check the
    // durable D1 transcript before acknowledging even an otherwise complete
    // Drive receipt.
    if (!hasActualCandidateTranscript(source)) {
      throw new Error("INTERVIEW_TRANSCRIPT_NOT_READY_FOR_DRIVE_SYNC");
    }
    if (completedReceiptSatisfiesSource(alreadyCompleted, source)) return alreadyCompleted;

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
      const accessToken = await fetchGoogleDriveAccessToken();
      const prepared = await prepareDriveArchive(source, accessToken, reportProgress);
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
          },
        });
        return result;
      }
      const extension = source.recording.contentType.includes("mp4") ? "mp4" : "webm";
      const recordingName = `${source.sessionId}_面接録画.${extension}`;
      const uploadLocation = await initiateRecordingUpload({
        accessToken,
        folderId: prepared.candidateFolder.id,
        name: recordingName,
        contentType: source.recording.contentType,
        byteSize: source.recording.byteSize,
      });
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
      await failExternalSync({ sessionId, startedAt, errorCode: safeErrorCode(error) });
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
    await releaseLease().catch(() => undefined);
    if (isTransientDriveError(error)) {
      return pendingStep({
        phase: "retrying",
        folderId: step.folderId,
        folderUrl: step.folderUrl,
        committedOffset: step.committedOffset,
        totalBytes: step.totalBytes,
      });
    }
    await failExternalSync({ sessionId, startedAt: step.startedAt, errorCode: safeErrorCode(error) });
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
