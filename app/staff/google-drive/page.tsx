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

type PickerDocument = { id?: string; name?: string };
type PickerResult = { action?: string; docs?: PickerDocument[] };
type PickerInstance = { setVisible(visible: boolean): void };
type DocsViewInstance = {
  setIncludeFolders(value: boolean): DocsViewInstance;
  setSelectFolderEnabled(value: boolean): DocsViewInstance;
  setMimeTypes(value: string): DocsViewInstance;
};
type PickerBuilderInstance = {
  addView(view: DocsViewInstance): PickerBuilderInstance;
  setOAuthToken(value: string): PickerBuilderInstance;
  setDeveloperKey(value: string): PickerBuilderInstance;
  setAppId(value: string): PickerBuilderInstance;
  setOrigin(value: string): PickerBuilderInstance;
  setCallback(callback: (result: PickerResult) => void): PickerBuilderInstance;
  enableFeature(feature: string): PickerBuilderInstance;
  build(): PickerInstance;
};
type GooglePickerRuntime = {
  picker: {
    DocsView: new (viewId: string) => DocsViewInstance;
    PickerBuilder: new () => PickerBuilderInstance;
    ViewId: { FOLDERS: string };
    Feature: { SUPPORT_DRIVES: string };
  };
};
type GapiRuntime = {
  load(name: string, options: {
    callback: () => void;
    onerror: () => void;
    timeout: number;
    ontimeout: () => void;
  }): void;
};

declare global {
  interface Window {
    gapi?: GapiRuntime;
    google?: GooglePickerRuntime;
  }
}

function loadGooglePicker() {
  return new Promise<void>((resolve, reject) => {
    const loadModule = () => {
      if (!window.gapi) {
        reject(new Error("保存先選択画面を読み込めませんでした。"));
        return;
      }
      window.gapi.load("picker", {
        callback: resolve,
        onerror: () => reject(new Error("保存先選択画面を読み込めませんでした。")),
        timeout: 10_000,
        ontimeout: () => reject(new Error("保存先選択画面の読み込みがタイムアウトしました。")),
      });
    };
    const existing = document.getElementById("google-picker-api") as HTMLScriptElement | null;
    if (existing) {
      if (window.gapi) loadModule();
      else existing.addEventListener("load", loadModule, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = "google-picker-api";
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", loadModule, { once: true });
    script.addEventListener("error", () => reject(new Error("保存先選択画面を読み込めませんでした。")), { once: true });
    document.head.appendChild(script);
  });
}

export default function GoogleDriveSetupPage() {
  const [accessKey, setAccessKey] = useState("");
  const [phase, setPhase] = useState<"idle" | "connecting" | "connected" | "selecting" | "ready">("idle");
  const [message, setMessage] = useState("");
  const [root, setRoot] = useState<DriveRoot | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected") === "1";
    const failed = params.has("error");
    queueMicrotask(() => {
      if (connected) {
        setPhase("connected");
        setMessage("Googleアカウントとの接続を確認しました。続けて保存先フォルダを選択してください。");
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

  async function saveSelectedFolder(folderId: string) {
    const response = await fetch("/api/admin/google-drive/root", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    });
    const payload = await response.json() as { saved?: boolean; root?: DriveRoot; error?: string };
    if (!response.ok || !payload.saved || !payload.root) {
      throw new Error(payload.error || "保存先フォルダを登録できませんでした。");
    }
    setRoot(payload.root);
    setPhase("ready");
    setMessage("保存先を確認し、自動格納の設定を完了しました。");
  }

  async function chooseFolder() {
    setPhase("selecting");
    setMessage("");
    try {
      const tokenResponse = await fetch("/api/admin/google-drive/oauth/token", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const tokenPayload = await tokenResponse.json() as {
        accessToken?: string;
        apiKey?: string;
        projectNumber?: string;
        error?: string;
      };
      if (!tokenResponse.ok || !tokenPayload.accessToken || !tokenPayload.apiKey || !tokenPayload.projectNumber) {
        throw new Error(tokenPayload.error || "Google Driveの接続を確認できませんでした。");
      }
      await loadGooglePicker();
      const pickerRuntime = window.google?.picker;
      if (!pickerRuntime) throw new Error("保存先選択画面を読み込めませんでした。");
      const view = new pickerRuntime.DocsView(pickerRuntime.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes("application/vnd.google-apps.folder");
      const picker = new pickerRuntime.PickerBuilder()
        .addView(view)
        .setOAuthToken(tokenPayload.accessToken)
        .setDeveloperKey(tokenPayload.apiKey)
        .setAppId(tokenPayload.projectNumber)
        .setOrigin(window.location.origin)
        .enableFeature(pickerRuntime.Feature.SUPPORT_DRIVES)
        .setCallback((result) => {
          if (result.action === "picked") {
            const folderId = result.docs?.[0]?.id;
            if (!folderId) {
              setPhase("connected");
              setMessage("保存先フォルダを確認できませんでした。");
              return;
            }
            void saveSelectedFolder(folderId).catch((error: unknown) => {
              setPhase("connected");
              setMessage(error instanceof Error ? error.message : "保存先フォルダを登録できませんでした。");
            });
          } else if (result.action === "cancel") {
            setPhase("connected");
            setMessage("保存先の選択を取り消しました。");
          }
        })
        .build();
      picker.setVisible(true);
    } catch (error) {
      setPhase("connected");
      setMessage(error instanceof Error ? error.message : "保存先フォルダを選択できませんでした。");
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
          <div className="drive-setup-step"><span>2</span><div><strong>専用フォルダを選択</strong><small>「オンライン一次面接_自動格納」を選んでください。</small></div></div>
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
            </label>
          ) : (
            <div className="drive-folder-action">
              <div className="drive-connected-badge">Googleアカウント 接続済み</div>
              <button className="primary-action" onClick={() => void chooseFolder()} disabled={phase === "selecting" || phase === "ready"}>
                {phase === "selecting" ? "選択画面を準備中…" : phase === "ready" ? "設定完了" : "保存先フォルダを選ぶ"} <span>→</span>
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
          <p className="drive-security-note">接続に使う長期認証情報は暗号化して保管し、採用担当者の画面・応募者画面・格納レポートには表示しません。</p>
        </div>
      </section>
    </main>
  );
}
