"use client";

/* eslint-disable @next/next/no-img-element */
import { useState } from "react";

type InviteResult = {
  link: string;
  expiresAt: string;
};

function formatExpiry(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

export default function InterviewInvitePage() {
  const [accessKey, setAccessKey] = useState("");
  const [expiresInHours, setExpiresInHours] = useState(72);
  const [state, setState] = useState<"idle" | "issuing" | "ready">("idle");
  const [message, setMessage] = useState("");
  const [invite, setInvite] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function issueInvite() {
    setState("issuing");
    setMessage("");
    setInvite(null);
    setCopied(false);
    try {
      const response = await fetch("/api/admin/interviews/invite", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Authorization: `Bearer ${accessKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresInHours }),
      });
      const payload = await response.json() as {
        link?: string;
        expiresAt?: string;
        error?: string;
      };
      if (!response.ok || !payload.link || !payload.expiresAt) {
        throw new Error(payload.error || "候補者用リンクを発行できませんでした。");
      }
      const link = new URL(payload.link);
      if (link.origin !== window.location.origin || !link.searchParams.has("invite")) {
        throw new Error("発行されたリンクを確認できませんでした。");
      }
      setAccessKey("");
      setInvite({ link: link.toString(), expiresAt: payload.expiresAt });
      setState("ready");
      setMessage("候補者用リンクを1件発行しました。送付先を確認してから共有してください。");
    } catch (error) {
      setState("idle");
      setMessage(error instanceof Error ? error.message : "候補者用リンクを発行できませんでした。");
    }
  }

  async function copyInvite() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopied(true);
      setMessage("候補者用リンクをコピーしました。");
    } catch {
      setCopied(false);
      setMessage("自動コピーできませんでした。リンクを選択してコピーしてください。");
    }
  }

  return (
    <main className="staff-shell drive-setup-shell">
      <header className="site-header staff-header">
        <a className="brand-button" href="/staff" aria-label="公式選考レビューへ戻る">
          <img src="/tokyo-dogs-logo.jpg" alt="Tokyo Dogs" />
          <span><strong>TOKYO DOGS</strong><small>ONLINE INTERVIEW OPERATIONS</small></span>
        </a>
        <span className="test-pill">管理者専用</span>
      </header>

      <section className="drive-setup-card">
        <div className="drive-setup-heading">
          <p className="eyebrow">CANDIDATE INVITATION</p>
          <h1>候補者リンクの<br />安全な発行</h1>
          <p>候補者ごとに1回限り使用できる、期限付きのオンライン一次面接リンクを発行します。発行したリンクは採用担当者から対象者だけへ共有してください。</p>
        </div>

        <div className="drive-setup-panel">
          <div className="drive-setup-step"><span>1</span><div><strong>管理者として発行</strong><small>管理者アクセスキーは端末へ保存しません。</small></div></div>
          <div className="drive-setup-step"><span>2</span><div><strong>対象者へ個別送付</strong><small>リンクの転送・複数人での共有は行わないでください。</small></div></div>
          <div className="drive-setup-step"><span>3</span><div><strong>最初の開始で使用済み</strong><small>同じリンクの再利用・期限切れ・改ざんを自動で拒否します。</small></div></div>

          <label className="drive-admin-key">
            リンクの有効期限
            <select
              value={expiresInHours}
              onChange={(event) => setExpiresInHours(Number(event.target.value))}
              disabled={state === "issuing"}
            >
              <option value={24}>24時間</option>
              <option value={48}>48時間</option>
              <option value={72}>72時間（推奨）</option>
              <option value={168}>7日間</option>
            </select>
          </label>
          <label className="drive-admin-key">
            管理者アクセスキー
            <input
              type="password"
              value={accessKey}
              onChange={(event) => setAccessKey(event.target.value)}
              autoComplete="current-password"
              placeholder="管理者アクセスキーを入力"
            />
            <button className="primary-action" onClick={() => void issueInvite()} disabled={!accessKey || state === "issuing"}>
              {state === "issuing" ? "発行中…" : "候補者用リンクを発行"} <span>→</span>
            </button>
          </label>

          {message && <div className="drive-setup-message" role="status">{message}</div>}
          {invite && (
            <div className="invite-result">
              <span>発行済みリンク</span>
              <textarea value={invite.link} readOnly rows={4} aria-label="発行済み候補者リンク" />
              <small>有効期限：{formatExpiry(invite.expiresAt)}（日本時間）</small>
              <button className="secondary-action" type="button" onClick={() => void copyInvite()}>
                {copied ? "コピー済み ✓" : "リンクをコピー"}
              </button>
            </div>
          )}
          <p className="drive-security-note">この画面はリンクを再表示しません。リンクに含まれる署名情報を、台帳・チャット・共有文書へ記録しないでください。候補者が開始すると同じリンクは再利用できません。</p>
        </div>
      </section>
    </main>
  );
}
