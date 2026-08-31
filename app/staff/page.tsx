"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import {
  VIDEO_REVIEW_DIMENSIONS,
  type InterviewEvaluation,
  type TranscriptTurn,
} from "@/lib/interview";
import { isVerifiedInterviewArchive } from "@/lib/drive-recovery.js";
import { RECORDED_TRANSCRIPT_EVALUATION_WARNING } from "@/lib/recorded-evaluation-marker";
import {
  buildCandidateReviewOutline,
  buildCandidateValueHighlights,
  buildInterviewQuestionAnswers,
} from "@/lib/interview-review-summary.js";

type VideoScore = {
  name: (typeof VIDEO_REVIEW_DIMENSIONS)[number]["name"];
  score: number | null;
  note: string;
};

type ReviewRecord = {
  sessionId: string;
  candidateName: string;
  employment: string;
  location: string;
  status: string;
  recordingStatus: string;
  transcript: TranscriptTurn[];
  sourceTranscriptVerified: boolean;
  evaluation: InterviewEvaluation | null;
  completedAt: string | null;
  retentionUntil: string;
  videoReviewRubric: typeof VIDEO_REVIEW_DIMENSIONS;
  humanReviews: Array<{
    reviewerName: string;
    videoScores: VideoScore[];
    overallNote: string;
    updatedAt: string;
  }>;
  technicalEvents: Array<{
    type: string;
    detail: Record<string, unknown>;
    createdAt: string;
  }>;
  transcriptDraft: {
    mode: "voice" | "text";
    transcript: TranscriptTurn[];
    turnCount: number;
    sealed: boolean;
    sealedAt: string | null;
    updatedAt: string;
  } | null;
  driveSync: {
    status: "pending" | "running" | "completed" | "failed";
    folderUrl: string | null;
    errorCode: string | null;
    updatedAt: string;
    recordingIncluded: boolean;
    transcriptAvailable: boolean;
    transcriptKind: string;
    archivedArtifactCount: number;
    integrityStatus: "verified" | "drift" | "unknown";
    integrityCheckedAt: string | null;
    integrityErrorCode: string | null;
    sharingRisk: "anyone_writer" | "anyone_reader" | "restricted" | "unknown";
    failureCount: number;
    nextRetryAt: string | null;
    retryBlockedAt: string | null;
    retryBlockReason: string | null;
  } | null;
};

type InterviewListItem = {
  sessionId: string;
  candidateName: string;
  employment: string;
  location: string;
  status: string;
  recordingStatus: string;
  createdAt: string;
  completedAt: string | null;
  retentionUntil: string;
  driveStatus: string | null;
  driveFolderUrl: string | null;
  driveUpdatedAt: string | null;
  driveRecordingIncluded: boolean | null;
  driveTranscriptAvailable: boolean | null;
  driveTranscriptKind: string | null;
  driveIntegrityStatus: "verified" | "drift" | "unknown" | null;
  driveFailureCount: number;
  driveNextRetryAt: string | null;
  driveRetryBlockedAt: string | null;
  driveRetryBlockReason: string | null;
  driveAlertStatus: "open" | "resolved" | null;
  driveAlertSeverity: "warning" | "critical" | null;
  driveAlertCode: string | null;
  driveAlertLastSeenAt: string | null;
  sourceTranscriptVerified: boolean;
  completionHold: boolean;
};

type ArchiveHealth = {
  completedInterviews: number;
  stored: number;
  processing: number;
  attention: number;
  autoRecoveryScheduled: number;
  blocked: number;
  openAlerts: number;
};

const technicalEventLabels: Record<string, string> = {
  audio_playback_blocked: "担当者音声の再生停止",
  transcription_failed: "回答の文字起こし失敗",
  recording_unavailable: "録画または双方音声の欠落",
  connection_failed: "音声・通信接続の失敗",
  candidate_requested_stop: "応募者による中止",
  model_candidate_stop_rejected: "AIまたは内部処理による中止要求を拒否——面接は継続",
  safety_escalation: "安全上の理由による中断——自動評価なし・人手確認必須",
  completion_reason_invalid: "終了理由を確認できず技術保留",
  time_limit_reached: "27分上限後の安全終了",
  reasonable_accommodation_text_selected: "文字入力方式を選択（評価差なし）",
  recording_recovery_part_missing: "録画パート不足——応募者の再開または人手確認待ち",
  recording_recovery_manual_attention: "録画復旧を自動終了し人手確認へ移行",
  legacy_recording_recovery_manual_attention: "旧式録画の不足パートを検出——人手確認が必要",
  interrupted_recording_recovered: "中断時点までに受領済みの録画パートを復旧——末尾欠落の可能性あり",
  interrupted_recording_recovery_manual_attention: "中断録画を自動復旧できず人手確認が必要",
  orphaned_sealed_voice_draft_recovered: "終了時の通信中断から文字起こしを復旧——録画の保存状態を要確認",
  device_session_replaced: "端末中断のため元記録を保全し、文字入力の新受付へ継続",
};

const recommendationLabels = {
  job_related_evidence_complete: "職務関連根拠の確認が可能",
  human_review: "人による要確認",
  insufficient_information: "情報不足",
} as const;

const interviewStatusLabels: Record<string, string> = {
  created: "未開始",
  in_progress: "面接中",
  interrupted: "端末中断・継続先あり",
  evaluation_processing: "評価処理中",
  evaluation_pending: "評価待ち",
  completed: "面接完了",
};

const recordingStatusLabels: Record<string, string> = {
  not_started: "録画前",
  uploading: "録画保存中",
  stored: "録画保存済み",
  failed: "録画要確認",
  not_applicable: "文字入力（録画なし）",
};

function formatInterviewDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "日時未確認";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatRetentionDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function driveArchiveLabel(item: InterviewListItem) {
  if (item.driveRetryBlockedAt) return "自動再試行停止・要確認";
  if (item.driveStatus === "failed") return "Drive要確認";
  if (item.driveStatus === "running") return "Drive格納中";
  if (item.driveStatus === "pending") return "Drive格納待ち";
  if (item.driveStatus !== "completed") return "Drive未格納";
  if (
    item.driveTranscriptKind === "partial_transcript_human_review" &&
    item.driveRecordingIncluded === true &&
    item.driveIntegrityStatus === "verified"
  ) return "技術保留資料をDrive保全済み（人手確認）";
  if (item.sourceTranscriptVerified !== true) return "保存未完了（文字起こし要確認）";
  if (item.driveTranscriptAvailable !== true || item.driveTranscriptKind !== "actual_transcript") {
    return "保存未完了（文字起こし未格納）";
  }
  if (item.recordingStatus === "not_applicable") return "Drive格納済み";
  return item.recordingStatus === "stored" && item.driveRecordingIncluded === true
    ? "動画含め格納済み"
    : "保存未完了（録画未格納）";
}

function driveArchiveClass(item: InterviewListItem) {
  if (item.driveRetryBlockedAt || item.driveAlertStatus === "open") return "attention";
  if (
    item.driveStatus === "completed" &&
    (item.sourceTranscriptVerified !== true || item.driveTranscriptAvailable !== true || item.driveTranscriptKind !== "actual_transcript")
  ) return "attention";
  if (
    item.driveStatus === "completed" &&
    item.recordingStatus !== "not_applicable" &&
    !(item.recordingStatus === "stored" && item.driveRecordingIncluded === true)
  ) return "attention";
  return item.driveStatus ?? "not-started";
}

function interviewInboxStatusLabel(item: InterviewListItem) {
  if (item.completionHold) return "中断・人手確認";
  if (
    item.driveStatus === "completed" &&
    item.driveTranscriptKind === "partial_transcript_human_review"
  ) return "技術保留・人手確認";
  if (item.status !== "completed") return interviewStatusLabels[item.status] ?? item.status;
  return isVerifiedInterviewArchive(item) ? "保存確認済み" : "保存未完了";
}

function isTextInterviewRecord(value: ReviewRecord | null) {
  return Boolean(value?.technicalEvents.some((event) => event.type === "reasonable_accommodation_text_selected"));
}

function isRecordedFallbackReview(value: ReviewRecord | null) {
  return Boolean(value?.transcript.some((turn) => turn.id.startsWith("recorded-transcribed-")));
}

function hasRecordedAutomaticEvaluation(value: ReviewRecord | null) {
  return Boolean(
    isRecordedFallbackReview(value) &&
    value?.evaluation?.evidenceValidationWarnings.includes(RECORDED_TRANSCRIPT_EVALUATION_WARNING),
  );
}

function emptyScores(): VideoScore[] {
  return VIDEO_REVIEW_DIMENSIONS.map((dimension) => ({
    name: dimension.name,
    score: null,
    note: "",
  }));
}

export default function StaffReviewPage() {
  const [reviewer, setReviewer] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [review, setReview] = useState<ReviewRecord | null>(null);
  const [recordingUrl, setRecordingUrl] = useState("");
  const [recordingAudioCoverage, setRecordingAudioCoverage] = useState<"both" | "candidate-only" | "unverified">("unverified");
  const [scores, setScores] = useState<VideoScore[]>(emptyScores);
  const [overallNote, setOverallNote] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "saving" | "syncing">("idle");
  const [message, setMessage] = useState("");
  const [recentInterviews, setRecentInterviews] = useState<InterviewListItem[] | null>(null);
  const [nextInterviewCursor, setNextInterviewCursor] = useState<string | null>(null);
  const [archiveHealth, setArchiveHealth] = useState<ArchiveHealth | null>(null);
  const [listFilter, setListFilter] = useState("");
  const [listLoading, setListLoading] = useState(false);
  const [completionNotice, setCompletionNotice] = useState("");
  const [newCompletedIds, setNewCompletedIds] = useState<Set<string>>(() => new Set());
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unavailable">("unavailable");
  const knownCompletedIdsRef = useRef(new Set<string>());
  const completionMonitorInitializedRef = useRef(false);
  const pollInterviewListRef = useRef<() => Promise<void>>(async () => undefined);
  const driveRecoveryInFlightRef = useRef(new Set<string>());
  const transcriptionRecoveryInFlightRef = useRef(false);
  const knownOpenDriveAlertsRef = useRef(new Set<string>());
  const driveAlertMonitorInitializedRef = useRef(false);

  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  }, [recordingUrl]);

  useEffect(() => {
    pollInterviewListRef.current = async () => loadInterviewList({ silent: true });
  });

  useEffect(() => {
    if (!recentInterviews || !reviewer.trim() || !accessKey) return;
    const timer = window.setInterval(() => void pollInterviewListRef.current(), 15_000);
    return () => window.clearInterval(timer);
  }, [accessKey, recentInterviews, reviewer]);

  function authHeaders() {
    return {
      Authorization: `Bearer ${accessKey}`,
      "X-Interview-Reviewer": encodeURIComponent(reviewer.normalize("NFKC").replace(/\s+/gu, " ").trim()),
    };
  }

  async function loadReview(targetSessionId = sessionId) {
    const requestedSessionId = targetSessionId.trim().toUpperCase();
    if (!requestedSessionId) return;
    setNewCompletedIds((current) => {
      if (!current.has(requestedSessionId)) return current;
      const next = new Set(current);
      next.delete(requestedSessionId);
      return next;
    });
    setSessionId(requestedSessionId);
    setState("loading");
    setMessage("");
    setReview(null);
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl("");
    setRecordingAudioCoverage("unverified");
    try {
      const response = await fetch(`/api/staff/interview?sessionId=${encodeURIComponent(requestedSessionId)}`, {
        headers: authHeaders(),
        cache: "no-store",
      });
      const data = (await response.json()) as { review?: ReviewRecord; error?: string };
      if (!response.ok || !data.review) throw new Error(data.error || "オンライン一次面接記録を取得できませんでした。");
      setReview(data.review);
      const normalizedReviewer = reviewer.normalize("NFKC").replace(/\s+/gu, " ").trim();
      const ownReview = data.review.humanReviews.find((item) => item.reviewerName === normalizedReviewer);
      setScores(ownReview?.videoScores.length ? ownReview.videoScores : emptyScores());
      setOverallNote(ownReview?.overallNote ?? "");
      if (data.review.recordingStatus === "stored") {
        const recordingResponse = await fetch(`/api/staff/recording?sessionId=${encodeURIComponent(requestedSessionId)}`, {
          headers: authHeaders(),
          cache: "no-store",
        });
        if (recordingResponse.ok) {
          const coverage = recordingResponse.headers.get("X-Interview-Audio-Coverage");
          setRecordingAudioCoverage(coverage === "both" || coverage === "candidate-only" ? coverage : "unverified");
          setRecordingUrl(URL.createObjectURL(await recordingResponse.blob()));
        }
      }
      setState("ready");
    } catch (error) {
      setState("idle");
      setMessage(error instanceof Error ? error.message : "オンライン一次面接記録を取得できませんでした。");
    }
  }

  function showBrowserCompletionNotification(items: InterviewListItem[]) {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const first = items[0];
    const body = items.length === 1
      ? `${first.candidateName || "氏名未登録"}さんの面接記録をDriveまで確認しました。`
      : `${items.length}件の面接記録をDriveまで確認しました。`;
    try {
      const notification = new Notification("TOKYO DOGS｜オンライン一次面接完了", {
        body,
        tag: `interview-completed-${items.map((item) => item.sessionId).join("-")}`,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      // The in-page notice remains available when an OS-level notification is blocked.
    }
  }

  function showBrowserStorageFailureNotification(items: InterviewListItem[]) {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const notification = new Notification("TOKYO DOGS｜面接記録の保存要確認", {
        body: items.length === 1
          ? `${items[0].candidateName || "氏名未登録"}さんのDrive保存を自動停止しました。運営画面を確認してください。`
          : `${items.length}件のDrive保存を自動停止しました。運営画面を確認してください。`,
        tag: `interview-drive-alert-${items.map((item) => item.sessionId).join("-")}`,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      // The persistent in-page alert remains authoritative.
    }
  }

  async function enableCompletionNotifications() {
    if (typeof Notification === "undefined") {
      setNotificationPermission("unavailable");
      setCompletionNotice("このブラウザは端末通知に対応していません。画面内の完了通知は自動で表示します。");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      setCompletionNotice(permission === "granted"
        ? "端末の完了通知を有効にしました。担当者画面を開いている間、15秒ごとに新しい完了面接を確認します。"
        : "端末通知は許可されていません。画面内の完了通知は自動で表示します。");
    } catch {
      setCompletionNotice("端末通知を開始できませんでした。画面内の完了通知は自動で表示します。");
    }
  }

  async function recoverDriveArchives(sessionIds: string[]) {
    for (const targetSessionId of sessionIds.slice(0, 3)) {
      if (driveRecoveryInFlightRef.current.has(targetSessionId)) continue;
      driveRecoveryInFlightRef.current.add(targetSessionId);
      try {
        const response = await fetch("/api/staff/google-drive/sync", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: targetSessionId }),
        });
        if (!response.ok) {
          setCompletionNotice("Drive自動復旧を完了できない記録があります。「Drive・レポートを更新」で再確認してください。");
        }
      } catch {
        setCompletionNotice("Drive自動復旧を完了できない記録があります。「Drive・レポートを更新」で再確認してください。");
      } finally {
        driveRecoveryInFlightRef.current.delete(targetSessionId);
      }
    }
  }

  async function recoverRecordedTranscriptions() {
    if (transcriptionRecoveryInFlightRef.current) return;
    transcriptionRecoveryInFlightRef.current = true;
    try {
      const response = await fetch("/api/staff/transcriptions/recover", {
        method: "POST",
        headers: authHeaders(),
      });
      const data = (await response.json().catch(() => null)) as {
        recording?: { state?: string } | null;
        transcription?: { state?: string } | null;
        evaluation?: { state?: string } | null;
      } | null;
      if (!response.ok) {
        setCompletionNotice("録画回答の文字起こしを自動復旧できない記録があります。管理者設定を確認してください。");
      } else if (data?.recording?.state === "failed" || data?.recording?.state === "incomplete") {
        setCompletionNotice("完了情報はありますが、録画パーツが不足または破損している記録があります。手動確認してください。");
      } else if (data?.transcription?.state === "failed") {
        setCompletionNotice("自動文字起こしできない回答音声があります。録画を手動確認してください。");
      } else if (data?.transcription?.state === "pending") {
        setCompletionNotice("完了操作済みの回答音声を文字起こし待ちです。担当者画面を開いている間、間隔を空けて再試行します。");
      } else if (data?.evaluation?.state === "completed") {
        setCompletionNotice("中断していた評価整理を自動採点なしの人手確認記録として復旧しました。Drive格納確認を続けます。");
      }
    } catch {
      setCompletionNotice("録画回答の文字起こし自動復旧が一時停止しました。担当者画面で一覧を更新してください。");
    } finally {
      transcriptionRecoveryInFlightRef.current = false;
    }
  }

  async function loadInterviewList(options: { silent?: boolean; append?: boolean } = {}) {
    if (!options.silent) {
      setListLoading(true);
      setMessage("");
    }
    try {
      const searchParams = new URLSearchParams();
      if (options.silent) searchParams.set("poll", "1");
      if (options.append && nextInterviewCursor) searchParams.set("cursor", nextInterviewCursor);
      const response = await fetch(`/api/staff/interviews${searchParams.size ? `?${searchParams}` : ""}`, {
        headers: authHeaders(),
        cache: "no-store",
      });
      const data = (await response.json()) as {
        interviews?: InterviewListItem[];
        nextCursor?: string | null;
        driveRecoverySessionIds?: string[];
        archiveHealth?: ArchiveHealth;
        error?: string;
      };
      if (!response.ok || !data.interviews) throw new Error(data.error || "候補者一覧を取得できませんでした。");
      if (!options.append) setArchiveHealth(data.archiveHealth ?? null);
      setNotificationPermission(typeof Notification === "undefined" ? "unavailable" : Notification.permission);
      if (!options.append) {
        const openDriveAlerts = data.interviews.filter((item) => item.driveAlertStatus === "open");
        if (!driveAlertMonitorInitializedRef.current) {
          knownOpenDriveAlertsRef.current = new Set(openDriveAlerts.map((item) => item.sessionId));
          driveAlertMonitorInitializedRef.current = true;
        } else {
          const newlyOpenedAlerts = openDriveAlerts.filter((item) =>
            !knownOpenDriveAlertsRef.current.has(item.sessionId));
          openDriveAlerts.forEach((item) => knownOpenDriveAlertsRef.current.add(item.sessionId));
          if (newlyOpenedAlerts.length > 0) {
            setCompletionNotice(`保存要確認：${newlyOpenedAlerts.length}件のDrive自動再試行を停止しました。候補者記録を確認してください。`);
            showBrowserStorageFailureNotification(newlyOpenedAlerts);
          }
        }
        const completedItems = data.interviews.filter((item) => isVerifiedInterviewArchive(item) && item.completedAt);
        if (!completionMonitorInitializedRef.current) {
          knownCompletedIdsRef.current = new Set(completedItems.map((item) => item.sessionId));
          completionMonitorInitializedRef.current = true;
          setCompletionNotice("完了通知を開始しました。担当者画面を開いている間、15秒ごとに新しい完了面接を確認します。");
        } else {
          const newlyCompleted = completedItems.filter((item) => !knownCompletedIdsRef.current.has(item.sessionId));
          completedItems.forEach((item) => knownCompletedIdsRef.current.add(item.sessionId));
          if (newlyCompleted.length > 0) {
            setNewCompletedIds((current) => new Set([...current, ...newlyCompleted.map((item) => item.sessionId)]));
            const names = newlyCompleted.map((item) => item.candidateName || "氏名未登録").join("、");
            setCompletionNotice(`保存確認完了：${names}。必要な面接記録をDriveまで再照合済みです。`);
            showBrowserCompletionNotification(newlyCompleted);
          }
        }
      }
      if (options.silent || options.append) {
        setRecentInterviews((current) => {
          const merged = [...(options.silent ? data.interviews ?? [] : current ?? []),
            ...(options.silent ? current ?? [] : data.interviews ?? [])];
          const seen = new Set<string>();
          return merged.filter((item) => {
            if (seen.has(item.sessionId)) return false;
            seen.add(item.sessionId);
            return true;
          }).sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.sessionId.localeCompare(left.sessionId));
        });
      } else {
        setRecentInterviews(data.interviews);
      }
      if (!options.silent) setNextInterviewCursor(data.nextCursor ?? null);
      void recoverRecordedTranscriptions();
      if (data.driveRecoverySessionIds?.length) void recoverDriveArchives(data.driveRecoverySessionIds);
      if (!options.silent) {
        setMessage(options.append
          ? `過去のオンライン一次面接を${data.interviews.length}件追加しました。`
          : data.interviews.length > 0
          ? `最近のオンライン一次面接を${data.interviews.length}件表示しました。`
          : "オンライン一次面接の記録はまだありません。");
      }
    } catch (error) {
      if (!options.silent) {
        if (!options.append) {
          setRecentInterviews(null);
          setArchiveHealth(null);
          setNextInterviewCursor(null);
        }
        setMessage(error instanceof Error ? error.message : "候補者一覧を取得できませんでした。");
      } else {
        setCompletionNotice("完了通知の自動確認が一時的に止まりました。「一覧を更新」を押してください。");
      }
    } finally {
      if (!options.silent) setListLoading(false);
    }
  }

  function logoutStaff() {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setReviewer("");
    setAccessKey("");
    setSessionId("");
    setReview(null);
    setRecordingUrl("");
    setRecentInterviews(null);
    setNextInterviewCursor(null);
    setArchiveHealth(null);
    completionMonitorInitializedRef.current = false;
    knownCompletedIdsRef.current.clear();
    knownOpenDriveAlertsRef.current.clear();
    driveAlertMonitorInitializedRef.current = false;
    setNewCompletedIds(new Set());
    setCompletionNotice("");
    setListFilter("");
    setMessage("運営画面からログアウトしました。");
    setState("idle");
  }

  async function copyCandidateLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/`);
      setMessage("候補者へ送る共通URLをコピーしました。");
    } catch {
      setMessage(`候補者用URL: ${window.location.origin}/`);
    }
  }

  function updateScore(name: VideoScore["name"], patch: Partial<VideoScore>) {
    setScores((current) => current.map((item) => item.name === name ? { ...item, ...patch } : item));
  }

  const reviewedVideoDimensions = scores.filter((item) => item.score !== null).length;
  const textInterviewSelected = isTextInterviewRecord(review);
  const recordedFallbackSelected = isRecordedFallbackReview(review);
  const recordedAutomaticEvaluation = hasRecordedAutomaticEvaluation(review);
  const legacyRecordedFallbackSelected = recordedFallbackSelected && !recordedAutomaticEvaluation;
  const reviewTranscript = review?.transcript.length
    ? review.transcript
    : review?.transcriptDraft?.transcript ?? [];
  const questionAnswers = buildInterviewQuestionAnswers(reviewTranscript);
  const visibleQuestionAnswers = questionAnswers.slice(0, 8);
  const remainingQuestionAnswers = questionAnswers.slice(8);
  const valueHighlights = buildCandidateValueHighlights(review?.evaluation ?? null);
  const evidenceBackedAnalysis = valueHighlights.length > 0;
  const reviewOutline = buildCandidateReviewOutline(review?.evaluation ?? null);
  const interviewModeLabel = textInterviewSelected
    ? "文字入力"
    : recordedFallbackSelected
      ? "録画式"
      : "通常音声";
  const transcriptStatusLabel = review?.sourceTranscriptVerified
    ? "実回答の議事録あり"
    : review?.transcriptDraft && !review.transcriptDraft.sealed
      ? "中断時点の未確定記録"
      : "議事録未確認";
  const normalizedFilter = listFilter.normalize("NFKC").trim().toLowerCase();
  const filteredInterviews = (recentInterviews ?? []).filter((item) => !normalizedFilter || [
    item.candidateName,
    item.sessionId,
    item.employment,
    item.location,
  ].some((value) => value.normalize("NFKC").toLowerCase().includes(normalizedFilter)));

  async function saveVideoReview() {
    if (!review) return;
    setState("saving");
    setMessage("");
    try {
      const response = await fetch("/api/staff/review", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: review.sessionId, scores, overallNote }),
      });
      const data = (await response.json()) as { stored?: boolean; error?: string };
      if (!response.ok || !data.stored) throw new Error(data.error || "映像評価を保存できませんでした。");
      await syncGoogleDrive({
        successPrefix: `${reviewer.normalize("NFKC").replace(/\s+/gu, " ").trim()}の映像評価を保存し、`,
        failurePrefix: "映像評価は保存しましたが、",
      });
    } catch (error) {
      setState("ready");
      setMessage(error instanceof Error ? error.message : "映像評価を保存できませんでした。");
    }
  }

  async function syncGoogleDrive(options: {
    successPrefix?: string;
    failurePrefix?: string;
    confirmMissingRecordingAcrossDrive?: boolean;
  } = {}) {
    if (!review) return;
    setState("syncing");
    setMessage("");
    try {
      const releasingHold = Boolean(review.driveSync?.retryBlockedAt);
      const response = await fetch(releasingHold
        ? "/api/staff/google-drive/retry"
        : "/api/staff/google-drive/sync", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: review.sessionId,
          confirmMissingRecordingAcrossDrive:
            options.confirmMissingRecordingAcrossDrive === true,
        }),
      });
      const data = (await response.json()) as {
        synced?: boolean;
        result?: {
          status: "completed" | "pending";
          folderUrl: string;
          recordingIncluded: boolean;
          transcriptAvailable: boolean;
          transcriptKind: string;
          uploaded: Record<string, unknown>;
          integrity?: {
            status: "verified" | "drift" | "unknown";
            checkedAt: string;
            errorCode: string | null;
            sharingRisk: "anyone_writer" | "anyone_reader" | "restricted" | "unknown";
          };
        };
        error?: string;
      };
      if (!response.ok || !data.result) throw new Error(data.error || "Google Driveへの格納を完了できませんでした。");
      setReview((current) => current ? {
        ...current,
        driveSync: {
          status: data.result?.status ?? "completed",
          folderUrl: data.result?.folderUrl ?? null,
          errorCode: null,
          updatedAt: new Date().toISOString(),
          recordingIncluded: data.result?.recordingIncluded === true,
          transcriptAvailable: data.result?.transcriptAvailable === true,
          transcriptKind: data.result?.transcriptKind ?? "unknown",
          archivedArtifactCount: Object.keys(data.result?.uploaded ?? {}).length,
          integrityStatus: data.result?.integrity?.status ?? current.driveSync?.integrityStatus ?? "unknown",
          integrityCheckedAt: data.result?.integrity?.checkedAt ?? current.driveSync?.integrityCheckedAt ?? null,
          integrityErrorCode: data.result?.integrity?.errorCode ?? current.driveSync?.integrityErrorCode ?? null,
          sharingRisk: data.result?.integrity?.sharingRisk ?? current.driveSync?.sharingRisk ?? "unknown",
          failureCount: data.result?.status === "completed" ? 0 : current.driveSync?.failureCount ?? 0,
          nextRetryAt: null,
          retryBlockedAt: null,
          retryBlockReason: null,
        },
      } : current);
      setState("ready");
      const transcriptVerified = review.sourceTranscriptVerified === true &&
        data.result.transcriptAvailable === true &&
        data.result.transcriptKind === "actual_transcript";
      const integrityStatus = data.result.integrity?.status ?? "unknown";
      const resultMessage = integrityStatus === "drift"
        ? "Google Drive上の保存後差分を検出しました。格納完了とは扱わず、対象成果物を確認してください。"
        : integrityStatus !== "verified"
          ? "Google Drive上の現在内容は照合未完です。格納完了とは扱わず、再確認してください。"
          : data.result.status === "completed"
            ? !transcriptVerified
          ? "Google Driveへ成果物は送信されましたが、実際の文字起こしを確認できていません。保存未完了として再確認してください。"
          : data.result.recordingIncluded
            ? "Google Driveへの録画・文字起こし・評価・PDFの格納を完了しました。"
            : isTextInterviewRecord(review)
              ? "文字入力による回答・評価・PDFのGoogle Drive格納を完了しました。"
              : "文字起こし・評価・PDFを格納しましたが、録画はまだ格納されていません。録画保存状態を確認してください。"
            : "Google Driveへの再格納を予約しました。";
      setMessage(`${options.successPrefix ?? ""}${resultMessage}`);
    } catch (error) {
      setState("ready");
      const detail = error instanceof Error ? error.message : "Google Driveへの格納を完了できませんでした。";
      setMessage(`${options.failurePrefix ?? ""}${detail}`);
    }
  }

  return (
    <main className="staff-shell">
      <header className="site-header staff-header">
        <div className="brand-button">
          <img src="/tokyo-dogs-logo.jpg" alt="Tokyo Dogs" />
          <span><strong>TOKYO DOGS</strong><small>OFFICIAL SELECTION REVIEW</small></span>
        </div>
        <div className="staff-header-actions"><button type="button" onClick={() => void copyCandidateLink()}>候補者用URLをコピー</button><a href="/staff/invites">個別リンク発行</a><a href="/staff/google-drive">Drive接続設定</a><span className="test-pill">採用担当者専用</span></div>
      </header>

      <section className="staff-operation-guide" aria-label="初めての採用担当者向け運用手順">
        <div>
          <p className="eyebrow">SIMPLE OPERATION GUIDE</p>
          <h2>運用は3ステップです</h2>
          <p>候補者ごとのリンク発行やフォルダ作成は不要です。全員に同じURLを案内すると、面接と保存が候補者別に自動で進みます。</p>
        </div>
        <ol>
          <li><strong>1. 共通URLを案内</strong><span>上の「候補者用URLをコピー」を押し、候補者へ送ります。</span></li>
          <li><strong>2. 面接完了後に一覧を確認</strong><span>担当者表示名（自己申告）と共通アクセスキーを入力し、「候補者一覧を表示」を押します。</span></li>
          <li><strong>3. 保存完了を確認</strong><span>通常面接は「面接完了・録画保存済み・Drive格納済み」、文字入力方式は「面接完了・Drive格納済み」を確認します。</span></li>
        </ol>
        <p className="staff-operation-alert"><strong>「要確認」がある場合</strong> 候補者を不利に評価せず、記録を開いて技術フラグを確認してください。Driveまたはレポートだけが未完了の場合は「Drive・レポートを更新」を押します。</p>
      </section>

      <section className="staff-login">
        <div><p className="eyebrow">SHARED RECRUITER ACCESS</p><h1>公式選考レビュー</h1><p>担当者表示名（自己申告）と共通アクセスキーでログインすると、最近の候補者一覧から記録を選べます。表示名は個人認証済みの本人情報ではありません。閲覧と保存操作は監査ログへ記録され、表示名は自己申告として扱われます。</p></div>
        <div className="staff-login-form">
          <label>担当者表示名（自己申告）<input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="例：採用担当" autoComplete="name" maxLength={40} /></label>
          <label>共通アクセスキー<input type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} autoComplete="current-password" /></label>
          <button className="primary-action" onClick={() => void loadInterviewList()} disabled={!reviewer.trim() || !accessKey || listLoading}>{listLoading ? "確認中…" : "候補者一覧を表示"} <span>→</span></button>
        </div>
      </section>

      {message && <div className="staff-message">{message}</div>}

      {recentInterviews && completionNotice && (
        <div className="staff-completion-notice" role="status" aria-live="polite">
          <div><strong>面接完了通知</strong><span>{completionNotice}</span></div>
          {notificationPermission !== "granted" && (
            <button type="button" onClick={() => void enableCompletionNotifications()}>端末通知を有効にする</button>
          )}
        </div>
      )}

      {recentInterviews && (
        <section className="staff-inbox" aria-label="最近のオンライン一次面接">
          <div className="staff-inbox-heading">
            <div><p className="eyebrow">INTERVIEW INBOX</p><h2>候補者一覧</h2><span>氏名または店舗で検索し、対象の記録を選択してください。</span></div>
            <div className="staff-inbox-actions"><button type="button" onClick={() => void loadInterviewList()} disabled={listLoading}>一覧を更新</button><button type="button" onClick={logoutStaff}>ログアウト</button></div>
          </div>
          {archiveHealth && archiveHealth.completedInterviews > 0 && (
            <div className={`archive-health ${archiveHealth.attention > 0 ? "attention" : "healthy"}`} role="status" aria-live="polite">
              <div>
                <strong>{archiveHealth.attention > 0 ? "保存未完了の記録があります" : "自動格納は正常です"}</strong>
                <span>面接完了 {archiveHealth.completedInterviews}件・Drive格納済み {archiveHealth.stored}件{archiveHealth.processing > 0 ? `・処理中 ${archiveHealth.processing}件` : ""}</span>
              </div>
              {archiveHealth.attention > 0 && (
                <small>{archiveHealth.blocked > 0
                  ? `${archiveHealth.blocked}件は重複防止のため自動再試行を停止し、保存失敗通知へ移しました。既存のDriveフォルダを確認してください。`
                  : archiveHealth.autoRecoveryScheduled > 0
                  ? `${archiveHealth.autoRecoveryScheduled}件を復旧対象として確認しました。サーバーの定期復旧でも処理を継続します。`
                  : `${archiveHealth.attention}件は復旧の待機中または自動再実行の対象外です。「Drive・レポートを更新」で状態を確認してください。`}</small>
              )}
            </div>
          )}
          <div className="staff-inbox-tools">
            <label>候補者を検索<input value={listFilter} onChange={(event) => setListFilter(event.target.value)} placeholder="氏名・店舗・面接ID" /></label>
            <div className="manual-session-open"><label>面接IDを直接指定<input value={sessionId} onChange={(event) => setSessionId(event.target.value.toUpperCase())} placeholder="TD-..." autoCapitalize="characters" /></label><button type="button" onClick={() => void loadReview()} disabled={!sessionId.trim() || state === "loading"}>開く</button></div>
          </div>
          <div className="staff-inbox-list">
            {filteredInterviews.map((item) => (
              <button type="button" className={`${review?.sessionId === item.sessionId ? "active" : ""} ${newCompletedIds.has(item.sessionId) ? "new-completion" : ""}`.trim()} key={item.sessionId} onClick={() => void loadReview(item.sessionId)} disabled={state === "loading"}>
                <span className="staff-inbox-name"><strong>{item.candidateName || "氏名未登録"}{newCompletedIds.has(item.sessionId) && <em>新着完了</em>}</strong><small>{item.employment}・{item.location}</small></span>
                <span className="staff-inbox-state"><strong>{interviewInboxStatusLabel(item)}</strong><small>{recordingStatusLabels[item.recordingStatus] ?? item.recordingStatus}</small></span>
                <span className="staff-inbox-date"><strong>{formatInterviewDate(item.createdAt)}</strong><small>保存見直し {formatRetentionDate(item.retentionUntil)}</small><small>{item.sessionId}</small></span>
                <span className={`staff-inbox-drive drive-${driveArchiveClass(item)}`}>{driveArchiveLabel(item)}</span>
                <span className="staff-inbox-arrow">→</span>
              </button>
            ))}
            {filteredInterviews.length === 0 && <div className="staff-inbox-empty">該当する候補者はありません。</div>}
          </div>
          {nextInterviewCursor && <div className="staff-inbox-actions"><button type="button" onClick={() => void loadInterviewList({ append: true })} disabled={listLoading}>{listLoading ? "読込中…" : "過去50件をさらに表示"}</button></div>}
        </section>
      )}

      {review && (
        <section className="staff-review">
          <div className="staff-meta"><div><span>氏名</span><strong>{review.candidateName || "旧テスト記録"}</strong></div><div><span>面接ID</span><strong>{review.sessionId}</strong></div><div><span>雇用形態</span><strong>{review.employment}</strong></div><div><span>入職希望対象店舗</span><strong>{review.location}</strong></div><div><span>保存見直し</span><strong>{formatRetentionDate(review.retentionUntil)}</strong></div><div><span>状態</span><strong>{review.status}</strong></div></div>

          <section className="staff-panel candidate-brief-panel">
            <div className="panel-title"><p>CANDIDATE BRIEF</p><h2>受験者の要点</h2></div>
            <div className="candidate-brief-status" aria-label="面接記録の要点">
              <div><span>参加方法</span><strong>{interviewModeLabel}</strong></div>
              <div><span>質問・回答</span><strong>{questionAnswers.length > 0 ? `${questionAnswers.length}組` : "未確認"}</strong></div>
              <div><span>議事録</span><strong>{transcriptStatusLabel}</strong></div>
              <div><span>分析</span><strong>{evidenceBackedAnalysis ? "回答根拠あり" : review.evaluation ? "人手確認" : "未作成"}</strong></div>
              <div><span>録画</span><strong>{recordingStatusLabels[review.recordingStatus] ?? review.recordingStatus}</strong></div>
              <div><span>Drive</span><strong>{review.driveSync?.status === "completed" && review.driveSync.integrityStatus === "verified" ? "格納・照合済み" : "要確認"}</strong></div>
            </div>
            <div className="candidate-brief-columns">
              <div>
                <h3>価値観・考え方</h3>
                <p className="candidate-brief-summary">{reviewOutline.summary}</p>
                {valueHighlights.length > 0 ? <div className="candidate-value-grid">
                  {valueHighlights.map((item) => <article key={item.label}><span>{item.label}</span><p>{item.text}</p>{item.evidenceCount > 0 && <small>回答根拠 {item.evidenceCount}件</small>}</article>)}
                </div> : <div className="candidate-brief-empty">回答根拠を伴う価値観・考え方の要約は未作成です。議事録と録画を人が確認してください。</div>}
              </div>
              <div className="candidate-checkpoints">
                <h3>確認ポイント</h3>
                <dl>
                  <div><dt>強み</dt><dd>{reviewOutline.strengths.length ? reviewOutline.strengths.join(" / ") : "未確認"}</dd></div>
                  <div><dt>希望条件</dt><dd>{reviewOutline.conditions.length ? reviewOutline.conditions.join(" / ") : "未確認"}</dd></div>
                  <div><dt>追加確認</dt><dd>{reviewOutline.missingTopics.length ? reviewOutline.missingTopics.join(" / ") : "なし"}</dd></div>
                  <div><dt>懸念・要確認</dt><dd>{reviewOutline.concerns.length ? reviewOutline.concerns.join(" / ") : "なし"}</dd></div>
                </dl>
              </div>
            </div>
            <div className="candidate-question-heading"><div><h3>質問事項からの返答</h3><p>発言を言い換えず、面接順の質問・確認と応募者回答を並べています。</p></div><span>{questionAnswers.length}組</span></div>
            {visibleQuestionAnswers.length > 0 ? <div className="candidate-question-list">
              {visibleQuestionAnswers.map((item) => <article key={`${item.number}-${item.answerTurnIds.join("-")}`}><span>Q{item.number}</span><div><strong>{item.question}</strong><p>{item.answer}</p></div></article>)}
            </div> : <div className="candidate-brief-empty">質問と実回答の組み合わせを確認できません。未確定記録がある場合は技術保留欄をご確認ください。</div>}
            {remainingQuestionAnswers.length > 0 && <details className="candidate-question-more"><summary>残り{remainingQuestionAnswers.length}組の質問・回答を表示</summary><div className="candidate-question-list">
              {remainingQuestionAnswers.map((item) => <article key={`${item.number}-${item.answerTurnIds.join("-")}`}><span>Q{item.number}</span><div><strong>{item.question}</strong><p>{item.answer}</p></div></article>)}
            </div></details>}
            <p className="guardrail-copy"><strong>この要約は合否判断ではありません。</strong> 文字起こし内の回答と既存評価を整理した補助表示です。通常音声・録画式は、採用判断前に保存録画と照合してください。</p>
          </section>

          <section className="staff-panel drive-sync-panel">
            <div className="panel-title"><p>GOOGLE DRIVE ARCHIVE</p><h2>面接記録の自動格納</h2></div>
            <p>面接完了後、応募者氏名と面接IDの専用フォルダへ、録画・文字起こし・評価データ・PDFレポート・格納結果を保存します。同じ面接IDで再実行しても既存ファイルを更新します。</p>
            <div className="drive-sync-actions">
              <span className={`drive-sync-status drive-sync-${review.driveSync?.status ?? "not-started"}`}>
                {review.driveSync?.retryBlockedAt ? "自動再試行停止・要確認"
                  : review.driveSync?.status === "completed" ? review.driveSync.integrityStatus === "drift" ? "差分検出（要確認）" : review.driveSync.integrityStatus !== "verified" ? "照合未完" : review.driveSync.transcriptKind === "partial_transcript_human_review" ? "技術保留記録を格納（人手確認必須）" : review.sourceTranscriptVerified !== true ? "保存未完了（文字起こし要確認）" : review.driveSync.transcriptAvailable !== true || review.driveSync.transcriptKind !== "actual_transcript" ? "保存未完了（文字起こし未格納）" : review.driveSync.recordingIncluded ? "録画を含め格納完了" : textInterviewSelected ? "回答記録を格納完了" : "録画未格納"
                  : review.driveSync?.status === "running" ? "格納中"
                    : review.driveSync?.status === "pending" ? "格納待ち"
                      : review.driveSync?.status === "failed" ? "要再実行"
                        : "未実行"}
              </span>
              {review.driveSync?.folderUrl && <a href={review.driveSync.folderUrl} target="_blank" rel="noreferrer">保存フォルダを開く ↗</a>}
              <button className="secondary-action" onClick={() => void syncGoogleDrive()} disabled={state === "syncing" || review.status !== "completed"}>
                {state === "syncing" ? "更新中…" : review.driveSync?.retryBlockedAt ? "安全に1回だけ再試行" : "Drive・レポートを更新"}
              </button>
              {review.driveSync?.integrityErrorCode === "GOOGLE_DRIVE_ARCHIVE_RECORDING_MISSING" &&
                <button
                  className="secondary-action"
                  onClick={() => {
                    const confirmed = window.confirm(
                      "Drive全体とゴミ箱に、この面接IDの動画が残っていないことを確認しましたか？ 確認済みの場合だけ、保存済み原本から動画のみを復旧します。",
                    );
                    if (confirmed) void syncGoogleDrive({
                      confirmMissingRecordingAcrossDrive: true,
                    });
                  }}
                  disabled={state === "syncing" || review.status !== "completed"}
                >
                  {state === "syncing" ? "復旧中…" : "動画欠落を確認して復旧"}
                </button>}
            </div>
            {review.driveSync?.status === "completed" && <div className="validation-box">
              <strong>Drive整合性：{review.driveSync.integrityStatus === "verified"
                ? "確認済み"
                : review.driveSync.integrityStatus === "drift"
                  ? "保存後の差分を検出"
                  : "未確認"}</strong>
              <p>{review.driveSync.integrityStatus === "verified"
                ? "Drive上のフォルダと成果物が保存時の記録と一致しています。"
                : review.driveSync.integrityStatus === "drift"
                  ? "Drive上の内容と保存時の記録が一致しません。担当者が対象成果物を確認してください。"
                  : "Drive上の現在内容と保存時の記録をまだ照合できていません。"}</p>
              <p>最終照合：{review.driveSync.integrityCheckedAt
                ? formatInterviewDate(review.driveSync.integrityCheckedAt)
                : "日時未確認"}</p>
              <p>共有状態：{review.driveSync.sharingRisk === "anyone_writer"
                ? "現状維持・リンク保有者が編集可能"
                : review.driveSync.sharingRisk === "anyone_reader"
                  ? "リンク保有者が閲覧可能"
                  : review.driveSync.sharingRisk === "restricted"
                    ? "制限付き共有"
                    : "共有範囲未確認"}</p>
            </div>}
            {review.driveSync?.retryBlockedAt
              ? <p className="guardrail-copy"><strong>重複防止のため自動再試行を停止しています。</strong> 既存のDriveフォルダを確認後、必要な場合だけ「安全に1回だけ再試行」を押してください。失敗した場合は自動で再停止し、応募者の評価状態には影響しません。</p>
              : review.driveSync?.status === "failed" && <p className="guardrail-copy">次回再試行まで待機しています。自動連続実行は行わず、応募者の評価状態には影響しません。</p>}
            {review.driveSync?.status === "completed" && review.driveSync.transcriptKind === "partial_transcript_human_review" && <p className="guardrail-copy"><strong>録画と中断時点までの一部文字起こしを、技術保留記録として格納しています。</strong> 面接完了・自動評価・合否判断の証明ではありません。録画と回答を人が照合し、再面接の要否を判断してください。</p>}
            {review.driveSync?.status === "completed" && review.sourceTranscriptVerified !== true && <p className="guardrail-copy"><strong>元の回答記録に文字起こし欠落または未確認の発言があります。</strong> Driveの表示にかかわらず保存完了とは扱わず、録画と回答を確認してください。</p>}
            {review.driveSync?.status === "completed" && review.sourceTranscriptVerified === true && (review.driveSync.transcriptAvailable !== true || review.driveSync.transcriptKind !== "actual_transcript") && <p className="guardrail-copy"><strong>実際の発言に基づく文字起こしをDriveで確認できていません。</strong> 保存完了とは扱わず、文字起こし処理後に再格納してください。</p>}
            {review.driveSync?.status === "completed" && review.sourceTranscriptVerified === true && review.driveSync.transcriptAvailable === true && review.driveSync.transcriptKind === "actual_transcript" && !review.driveSync.recordingIncluded && !textInterviewSelected && <p className="guardrail-copy"><strong>録画はDriveへ格納されていません。</strong> 文字起こし・評価・PDFのみ格納済みです。録画状態が「stored」になった後に再格納してください。</p>}
            {review.driveSync?.status === "completed" && review.sourceTranscriptVerified === true && review.driveSync.transcriptAvailable === true && review.driveSync.transcriptKind === "actual_transcript" && textInterviewSelected && <p className="guardrail-copy">文字入力方式のため録画はありません。回答記録・評価・PDFをDrive側で再照合済みです。</p>}
            {review.driveSync?.status === "completed" && review.sourceTranscriptVerified === true && review.driveSync.recordingIncluded && review.driveSync.transcriptAvailable === true && review.driveSync.transcriptKind === "actual_transcript" && <p className="guardrail-copy">録画を含む{review.driveSync.archivedArtifactCount}種類の格納結果をDrive側で再照合済みです。</p>}
          </section>

          {review.technicalEvents.length > 0 && <div className="staff-message"><strong>進行・技術フラグあり——合否判断前に再確認してください</strong><ul>{review.technicalEvents.map((event, index) => <li key={`${event.type}-${event.createdAt}-${index}`}>{technicalEventLabels[event.type] ?? event.type}</li>)}</ul><p>参加方法や技術的な事象は、応募者の不利益な評価に使用しません。</p></div>}
          {review.transcriptDraft && !review.transcriptDraft.sealed && <section className="staff-panel">
            <div className="panel-title"><p>INTERRUPTED DRAFT</p><h2>中断時点までの未確定文字起こし</h2></div>
            <div className="validation-box"><strong>面接完了・録画照合・評価の根拠には使用できません</strong><p>サーバーが中断前に受領した{review.transcriptDraft.turnCount}ターンの下書きです。末尾欠落や誤認識の可能性があるため、復旧録画と人が照合し、再面接の要否を判断してください。</p></div>
            <ol className="transcript-list">{review.transcriptDraft.transcript.map((turn) => <li key={turn.id}><strong>{turn.speaker === "candidate" ? "応募者" : "AI面接官"}</strong><span>{turn.text}</span></li>)}</ol>
          </section>}
          {review.evaluation && !legacyRecordedFallbackSelected && <p className="guardrail-copy"><strong>回答評価は応募者の回答記録を基にした補助情報です。</strong> 合否判断前に、{textInterviewSelected ? "入力された回答" : "録画の実際の発言"}と根拠引用を採用担当者が照合してください。</p>}
          {recordedAutomaticEvaluation && <p className="guardrail-copy"><strong>録画式の自動分析は、自動文字起こし由来・録画未照合です。人手確認が必須で、自動合否は行いません。</strong> 採用担当者が録画の実際の発言と根拠引用を照合し、技術不具合や録画・音声品質を応募者の不利益に扱わないでください。</p>}
          {legacyRecordedFallbackSelected && <p className="guardrail-copy"><strong>録画式は自動評価していません。人手による録画照合が必須です。</strong> 自動文字起こしは回答整理の補助情報であり、録画の実際の発言との一致は未照合です。技術不具合や録画・音声品質を応募者の不利益に扱わないでください。</p>}

          <div className="staff-grid">
            <article className="staff-panel recording-panel">
              <div className="panel-title"><p>録画確認</p><h2>接客ロールプレイ</h2></div>
              {recordingUrl ? <video src={recordingUrl} controls playsInline /> : <div className="recording-empty">{textInterviewSelected ? "文字入力方式のため録画はありません。回答記録をご確認ください。" : "録画を取得できないか、録画がまだ保存されていません。"}</div>}
              {recordingUrl && recordedFallbackSelected && <p className="guardrail-copy"><strong>録画式の保存動画は人手照合必須です。</strong> 質問文と自動文字起こしは別記録として保存されています。録画を再生して応募者の実際の回答と照合し、技術不具合を不利益に扱わないでください。</p>}
              {recordingUrl && !recordedFallbackSelected && recordingAudioCoverage !== "both" && <p className="guardrail-copy"><strong>保存状態：録画ファイルは保存済みです。</strong> <strong>品質状態：録画内の双方音声は未確認です。</strong> 保存完了は音声品質の確認完了を意味しません。映像と文字起こしを照合し、技術不具合を不利益に扱わないでください。</p>}
              <p className="guardrail-copy">接客ロールプレイ中の傾聴、理解確認、落ち着いた応対、説明、安全配慮など、職務上観察できる行動だけを確認します。笑顔の有無、顔立ち・容姿、服装、背景、カメラ品質、障害や健康状態の推測は評価しません。</p>
            </article>

            <article className="staff-panel">
              <div className="panel-title"><p>{textInterviewSelected ? "回答確認" : "映像確認"}</p><h2>{textInterviewSelected ? "文字入力方式" : `${reviewer}の確認 / ${reviewedVideoDimensions}/${VIDEO_REVIEW_DIMENSIONS.length}項目`}</h2></div>
              <div className="validation-box"><strong>判断前の必須確認</strong><p>{textInterviewSelected ? "文字入力方式では映像評価を行いません。回答内容と求人要件だけを採用担当者が確認してください。" : "技術不具合、映像・音声品質、配慮の申出は不利益に扱わず、未確認とします。一部項目だけの平均点や総合点は表示しません。自動評価は合否を決めず、権限を付与された採用担当者が求人要件と根拠を確認します。"}</p></div>
              {!textInterviewSelected && <div className="video-rubric">
                {review.videoReviewRubric.map((dimension) => {
                  const score = scores.find((item) => item.name === dimension.name) ?? { name: dimension.name, score: null, note: "" };
                  return <div className="rubric-item" key={dimension.name}><h3>{dimension.name}{dimension.weight === 2 && <span className="priority-badge">重点項目</span>}</h3><p>{dimension.criterion}</p><div className="score-buttons">{[1, 2, 3, 4, 5].map((value) => <button key={value} className={score.score === value ? "active" : ""} onClick={() => updateScore(dimension.name, { score: value })}>{value}</button>)}<button className={score.score === null ? "active" : ""} onClick={() => updateScore(dimension.name, { score: null, note: "" })}>未確認</button></div><textarea value={score.note} onChange={(event) => updateScore(dimension.name, { note: event.target.value })} placeholder={score.score === null ? "未確認の場合は空欄で構いません" : "点数の根拠となる、映像内の具体的な職務行動を記録（必須）"} rows={2} /></div>;
                })}
              </div>}
              {!textInterviewSelected && <><label className="overall-note">総合メモ<textarea value={overallNote} onChange={(event) => setOverallNote(event.target.value)} rows={4} placeholder="追加確認事項。合否はこの画面だけで自動決定しません。" /></label><button className="primary-action" onClick={() => void saveVideoReview()} disabled={state === "saving"}>{state === "saving" ? "保存中…" : "映像評価を保存"}</button></>}
            </article>
          </div>

          {legacyRecordedFallbackSelected ? <section className="staff-panel evaluation-panel"><div className="panel-title"><p>録画式予備面接</p><h2>自動評価なし・人手照合必須</h2></div><p className="evaluation-summary">回答音声の自動文字起こしは保存されていますが、録画の実際の発言との一致は未照合です。録画と下の文字起こしを採用担当者が照合してから判断してください。技術不具合や録画・音声品質は応募者の評価に使用しません。</p></section> : review.evaluation ? <section className="staff-panel evaluation-panel"><div className="panel-title"><p>{recordedAutomaticEvaluation ? "録画式・回答根拠付き自動分析（録画未照合）" : "回答根拠付き評価"}</p><h2>{recommendationLabels[review.evaluation.recommendation]}</h2></div><p className="evaluation-summary">{review.evaluation.summary}</p>{review.evaluation.evidenceValidationWarnings.length > 0 && <div className="validation-box"><strong>評価本文の要確認事項（{review.evaluation.evidenceValidationWarnings.length}件）</strong><ul>{review.evaluation.evidenceValidationWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>これらの指摘がある評価は「人による要確認」として扱い、該当箇所を確認してから判断してください。</p></div>}<div className="score-grid">{review.evaluation.dimensions.map((dimension) => <article className="score-card" key={dimension.name}><div className="score-card-head"><div><span>確信度 {dimension.confidence}</span><h3>{dimension.name}</h3></div><strong>{dimension.score ?? "—"}<small>/5</small></strong></div><p>{dimension.rationale}</p><div className="evidence-list">{dimension.evidence.length ? dimension.evidence.map((evidence) => <blockquote key={`${dimension.name}-${evidence.turnId}-${evidence.quote}`}><span>文字起こし内一致（録画未照合）</span>「{evidence.quote}」<small>{evidence.relevance}</small></blockquote>) : <div className="no-evidence">有効な回答根拠なし</div>}</div></article>)}</div></section> : <div className="staff-message">回答評価は未作成です。文字起こしを採用担当者が確認してください。</div>}

          <details className="transcript-details"><summary>時系列の全文議事録を確認（{review.transcript.length}件）</summary><div>{review.transcript.map((turn) => <article key={turn.id}><span>{turn.speaker === "interviewer" ? "オンライン採用担当者 茂木" : "応募者"}</span><p>{turn.text}</p></article>)}</div></details>

          {review.humanReviews.length > 0 && <section className="staff-panel"><div className="panel-title"><p>担当者表示名記録（自己申告）</p><h2>映像評価の保存状況</h2></div><div className="human-review-list">{review.humanReviews.map((item) => <div key={item.reviewerName}><strong>{item.reviewerName}</strong><span>{item.videoScores.filter((score) => score.score !== null).length}/{VIDEO_REVIEW_DIMENSIONS.length}項目確認</span><p>{item.overallNote || "総合メモなし"}</p></div>)}</div></section>}
        </section>
      )}
    </main>
  );
}
