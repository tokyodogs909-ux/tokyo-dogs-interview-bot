"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import {
  VIDEO_REVIEW_DIMENSIONS,
  type InterviewEvaluation,
  type TranscriptTurn,
} from "@/lib/interview";

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
  driveSync: {
    status: "pending" | "running" | "completed" | "failed";
    folderUrl: string | null;
    errorCode: string | null;
    updatedAt: string;
    recordingIncluded: boolean;
    archivedArtifactCount: number;
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
};

const technicalEventLabels: Record<string, string> = {
  audio_playback_blocked: "担当者音声の再生停止",
  transcription_failed: "回答の文字起こし失敗",
  recording_unavailable: "録画または双方音声の欠落",
  connection_failed: "音声・通信接続の失敗",
  candidate_requested_stop: "応募者による中止",
  time_limit_reached: "27分上限後の安全終了",
  reasonable_accommodation_text_selected: "文字入力方式を選択（評価差なし）",
};

const recommendationLabels = {
  job_related_evidence_complete: "職務関連根拠の確認が可能",
  human_review: "人による要確認",
  insufficient_information: "情報不足",
} as const;

const interviewStatusLabels: Record<string, string> = {
  created: "未開始",
  in_progress: "面接中",
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

function isTextInterviewRecord(value: ReviewRecord | null) {
  return Boolean(value?.technicalEvents.some((event) => event.type === "reasonable_accommodation_text_selected"));
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
  const [listFilter, setListFilter] = useState("");
  const [listLoading, setListLoading] = useState(false);
  const [completionNotice, setCompletionNotice] = useState("");
  const [newCompletedIds, setNewCompletedIds] = useState<Set<string>>(() => new Set());
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unavailable">("unavailable");
  const knownCompletedIdsRef = useRef(new Set<string>());
  const completionMonitorInitializedRef = useRef(false);
  const pollInterviewListRef = useRef<() => Promise<void>>(async () => undefined);

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
      ? `${first.candidateName || "氏名未登録"}さんの面接が完了しました。担当者画面で保存状態を確認してください。`
      : `${items.length}件の面接が完了しました。担当者画面で保存状態を確認してください。`;
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

  async function loadInterviewList(options: { silent?: boolean } = {}) {
    if (!options.silent) {
      setListLoading(true);
      setMessage("");
    }
    try {
      const response = await fetch(options.silent ? "/api/staff/interviews?poll=1" : "/api/staff/interviews", {
        headers: authHeaders(),
        cache: "no-store",
      });
      const data = (await response.json()) as { interviews?: InterviewListItem[]; error?: string };
      if (!response.ok || !data.interviews) throw new Error(data.error || "候補者一覧を取得できませんでした。");
      setNotificationPermission(typeof Notification === "undefined" ? "unavailable" : Notification.permission);
      const completedItems = data.interviews.filter((item) => item.status === "completed" && item.completedAt);
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
          setCompletionNotice(`新しい面接完了：${names}。録画保存・Drive格納・技術フラグを確認してください。`);
          showBrowserCompletionNotification(newlyCompleted);
        }
      }
      setRecentInterviews(data.interviews);
      if (!options.silent) {
        setMessage(data.interviews.length > 0
          ? `最近のオンライン一次面接を${data.interviews.length}件表示しました。`
          : "オンライン一次面接の記録はまだありません。");
      }
    } catch (error) {
      if (!options.silent) {
        setRecentInterviews(null);
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
    completionMonitorInitializedRef.current = false;
    knownCompletedIdsRef.current.clear();
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
      setState("ready");
      setMessage(`${reviewer.normalize("NFKC").replace(/\s+/gu, " ").trim()}の映像評価を保存しました。`);
    } catch (error) {
      setState("ready");
      setMessage(error instanceof Error ? error.message : "映像評価を保存できませんでした。");
    }
  }

  async function syncGoogleDrive() {
    if (!review) return;
    setState("syncing");
    setMessage("");
    try {
      const response = await fetch("/api/staff/google-drive/sync", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: review.sessionId }),
      });
      const data = (await response.json()) as {
        synced?: boolean;
        result?: { status: "completed" | "pending"; folderUrl: string; recordingIncluded: boolean; uploaded: Record<string, unknown> };
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
          archivedArtifactCount: Object.keys(data.result?.uploaded ?? {}).length,
        },
      } : current);
      setState("ready");
      setMessage(data.result.status === "completed"
        ? data.result.recordingIncluded
          ? "Google Driveへの録画・文字起こし・評価・PDFの格納を完了しました。"
          : isTextInterviewRecord(review)
            ? "文字入力による回答・評価・PDFのGoogle Drive格納を完了しました。"
            : "文字起こし・評価・PDFを格納しましたが、録画はまだ格納されていません。録画保存状態を確認してください。"
        : "Google Driveへの再格納を予約しました。");
    } catch (error) {
      setState("ready");
      setMessage(error instanceof Error ? error.message : "Google Driveへの格納を完了できませんでした。");
    }
  }

  return (
    <main className="staff-shell">
      <header className="site-header staff-header">
        <div className="brand-button">
          <img src="/tokyo-dogs-logo.jpg" alt="Tokyo Dogs" />
          <span><strong>TOKYO DOGS</strong><small>OFFICIAL SELECTION REVIEW</small></span>
        </div>
        <div className="staff-header-actions"><button type="button" onClick={() => void copyCandidateLink()}>候補者用URLをコピー</button><a href="/staff/google-drive">Drive接続設定</a><span className="test-pill">採用担当者専用</span></div>
      </header>

      <section className="staff-operation-guide" aria-label="初めての採用担当者向け運用手順">
        <div>
          <p className="eyebrow">SIMPLE OPERATION GUIDE</p>
          <h2>運用は3ステップです</h2>
          <p>候補者ごとのリンク発行やフォルダ作成は不要です。全員に同じURLを案内すると、面接と保存が候補者別に自動で進みます。</p>
        </div>
        <ol>
          <li><strong>1. 共通URLを案内</strong><span>上の「候補者用URLをコピー」を押し、候補者へ送ります。</span></li>
          <li><strong>2. 面接完了後に一覧を確認</strong><span>担当者名と共通アクセスキーを入力し、「候補者一覧を表示」を押します。</span></li>
          <li><strong>3. 保存完了を確認</strong><span>通常面接は「面接完了・録画保存済み・Drive格納済み」、文字入力方式は「面接完了・Drive格納済み」を確認します。</span></li>
        </ol>
        <p className="staff-operation-alert"><strong>「要確認」がある場合</strong> 候補者を不利に評価せず、記録を開いて技術フラグを確認してください。Driveだけが未完了の場合は「Driveへ再格納」を押します。</p>
      </section>

      <section className="staff-login">
        <div><p className="eyebrow">AUTHORIZED RECRUITER ACCESS</p><h1>公式選考レビュー</h1><p>担当者名と共通アクセスキーでログインすると、最近の候補者一覧から記録を選べます。閲覧と保存操作は監査ログへ記録されます。</p></div>
        <div className="staff-login-form">
          <label>担当者名<input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="例：採用担当" autoComplete="name" maxLength={40} /></label>
          <label>アクセスキー<input type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} autoComplete="current-password" /></label>
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
          <div className="staff-inbox-tools">
            <label>候補者を検索<input value={listFilter} onChange={(event) => setListFilter(event.target.value)} placeholder="氏名・店舗・面接ID" /></label>
            <div className="manual-session-open"><label>面接IDを直接指定<input value={sessionId} onChange={(event) => setSessionId(event.target.value.toUpperCase())} placeholder="TD-..." autoCapitalize="characters" /></label><button type="button" onClick={() => void loadReview()} disabled={!sessionId.trim() || state === "loading"}>開く</button></div>
          </div>
          <div className="staff-inbox-list">
            {filteredInterviews.map((item) => (
              <button type="button" className={`${review?.sessionId === item.sessionId ? "active" : ""} ${newCompletedIds.has(item.sessionId) ? "new-completion" : ""}`.trim()} key={item.sessionId} onClick={() => void loadReview(item.sessionId)} disabled={state === "loading"}>
                <span className="staff-inbox-name"><strong>{item.candidateName || "氏名未登録"}{newCompletedIds.has(item.sessionId) && <em>新着完了</em>}</strong><small>{item.employment}・{item.location}</small></span>
                <span className="staff-inbox-state"><strong>{interviewStatusLabels[item.status] ?? item.status}</strong><small>{recordingStatusLabels[item.recordingStatus] ?? item.recordingStatus}</small></span>
                <span className="staff-inbox-date"><strong>{formatInterviewDate(item.createdAt)}</strong><small>保存見直し {formatRetentionDate(item.retentionUntil)}</small><small>{item.sessionId}</small></span>
                <span className={`staff-inbox-drive drive-${item.driveStatus ?? "not-started"}`}>{item.driveStatus === "completed" ? "Drive格納済み" : item.driveStatus === "failed" ? "Drive要確認" : item.driveStatus === "running" ? "Drive格納中" : "Drive未格納"}</span>
                <span className="staff-inbox-arrow">→</span>
              </button>
            ))}
            {filteredInterviews.length === 0 && <div className="staff-inbox-empty">該当する候補者はありません。</div>}
          </div>
        </section>
      )}

      {review && (
        <section className="staff-review">
          <div className="staff-meta"><div><span>氏名</span><strong>{review.candidateName || "旧テスト記録"}</strong></div><div><span>面接ID</span><strong>{review.sessionId}</strong></div><div><span>雇用形態</span><strong>{review.employment}</strong></div><div><span>入職希望対象店舗</span><strong>{review.location}</strong></div><div><span>保存見直し</span><strong>{formatRetentionDate(review.retentionUntil)}</strong></div><div><span>状態</span><strong>{review.status}</strong></div></div>

          <section className="staff-panel drive-sync-panel">
            <div className="panel-title"><p>GOOGLE DRIVE ARCHIVE</p><h2>面接記録の自動格納</h2></div>
            <p>面接完了後、応募者氏名と面接IDの専用フォルダへ、録画・文字起こし・評価データ・PDFレポート・格納結果を保存します。同じ面接IDで再実行しても既存ファイルを更新します。</p>
            <div className="drive-sync-actions">
              <span className={`drive-sync-status drive-sync-${review.driveSync?.status ?? "not-started"}`}>
                {review.driveSync?.status === "completed" ? review.driveSync.recordingIncluded ? "録画を含め格納完了" : textInterviewSelected ? "回答記録を格納完了" : "録画未格納"
                  : review.driveSync?.status === "running" ? "格納中"
                    : review.driveSync?.status === "pending" ? "格納待ち"
                      : review.driveSync?.status === "failed" ? "要再実行"
                        : "未実行"}
              </span>
              {review.driveSync?.folderUrl && <a href={review.driveSync.folderUrl} target="_blank" rel="noreferrer">保存フォルダを開く ↗</a>}
              <button className="secondary-action" onClick={() => void syncGoogleDrive()} disabled={state === "syncing" || review.status !== "completed"}>
                {state === "syncing" ? "格納中…" : "Driveへ再格納"}
              </button>
            </div>
            {review.driveSync?.status === "failed" && <p className="guardrail-copy">認証・保存先・通信状態を確認し、再実行してください。応募者の評価状態には影響しません。</p>}
            {review.driveSync?.status === "completed" && !review.driveSync.recordingIncluded && !textInterviewSelected && <p className="guardrail-copy"><strong>録画はDriveへ格納されていません。</strong> 文字起こし・評価・PDFのみ格納済みです。録画状態が「stored」になった後に再格納してください。</p>}
            {review.driveSync?.status === "completed" && textInterviewSelected && <p className="guardrail-copy">文字入力方式のため録画はありません。回答記録・評価・PDFをDrive側で再照合済みです。</p>}
            {review.driveSync?.status === "completed" && review.driveSync.recordingIncluded && <p className="guardrail-copy">録画を含む{review.driveSync.archivedArtifactCount}種類の格納結果をDrive側で再照合済みです。</p>}
          </section>

          {review.technicalEvents.length > 0 && <div className="staff-message"><strong>進行・技術フラグあり——合否判断前に再確認してください</strong><ul>{review.technicalEvents.map((event, index) => <li key={`${event.type}-${event.createdAt}-${index}`}>{technicalEventLabels[event.type] ?? event.type}</li>)}</ul><p>参加方法や技術的な事象は、応募者の不利益な評価に使用しません。</p></div>}
          {review.evaluation && <p className="guardrail-copy"><strong>回答評価は応募者の回答記録を基にした補助情報です。</strong> 合否判断前に、{textInterviewSelected ? "入力された回答" : "録画の実際の発言"}と根拠引用を採用担当者が照合してください。</p>}

          <div className="staff-grid">
            <article className="staff-panel recording-panel">
              <div className="panel-title"><p>録画確認</p><h2>接客ロールプレイ</h2></div>
              {recordingUrl ? <video src={recordingUrl} controls playsInline /> : <div className="recording-empty">{textInterviewSelected ? "文字入力方式のため録画はありません。回答記録をご確認ください。" : "録画を取得できないか、録画がまだ保存されていません。"}</div>}
              {recordingUrl && recordingAudioCoverage !== "both" && <p className="guardrail-copy"><strong>録画内の双方音声は未確認です。</strong> 応募者音声のみ、または端末側で確認できなかった可能性があります。映像と文字起こしを照合し、技術不具合を不利益に扱わないでください。</p>}
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

          {review.evaluation ? <section className="staff-panel evaluation-panel"><div className="panel-title"><p>回答根拠付き評価</p><h2>{recommendationLabels[review.evaluation.recommendation]}</h2></div><p className="evaluation-summary">{review.evaluation.summary}</p>{review.evaluation.evidenceValidationWarnings.length > 0 && <div className="validation-box"><strong>評価本文の要確認事項（{review.evaluation.evidenceValidationWarnings.length}件）</strong><ul>{review.evaluation.evidenceValidationWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><p>これらの指摘がある評価は「人による要確認」として扱い、該当箇所を確認してから判断してください。</p></div>}<div className="score-grid">{review.evaluation.dimensions.map((dimension) => <article className="score-card" key={dimension.name}><div className="score-card-head"><div><span>確信度 {dimension.confidence}</span><h3>{dimension.name}</h3></div><strong>{dimension.score ?? "—"}<small>/5</small></strong></div><p>{dimension.rationale}</p><div className="evidence-list">{dimension.evidence.length ? dimension.evidence.map((evidence) => <blockquote key={`${dimension.name}-${evidence.turnId}-${evidence.quote}`}><span>照合済み</span>「{evidence.quote}」<small>{evidence.relevance}</small></blockquote>) : <div className="no-evidence">有効な回答根拠なし</div>}</div></article>)}</div></section> : <div className="staff-message">回答評価は未作成です。文字起こしを採用担当者が確認してください。</div>}

          <details className="transcript-details"><summary>文字起こしを確認（{review.transcript.length}件）</summary><div>{review.transcript.map((turn) => <article key={turn.id}><span>{turn.speaker === "interviewer" ? "オンライン採用担当者 茂木" : "応募者"}</span><p>{turn.text}</p></article>)}</div></details>

          {review.humanReviews.length > 0 && <section className="staff-panel"><div className="panel-title"><p>担当者記録</p><h2>映像評価の保存状況</h2></div><div className="human-review-list">{review.humanReviews.map((item) => <div key={item.reviewerName}><strong>{item.reviewerName}</strong><span>{item.videoScores.filter((score) => score.score !== null).length}/{VIDEO_REVIEW_DIMENSIONS.length}項目確認</span><p>{item.overallNote || "総合メモなし"}</p></div>)}</div></section>}
        </section>
      )}
    </main>
  );
}
