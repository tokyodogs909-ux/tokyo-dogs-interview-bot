import { getRequestExecutionContext } from "vinext/shims/request-context";
import {
  DRIVE_API_ENDPOINT,
  DRIVE_UPLOAD_ENDPOINT,
  fetchGoogleDriveAccessToken,
  missingGoogleDriveConfiguration,
  validateGoogleDriveRoot,
} from "@/lib/google-drive-auth";
import {
  claimExternalSync,
  completeExternalSync,
  failExternalSync,
  getExternalSyncStatus,
  getInterviewArchiveSource,
  requestExternalSync,
} from "@/lib/interview-persistence";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const DRIVE_PROVIDER = "google_drive";
const TRANSIENT_DRIVE_RETRY_DELAY_MS = 600;

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

export type GoogleDriveSyncResult = {
  status: "completed" | "pending";
  folderId: string;
  folderUrl: string;
  uploaded: Record<string, { id: string; name: string; size: number | null }>;
  recordingIncluded: boolean;
};

function safeErrorCode(error: unknown) {
  const code = error instanceof Error ? error.message : "GOOGLE_DRIVE_SYNC_FAILED";
  return /^[A-Z0-9_:-]{3,120}$/.test(code) ? code.slice(0, 120) : "GOOGLE_DRIVE_SYNC_FAILED";
}

function isTransientDriveError(error: unknown) {
  const code = safeErrorCode(error);
  return /^(?:GOOGLE_DRIVE_(?:API|EXPORT|RESUMABLE_INIT|RESUMABLE_UPLOAD)_)(?:429|500|502|503|504)$/.test(code) ||
    code === "GOOGLE_DRIVE_TOKEN_REFRESH_FAILED" ||
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

function buildTranscriptText(source: ArchiveSource) {
  const lines = [
    "TOKYO DOGS オンライン一次面接 文字起こし",
    `面接ID: ${source.sessionId}`,
    `応募者氏名: ${source.candidateName}`,
    `雇用形態: ${source.employment}`,
    `入職希望対象店舗: ${source.preferredLocation}`,
    `面接完了日時: ${japaneseDate(source.completedAt)}`,
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
  const humanReviews = source.humanReviews.length
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
<p class="notice">本資料は採用担当者の確認資料です。システムは合否を自動決定しません。通信・録音・文字起こしの不具合や、顔立ち・容姿・表情・声質等を不利益な評価に使用しません。</p>
<h2>回答評価</h2>
<p>${escapeHtml(evaluation?.summary || "回答評価は未作成です。")}</p>
${dimensions}
<h2>映像確認</h2>
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
  formData.append("media", new Blob([bytes], { type: input.contentType }));
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
  body: ReadableStream;
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
  const initResponse = await fetch(initUrl, {
    method: existing ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": input.contentType,
      "X-Upload-Content-Length": String(input.byteSize),
    },
    body: JSON.stringify(metadata),
  });
  const location = initResponse.headers.get("Location");
  if (!initResponse.ok || !location) throw new Error(`GOOGLE_DRIVE_RESUMABLE_INIT_${initResponse.status}`);
  const uploadResponse = await fetch(location, {
    method: "PUT",
    headers: {
      "Content-Type": input.contentType,
      "Content-Length": String(input.byteSize),
    },
    body: input.body,
  });
  if (!uploadResponse.ok) throw new Error(`GOOGLE_DRIVE_RESUMABLE_UPLOAD_${uploadResponse.status}`);
  return await uploadResponse.json() as DriveFile;
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

async function performDriveSync(source: ArchiveSource): Promise<GoogleDriveSyncResult> {
  if (source.status !== "completed" || !source.evaluation) {
    throw new Error("INTERVIEW_NOT_READY_FOR_DRIVE_SYNC");
  }
  const accessToken = await fetchGoogleDriveAccessToken();
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
  const resultJson = buildResultJson(source);
  const reportHtml = buildReportHtml(source);
  const filePrefix = source.sessionId;
  const uploaded: GoogleDriveSyncResult["uploaded"] = {};
  const transcriptFile = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: `${filePrefix}_文字起こし.txt`,
    artifactKey: "transcript",
    contentType: "text/plain; charset=utf-8",
    body: transcript,
  });
  uploaded.transcript = fileSummary(transcriptFile, `${filePrefix}_文字起こし.txt`);
  const resultFile = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: `${filePrefix}_評価データ.json`,
    artifactKey: "evaluation_json",
    contentType: "application/json; charset=utf-8",
    body: resultJson,
  });
  uploaded.evaluation = fileSummary(resultFile, `${filePrefix}_評価データ.json`);
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
  const pdf = await exportGoogleDocToPdf(accessToken, reportDoc.id);
  const reportPdf = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: `${filePrefix}_オンライン一次面接レポート.pdf`,
    artifactKey: "report_pdf",
    contentType: "application/pdf",
    body: pdf,
  });
  uploaded.reportPdf = fileSummary(reportPdf, `${filePrefix}_オンライン一次面接レポート.pdf`);
  if (source.recording) {
    const extension = source.recording.contentType.includes("mp4") ? "mp4" : "webm";
    const recording = await uploadRecording({
      accessToken,
      folderId: candidateFolder.id,
      name: `${filePrefix}_面接録画.${extension}`,
      contentType: source.recording.contentType,
      byteSize: source.recording.byteSize,
      body: source.recording.body,
    });
    uploaded.recording = fileSummary(recording, `${filePrefix}_面接録画.${extension}`);
  }
  const manifest = {
    schemaVersion: "2026-07-29-v1",
    generatedAt: new Date().toISOString(),
    sessionId: source.sessionId,
    rootFolderId: root.id,
    folderId: candidateFolder.id,
    recordingIncluded: Boolean(source.recording),
    files: uploaded,
  };
  const manifestFile = await uploadSmallFile({
    accessToken,
    folderId: candidateFolder.id,
    name: `${filePrefix}_格納結果.json`,
    artifactKey: "manifest",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(manifest, null, 2),
  });
  uploaded.manifest = fileSummary(manifestFile, `${filePrefix}_格納結果.json`);
  const verifiedFiles = await verifyDriveArchive({
    accessToken,
    folder: candidateFolder,
    expectedParentId: monthFolder.id,
    sessionId: source.sessionId,
    recordingByteSize: source.recording?.byteSize ?? null,
  });
  const folderUrl = candidateFolder.webViewLink || `https://drive.google.com/drive/folders/${candidateFolder.id}`;
  return {
    status: "completed",
    folderId: candidateFolder.id,
    folderUrl,
    uploaded: verifiedFiles,
    recordingIncluded: Boolean(source.recording),
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
        };
      }
      throw new Error("GOOGLE_DRIVE_SYNC_ALREADY_RUNNING");
    }
    try {
      const source = await getInterviewArchiveSource(sessionId);
      if (!source) throw new Error("INTERVIEW_NOT_FOUND");
      lastCompleted = await performDriveSync(source);
      const retryRequested = await completeExternalSync({
        sessionId,
        startedAt,
        folderId: lastCompleted.folderId,
        folderUrl: lastCompleted.folderUrl,
        manifest: {
          files: lastCompleted.uploaded,
          recordingIncluded: lastCompleted.recordingIncluded,
        },
      });
      if (!retryRequested) return lastCompleted;
    } catch (error) {
      await failExternalSync({ sessionId, startedAt, errorCode: safeErrorCode(error) });
      throw error;
    }
  }
  if (lastCompleted) return { ...lastCompleted, status: "pending" };
  throw new Error("GOOGLE_DRIVE_SYNC_DEFERRED");
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

export function scheduleGoogleDriveSync(sessionId: string) {
  const promise = syncInterviewToGoogleDrive(sessionId).catch(() => undefined);
  const context = getRequestExecutionContext();
  if (context) context.waitUntil(promise);
  return Boolean(context);
}
