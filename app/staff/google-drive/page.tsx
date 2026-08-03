"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";

type DriveRoot = {
  id: string;
  name: string;
  canAddChildren: boolean;
  locationType: "my_drive" | "shared_drive";
  webViewLink: string | null;
};

type ProductionReadiness = {
  technicallyReady: boolean;
  openAIAuthenticated: boolean;
  database: boolean;
  recordingStorage: boolean;
  reviewerAuth: { configured: boolean; dedicated: boolean };
  driveOAuthSetup: { configured: boolean };
  drive: { authenticated: boolean; name?: string; locationType?: string };
  candidateEntryMode: "signed_invite" | "common_url";
  missing: string[];
};

export default function GoogleDriveSetupPage() {
  const [accessKey, setAccessKey] = useState("");
  const [phase, setPhase] = useState<"idle" | "connecting" | "connected" | "selecting" | "ready">("idle");
  const [message, setMessage] = useState("");
  const [root, setRoot] = useState<DriveRoot | null>(null);
  const [readiness, setReadiness] = useState<ProductionReadiness | null>(null);
  const [readinessChecking, setReadinessChecking] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected") === "1";
    const failed = params.has("error");
    queueMicrotask(() => {
      if (connected) {
        setPhase("selecting");
        setMessage("Googleアカウントとの接続を確認しました。承認済み保存先を照合しています。");
        void confirmApprovedFolder();
      } else if (failed) {
        setMessage("Googleアカウントとの接続を完了できませんでした。もう一度お試しください。");
      }
    });
    if (params.has("connected") || params.has("error")) {
      window.history.replaceState({}, "", "/staff/google-drive");
    }
  }, []);

  async function beginConnection() {
    setPhase("connecting");
    setMessage("");
    try {
      const response = await fetch("/api/admin/google-drive/oauth/start", {
        method: "POST",
        credentials: "same-origin",
        headers: { Authorization: `Bearer ${accessKey}` },
      });
      const payload = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) throw new Error(payload.error || "Google Drive接続を開始できませんでした。");
      const authorizationUrl = new URL(payload.authorizationUrl);
      if (authorizationUrl.protocol !== "https:" || authorizationUrl.hostname !== "accounts.google.com") {
        throw new Error("Googleの接続先を確認できませんでした。");
      }
      setAccessKey("");
      window.location.assign(authorizationUrl.toString());
    } catch (error) {
      setPhase("idle");
      setMessage(error instanceof Error ? error.message : "Google Drive接続を開始できませんでした。");
    }
  }

  async function confirmApprovedFolder(accessKeyOverride = "") {
    setPhase("selecting");
    setMessage("");
    const response = await fetch("/api/admin/google-drive/root", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(accessKeyOverride ? { Authorization: `Bearer ${accessKeyOverride}` } : {}),
      },
      body: JSON.stringify({}),
    });
    const payload = await response.json() as { saved?: boolean; root?: DriveRoot; error?: string };
    if (!response.ok || !payload.saved || !payload.root) {
      setPhase(accessKeyOverride ? "idle" : "connected");
      setMessage(payload.error || "承認済み保存先を確認できませんでした。");
      return;
    }
    setRoot(payload.root);
    setAccessKey("");
    setPhase("ready");
    setMessage("承認済み保存先を確認し、自動格納の設定を完了しました。");
  }

  async function checkProductionReadiness() {
    setReadinessChecking(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/readiness", {
        credentials: "same-origin",
        cache: "no-store",
        headers: accessKey ? { Authorization: `Bearer ${accessKey}` } : {},
      });
      const payload = await response.json() as ProductionReadiness & { error?: string };
      if (typeof payload.technicallyReady !== "boolean") {
        throw new Error(payload.error || "本番稼働条件を確認できませんでした。");
      }
      setReadiness(payload);
      setMessage(payload.technicallyReady
        ? "本番の技術設定をすべて確認しました。"
        : "未完了の設定があります。下の赤い項目を確認してください。");
    } catch (error) {
      setReadiness(null);
      setMessage(error instanceof Error ? error.message : "本番稼働条件を確認できませんでした。");
    } finally {
      setReadinessChecking(false);
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
          <p className="eyebrow">GOOGLE DRIVE CONNECTION</p>
          <h1>面接記録の<br />保存先設定</h1>
          <p>管理者が許可した専用フォルダだけへ、録画・文字起こし・評価データ・PDFレポートを自動格納します。</p>
        </div>

        <div className="drive-setup-panel">
          <div className="drive-setup-step"><span>1</span><div><strong>Googleアカウントへ接続</strong><small>面接記録の保存に必要な範囲だけを許可します。</small></div></div>
          <div className="drive-setup-step"><span>2</span><div><strong>承認済み保存先を自動確認</strong><small>「オンライン一次面接_自動格納」だけを照合します。</small></div></div>
          <div className="drive-setup-step"><span>3</span><div><strong>自動格納を開始</strong><small>面接完了後、応募者別フォルダへ安全に整理します。</small></div></div>

          {phase === "idle" || phase === "connecting" ? (
            <label className="drive-admin-key">
              管理者アクセスキー
              <input
                type="password"
                value={accessKey}
                onChange={(event) => setAccessKey(event.target.value)}
                autoComplete="current-password"
                placeholder="管理者アクセスキーを入力"
              />
              <button className="primary-action" onClick={() => void beginConnection()} disabled={!accessKey || phase === "connecting"}>
                {phase === "connecting" ? "接続中…" : "Google Driveと接続"} <span>→</span>
              </button>
              <button className="secondary-action" type="button" onClick={() => void confirmApprovedFolder(accessKey)} disabled={!accessKey || phase === "connecting"}>
                保存済み接続を確認
              </button>
              <small>Google同意済みの場合は「保存済み接続を確認」を押すだけで、再同意せず設定を再開できます。</small>
            </label>
          ) : (
            <div className="drive-folder-action">
              <div className="drive-connected-badge">Googleアカウント 接続済み</div>
              <button className="primary-action" onClick={() => void confirmApprovedFolder()} disabled={phase === "selecting" || phase === "ready"}>
                {phase === "selecting" ? "承認済み保存先を確認中…" : phase === "ready" ? "設定完了" : "承認済み保存先を確認"} <span>→</span>
              </button>
            </div>
          )}

          {message && <div className="drive-setup-message" role="status">{message}</div>}
          {root && (
            <div className="drive-root-readback">
              <span>登録済み保存先</span>
              <strong>{root.name}</strong>
              <small>{root.locationType === "shared_drive" ? "共有ドライブ" : "マイドライブ"}・追加権限確認済み</small>
              {root.webViewLink && <a href={root.webViewLink} target="_blank" rel="noreferrer">保存先をGoogle Driveで確認 ↗</a>}
            </div>
          )}
          <div className="readiness-action">
            <button className="secondary-action" type="button" onClick={() => void checkProductionReadiness()} disabled={readinessChecking}>
              {readinessChecking ? "本番設定を確認中…" : "本番稼働条件を一括確認"}
            </button>
            <small>管理者アクセスキーを入力したまま、またはGoogle接続直後に確認できます。秘密値は画面へ表示しません。</small>
          </div>
          {readiness && (
            <div className={`readiness-readback ${readiness.technicallyReady ? "ready" : "blocked"}`}>
              <div className="readiness-summary"><strong>{readiness.technicallyReady ? "技術設定 完了" : "本番開始を保留"}</strong><span>{readiness.candidateEntryMode === "common_url" ? "共通URL方式" : "候補者別リンク方式"}</span></div>
              <div className={readiness.openAIAuthenticated ? "passed" : "failed"}><span>音声・評価モデル</span><strong>{readiness.openAIAuthenticated ? "認証済み" : "要設定"}</strong></div>
              <div className={readiness.database ? "passed" : "failed"}><span>面接記録データベース</span><strong>{readiness.database ? "接続済み" : "要設定"}</strong></div>
              <div className={readiness.recordingStorage ? "passed" : "failed"}><span>録画保存領域</span><strong>{readiness.recordingStorage ? "接続済み" : "要設定"}</strong></div>
              <div className={readiness.reviewerAuth.configured ? "passed" : "failed"}><span>採用担当者の閲覧認証</span><strong>{readiness.reviewerAuth.configured ? "設定済み" : "要設定"}</strong></div>
              <div className={readiness.driveOAuthSetup.configured ? "passed" : "failed"}><span>Google接続・暗号化設定</span><strong>{readiness.driveOAuthSetup.configured ? "設定済み" : "要設定"}</strong></div>
              <div className={readiness.drive.authenticated ? "passed" : "failed"}><span>Google Drive自動格納</span><strong>{readiness.drive.authenticated ? "読戻し済み" : "要確認"}</strong></div>
            </div>
          )}
          <p className="drive-security-note">接続に使う長期認証情報は暗号化して保管し、採用担当者の画面・応募者画面・格納レポートには表示しません。</p>
        </div>
      </section>
    </main>
  );
}
