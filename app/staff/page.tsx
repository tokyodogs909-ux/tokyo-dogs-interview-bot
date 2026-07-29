"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import {
  AUTHORIZED_REVIEWERS,
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
  employment: string;
  location: string;
  status: string;
  recordingStatus: string;
  transcript: TranscriptTurn[];
  evaluation: InterviewEvaluation | null;
  completedAt: string | null;
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
};

const technicalEventLabels: Record<string, string> = {
  audio_playback_blocked: "担当者音声の再生停止",
  transcription_failed: "回答の文字起こし失敗",
  recording_unavailable: "録画または双方音声の欠落",
  connection_failed: "音声・通信接続の失敗",
  candidate_requested_stop: "応募者による中止",
};

const recommendationLabels = {
  job_related_evidence_complete: "職務関連根拠の確認が可能",
  human_review: "人による要確認",
  insufficient_information: "情報不足",
} as const;

function emptyScores(): VideoScore[] {
  return VIDEO_REVIEW_DIMENSIONS.map((dimension) => ({
    name: dimension.name,
    score: null,
    note: "",
  }));
}

export default function StaffReviewPage() {
  const [reviewer, setReviewer] = useState<(typeof AUTHORIZED_REVIEWERS)[number]>("笠間");
  const [sessionId, setSessionId] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [review, setReview] = useState<ReviewRecord | null>(null);
  const [recordingUrl, setRecordingUrl] = useState("");
  const [scores, setScores] = useState<VideoScore[]>(emptyScores);
  const [overallNote, setOverallNote] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "saving">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  }, [recordingUrl]);

  function authHeaders() {
    return {
      Authorization: `Bearer ${accessKey}`,
      "X-Interview-Reviewer": reviewer === "笠間" ? "kasama" : "yamamoto",
    };
  }

  async function loadReview() {
    setState("loading");
    setMessage("");
    setReview(null);
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl("");
    try {
      const response = await fetch(`/api/staff/interview?sessionId=${encodeURIComponent(sessionId.trim())}`, {
        headers: authHeaders(),
        cache: "no-store",
      });
      const data = (await response.json()) as { review?: ReviewRecord; error?: string };
      if (!response.ok || !data.review) throw new Error(data.error || "オンライン一次面接記録を取得できませんでした。");
      setReview(data.review);
      const ownReview = data.review.humanReviews.find((item) => item.reviewerName === reviewer);
      setScores(ownReview?.videoScores.length ? ownReview.videoScores : emptyScores());
      setOverallNote(ownReview?.overallNote ?? "");
      if (data.review.recordingStatus === "stored") {
        const recordingResponse = await fetch(`/api/staff/recording?sessionId=${encodeURIComponent(sessionId.trim())}`, {
          headers: authHeaders(),
          cache: "no-store",
        });
        if (recordingResponse.ok) setRecordingUrl(URL.createObjectURL(await recordingResponse.blob()));
      }
      setState("ready");
    } catch (error) {
      setState("idle");
      setMessage(error instanceof Error ? error.message : "オンライン一次面接記録を取得できませんでした。");
    }
  }

  function updateScore(name: VideoScore["name"], patch: Partial<VideoScore>) {
    setScores((current) => current.map((item) => item.name === name ? { ...item, ...patch } : item));
  }

  const reviewedVideoDimensions = scores.filter((item) => item.score !== null).length;

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
      setMessage(`${reviewer}の映像評価を保存しました。`);
    } catch (error) {
      setState("ready");
      setMessage(error instanceof Error ? error.message : "映像評価を保存できませんでした。");
    }
  }

  return (
    <main className="staff-shell">
      <header className="site-header staff-header">
        <div className="brand-button">
          <img src="/tokyo-dogs-logo.jpg" alt="Tokyo Dogs" />
          <span><strong>TOKYO DOGS</strong><small>OFFICIAL SELECTION REVIEW</small></span>
        </div>
        <span className="test-pill">笠間・山本 専用</span>
      </header>

      <section className="staff-login">
        <div><p className="eyebrow">AUTHORIZED RECRUITER ACCESS</p><h1>公式選考レビュー</h1><p>評価本文、文字起こし、録画は認証された採用担当者だけが確認できます。アクセスは監査ログへ記録されます。</p></div>
        <div className="staff-login-form">
          <label>採用担当者<select value={reviewer} onChange={(event) => setReviewer(event.target.value as typeof reviewer)}>{AUTHORIZED_REVIEWERS.map((name) => <option key={name}>{name}</option>)}</select></label>
          <label>面接ID<input value={sessionId} onChange={(event) => setSessionId(event.target.value.toUpperCase())} placeholder="TD-..." autoCapitalize="characters" /></label>
          <label>アクセスキー<input type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} autoComplete="current-password" /></label>
          <button className="primary-action" onClick={() => void loadReview()} disabled={!sessionId.trim() || !accessKey || state === "loading"}>{state === "loading" ? "確認中…" : "オンライン一次面接記録を開く"} <span>→</span></button>
        </div>
      </section>

      {message && <div className="staff-message">{message}</div>}

      {review && (
        <section className="staff-review">
          <div className="staff-meta"><div><span>面接ID</span><strong>{review.sessionId}</strong></div><div><span>雇用形態</span><strong>{review.employment}</strong></div><div><span>希望店舗</span><strong>{review.location}</strong></div><div><span>状態</span><strong>{review.status}</strong></div></div>

          {review.technicalEvents.length > 0 && <div className="staff-message"><strong>技術・中断フラグあり——合否判断前に再確認してください</strong><ul>{review.technicalEvents.map((event, index) => <li key={`${event.type}-${event.createdAt}-${index}`}>{technicalEventLabels[event.type] ?? event.type}</li>)}</ul><p>これらの事象と映像・音声品質は、応募者の不利益な評価に使用しません。</p></div>}

          <div className="staff-grid">
            <article className="staff-panel recording-panel">
              <div className="panel-title"><p>録画確認</p><h2>接客ロールプレイ</h2></div>
              {recordingUrl ? <video src={recordingUrl} controls playsInline /> : <div className="recording-empty">録画を取得できないか、録画がまだ保存されていません。</div>}
              <p className="guardrail-copy">接客ロールプレイ中の傾聴、理解確認、落ち着いた応対、説明、安全配慮など、職務上観察できる行動だけを確認します。笑顔の有無、顔立ち・容姿、服装、背景、カメラ品質、障害や健康状態の推測は評価しません。</p>
            </article>

            <article className="staff-panel">
              <div className="panel-title"><p>映像確認</p><h2>{reviewer}の確認 / {reviewedVideoDimensions}/{VIDEO_REVIEW_DIMENSIONS.length}項目</h2></div>
              <div className="validation-box"><strong>判断前の必須確認</strong><p>技術不具合、映像・音声品質、配慮の申出は不利益に扱わず、未確認とします。一部項目だけの平均点や総合点は表示しません。自動評価は合否を決めず、笠間・山本が求人要件と根拠を確認します。</p></div>
              <div className="video-rubric">
                {review.videoReviewRubric.map((dimension) => {
                  const score = scores.find((item) => item.name === dimension.name) ?? { name: dimension.name, score: null, note: "" };
                  return <div className="rubric-item" key={dimension.name}><h3>{dimension.name}{dimension.weight === 2 && <span className="priority-badge">重点項目</span>}</h3><p>{dimension.criterion}</p><div className="score-buttons">{[1, 2, 3, 4, 5].map((value) => <button key={value} className={score.score === value ? "active" : ""} onClick={() => updateScore(dimension.name, { score: value })}>{value}</button>)}<button className={score.score === null ? "active" : ""} onClick={() => updateScore(dimension.name, { score: null, note: "" })}>未確認</button></div><textarea value={score.note} onChange={(event) => updateScore(dimension.name, { note: event.target.value })} placeholder={score.score === null ? "未確認の場合は空欄で構いません" : "点数の根拠となる、映像内の具体的な職務行動を記録（必須）"} rows={2} /></div>;
                })}
              </div>
              <label className="overall-note">総合メモ<textarea value={overallNote} onChange={(event) => setOverallNote(event.target.value)} rows={4} placeholder="追加確認事項。合否はこの画面だけで自動決定しません。" /></label>
              <button className="primary-action" onClick={() => void saveVideoReview()} disabled={state === "saving"}>{state === "saving" ? "保存中…" : "映像評価を保存"}</button>
            </article>
          </div>

          {review.evaluation ? <section className="staff-panel evaluation-panel"><div className="panel-title"><p>回答根拠付き評価</p><h2>{recommendationLabels[review.evaluation.recommendation]}</h2></div><p className="evaluation-summary">{review.evaluation.summary}</p><div className="score-grid">{review.evaluation.dimensions.map((dimension) => <article className="score-card" key={dimension.name}><div className="score-card-head"><div><span>確信度 {dimension.confidence}</span><h3>{dimension.name}</h3></div><strong>{dimension.score ?? "—"}<small>/5</small></strong></div><p>{dimension.rationale}</p><div className="evidence-list">{dimension.evidence.length ? dimension.evidence.map((evidence) => <blockquote key={`${dimension.name}-${evidence.turnId}-${evidence.quote}`}><span>照合済み</span>「{evidence.quote}」<small>{evidence.relevance}</small></blockquote>) : <div className="no-evidence">有効な回答根拠なし</div>}</div></article>)}</div></section> : <div className="staff-message">回答評価は未作成です。文字起こしを採用担当者が確認してください。</div>}

          <details className="transcript-details"><summary>文字起こしを確認（{review.transcript.length}件）</summary><div>{review.transcript.map((turn) => <article key={turn.id}><span>{turn.speaker === "interviewer" ? "オンライン採用担当者 茂木" : "応募者"}</span><p>{turn.text}</p></article>)}</div></details>

          {review.humanReviews.length > 0 && <section className="staff-panel"><div className="panel-title"><p>担当者記録</p><h2>映像評価の保存状況</h2></div><div className="human-review-list">{review.humanReviews.map((item) => <div key={item.reviewerName}><strong>{item.reviewerName}</strong><span>{item.videoScores.filter((score) => score.score !== null).length}/{VIDEO_REVIEW_DIMENSIONS.length}項目確認</span><p>{item.overallNote || "総合メモなし"}</p></div>)}</div></section>}
        </section>
      )}
    </main>
  );
}
