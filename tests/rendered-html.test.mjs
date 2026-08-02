import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the TOKYO DOGS online first interview portal", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /TOKYO DOGS オンライン一次面接｜採用選考ポータル/);
  assert.match(html, /OFFICIAL SELECTION PORTAL/);
  assert.match(html, /オンライン一次面接/);
  assert.match(html, /TOKYO DOGS公式選考/);
  assert.match(html, /共に歩む仲間達へ/);
  assert.match(html, /あなたのことを、/);
  assert.match(html, /あなたらしく話してください。/);
  assert.doesNotMatch(html, /東京DOGSの仕事と、|あなたのこれからを話す。/);
  assert.match(html, /tokyo-dogs-logo\.jpg/);
  assert.match(html, /TOKYO DOGSの採用選考におけるオンライン一次面接/);
  assert.match(html, /オンライン採用担当者 茂木/);
  assert.match(html, /評価は笠間・山本だけが確認/);
  assert.match(html, /録画・文字起こし・選考利用に同意する/);
  assert.match(html, /<label for="candidate-name">氏名<\/label>/);
  assert.match(html, /placeholder="例：山田 花子"/);
  assert.match(html, /採用記録の照合と保存管理に使用します/);
  assert.match(html, /氏名を入力してください。/);
  assert.match(html, /入力した氏名は採用記録の照合と保存管理に使用します/);
  assert.match(html, /カメラ・マイクを確認して開始/);
  assert.match(html, /カメラとマイクの「許可」/);
  assert.doesNotMatch(html, /この画面を共有/);
  assert.match(html, /当社が手動で削除するまで保管します/);
  assert.doesNotMatch(html, /社内確認環境|テスト名/);
  assert.match(html, /笑顔の有無、顔立ち・容姿/);
  assert.match(html, /自動処理だけで合否を決定しません/);
  assert.match(html, /技術不具合は不利益に扱わず/);
  assert.match(html, /接続確認（選考対象外）/);
  assert.match(html, /interviewer-woman-medium-v2\.png/);
  assert.doesNotMatch(html, /interviewer-dog\.svg/);
  assert.match(html, /双方の音声/);
  assert.match(html, /茂木の音声/);
  assert.doesNotMatch(html, /茂木さん/);
  assert.match(html, /端末の音声を確認/);
  assert.match(html, /音声を確認/);
  assert.match(html, /og-online-first-interview-v3\.png/);
  assert.doesNotMatch(html, /求職者面談|公式面談|面談担当/);
  assert.doesNotMatch(html, /AI一次面接|AI INTERVIEW|AI面接担当|OpenAI API/);
  assert.doesNotMatch(html, /スマートフォン|スマホ|ONLINE INTERVIEW/);
  assert.doesNotMatch(html, /codex-preview/);
});

test("the candidate bundle gates the start button on an invite pre-flight, not on camera access", async () => {
  const html = await (await render()).text();
  // The candidate-facing wording must ship, and must not name internal settings.
  assert.match(html, /接続確認（選考対象外）/);
  assert.doesNotMatch(html, /INTERVIEW_REQUIRE_SIGNED_INVITE|INTERVIEW_INVITE_SIGNING_SECRET/);

  const { readdir } = await import("node:fs/promises");
  const clientDir = new URL("../dist/client/assets/", import.meta.url);
  const bundles = (await readdir(clientDir)).filter((name) => name.endsWith(".js"));
  const sources = await Promise.all(
    bundles.map((name) => readFile(new URL(name, clientDir), "utf8")),
  );
  const portal = sources.find((source) => source.includes("/api/interviews/invite"));
  assert.ok(portal, "candidate bundle must call the invite pre-flight");
  // The pre-flight has to gate the permission prompt, so the component that calls
  // getUserMedia is the one that must also run the pre-flight.
  assert.match(portal, /getUserMedia/);

  // The candidate-facing reasons must ship, and no internal setting name may.
  const client = sources.join("\n");
  for (const message of [
    /専用のリンクを開いてください/,
    /使用済みです/,
    /有効期限が切れています/,
    /受付準備が完了していません/,
    /保存領域を準備できませんでした/,
  ]) {
    assert.match(client, message);
  }
  assert.equal(/INTERVIEW_REQUIRE_SIGNED_INVITE|INTERVIEW_INVITE_SIGNING_SECRET/.test(client), false);
});

test("no page ships an inline event handler that the CSP would have to allow", async () => {
  // script-src still needs 'unsafe-inline' because the framework emits per-request
  // inline RSC payload scripts, whose bodies change on every render and cannot be
  // covered by hashes. script-src-attr 'none' therefore carries the inline-handler
  // half of the protection, and it only holds while every page keeps rendering its
  // handlers through React instead of as onclick="..." attributes.
  for (const path of ["/", "/staff", "/staff/google-drive", "/staff/invites", "/mobile-test"]) {
    const response = await render(path);
    assert.equal(response.status, 200, path);
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /script-src-attr 'none'/,
      `${path}: missing script-src-attr`,
    );
    const html = await response.text();
    assert.deepEqual([...html.matchAll(/\son[a-z]+\s*=\s*["']/gi)].map((match) => match[0]), [], path);
    assert.doesNotMatch(html, /(?:href|src)="javascript:/i, path);
  }
});

test("voice interview implements bidirectional audio health and recovery guards", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const gatewaySource = await readFile(new URL("../scripts/mobile-test-gateway.mjs", import.meta.url), "utf8");
  const persistenceSource = await readFile(new URL("../lib/interview-persistence.ts", import.meta.url), "utf8");
  const recordingRouteSource = await readFile(new URL("../app/api/interviews/recording/route.ts", import.meta.url), "utf8");
  assert.match(source, /あなたの音声/);
  assert.match(source, /茂木の音声/);
  assert.match(source, /resumeRemoteAudio/);
  assert.match(source, /primeRemoteAudioPlayback/);
  assert.match(source, /attachRemoteAudioToSpeaker/);
  assert.match(source, /isRemoteAudioPlaybackActive/);
  assert.match(source, /audio\.srcObject !== remoteStream/);
  assert.match(source, /createMediaStreamSource/);
  assert.match(source, /gain\.connect\(context\.destination\)/);
  assert.match(source, /data-testid="remote-audio-player"/);
  assert.match(source, /autoPlay\s+controls/);
  assert.match(source, /playSpeakerTest/);
  assert.match(source, /data-testid="prepared-audio-player"/);
  assert.match(source, /playPreparedAudio/);
  assert.match(source, /\/audio\/motegi-speaker-check\.mp3/);
  assert.match(source, /\/audio\/motegi-device-permission\.mp3/);
  assert.match(source, /\/audio\/motegi-devices-ready\.mp3/);
  assert.doesNotMatch(source, /playStartupChime/);
  const speakerTestBody = source.match(/function playSpeakerTest\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.match(speakerTestBody, /playPreparedAudio/);
  assert.doesNotMatch(speakerTestBody, /speakOnDevice|speechSynthesis/);
  for (const asset of [
    "motegi-speaker-check.mp3",
    "motegi-device-permission.mp3",
    "motegi-devices-ready.mp3",
  ]) {
    const audio = await stat(new URL(`../public/audio/${asset}`, import.meta.url));
    assert.ok(audio.size > 10_000, `${asset}: prepared audio asset is unexpectedly small`);
  }
  assert.match(source, /readLatestInterviewerTurn/);
  assert.match(source, /queueRemoteAudioRecovery/);
  assert.match(source, /monitorAudioStats/);
  assert.match(source, /armResponseWatchdog/);
  assert.match(source, /CANDIDATE_RESPONSE_DELAY_MS = 3_200/);
  assert.match(source, /type: "response\.cancel"/);
  assert.match(source, /reportCandidateEvent/);
  assert.match(source, /scheduleResponseAfterCandidatePause/);
  assert.match(source, /clearCandidateResponseDelay/);
  assert.match(source, /回答の続きがないか、少し待っています/);
  assert.match(source, /channel\.onclose/);
  assert.match(source, /channelOpenTimerRef/);
  assert.match(source, /attachRemoteAudioToRecording/);
  assert.match(source, /await startRecording\(activeStream, displayStreamRef\.current, remoteStreamRef\.current, \{/);
  assert.match(source, /resume: !isNewInterviewSession/);
  assert.match(source, /recordedInterviewSessionRef/);
  assert.match(source, /if \(!options\.resume\) \{\s*chunksRef\.current = \[\];/);
  // The turn-taking rules themselves are exercised by tests/interview-turn-taking.test.mjs
  // against recorded realtime event orders; here we only pin the wiring.
  assert.match(source, /applyTurnTaking\("assistant_output"\)/);
  assert.match(source, /typeof canvas\.captureStream !== "function"/);
  assert.match(source, /conversation\.item\.input_audio_transcription\.failed/);
  assert.match(source, /scheduleInterviewCompletion/);
  assert.match(source, /pendingCompletionTimerRef/);
  assert.match(source, /入力内容は送信・保存せず、録画・文字起こし・採用評価を行いません/);
  assert.match(source, /PORTAL CHECK COMPLETE/);
  assert.match(source, /入力内容は端末内の画面確認だけに使用し、外部送信・保存・録画・文字起こし・採用評価を行っていません/);
  const turnTakingSource = await readFile(new URL("../lib/interview-turn-taking.js", import.meta.url), "utf8");
  assert.match(turnTakingSource, /video\/mp4/);
  assert.match(turnTakingSource, /audio\/mp4/);
  assert.match(source, /TD-CONN-RESPONSE/);
  // The recruiter must be able to see why an evaluation was flagged for review.
  const staffSource = await readFile(new URL("../app/staff/page.tsx", import.meta.url), "utf8");
  assert.match(staffSource, /evidenceValidationWarnings/);
  assert.match(staffSource, /評価本文の要確認事項/);
  const driveSyncSource = await readFile(new URL("../lib/google-drive-sync.ts", import.meta.url), "utf8");
  assert.match(driveSyncSource, /評価本文の要確認事項/);
  assert.match(source, /stage === "setup"/);
  assert.match(source, /startMicrophoneMeter/);
  assert.match(source, /stopRealtime\(\{ keepLocalStream: true \}\)/);
  assert.match(source, /カメラとマイクは正常に確認できています/);
  assert.match(source, /画面共有を追加（任意）/);
  assert.match(source, /output_modalities: \["audio"\]/);
  assert.match(source, /自分の名前には敬称を付けず/);
  assert.match(styles, /\.remote-audio-player/);
  assert.doesNotMatch(styles, /audio\s*\{\s*display:\s*none/);
  assert.doesNotMatch(source, /モテギ/);
  assert.doesNotMatch(source, /茂木さん/);
  assert.doesNotMatch(persistenceSource, /legacyTestMode/);
  assert.doesNotMatch(recordingRouteSource, /objectKey:/);
  assert.match(gatewaySource, /og-online-first-interview-v3\.png/);
  assert.match(gatewaySource, /オンライン一次面接ポータル/);
  assert.match(gatewaySource, /permissions-policy/);
  assert.match(gatewaySource, /server\.on\("upgrade"/);
  assert.match(gatewaySource, /upstreamSocket\.pipe\(socket\)/);
});

test("in-app browser detection matches real LINE, Facebook, and Instagram user agents", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const match = source.match(/setEmbeddedBrowser\((\/.*?\/i)\.test\(navigator\.userAgent\)\)/);
  assert.ok(match, "embedded-browser detection regex not found in app/page.tsx");
  const detectEmbeddedBrowser = new Function("ua", `return (${match[1]}).test(ua);`);

  const lineIos = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/13.15.0";
  const facebookIos = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.0;FBBV/500;]";
  const instagramIos = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 275.0.0.27.98 (iPhone14,2; iOS 17_0; en_US; en-US; scale=3.00; 1170x2532; 458229237)";
  const instagramAndroid = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 310.0.0.32.120 Android (34/14; 420dpi; 1080x2280; Google/google; Pixel 8; husky; husky; en_US; 543980000)";
  const safariIos = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const chromeAndroid = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

  assert.equal(detectEmbeddedBrowser(lineIos), true, "LINE in-app browser must be detected");
  assert.equal(detectEmbeddedBrowser(facebookIos), true, "Facebook in-app browser must be detected");
  assert.equal(detectEmbeddedBrowser(instagramIos), true, "Instagram in-app browser (iOS) must be detected");
  assert.equal(detectEmbeddedBrowser(instagramAndroid), true, "Instagram in-app browser (Android) must be detected");
  assert.equal(detectEmbeddedBrowser(safariIos), false, "regular Safari must not be flagged as an in-app browser");
  assert.equal(detectEmbeddedBrowser(chromeAndroid), false, "regular Chrome must not be flagged as an in-app browser");
});

test("server-renders the protected recruiter review entry", async () => {
  const response = await render("/staff");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /公式選考レビュー/);
  assert.match(html, /OFFICIAL SELECTION REVIEW/);
  assert.match(html, /笠間・山本 専用/);
  assert.match(html, /アクセスは監査ログへ記録/);
  assert.doesNotMatch(html, /kasama-review-secret|INTERVIEW_REVIEW_TOKEN/);
  const source = await readFile(new URL("../app/staff/page.tsx", import.meta.url), "utf8");
  assert.match(source, /録画未格納/);
  assert.match(source, /録画を含め格納完了/);
});

test("server-renders the administrator-only Google Drive setup entry without secrets", async () => {
  const response = await render("/staff/google-drive");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /面接記録の/);
  assert.match(html, /保存先設定/);
  assert.match(html, /管理者アクセスキー/);
  assert.match(html, /オンライン一次面接_自動格納/);
  assert.match(html, /本番稼働条件を一括確認/);
  const source = await readFile(new URL("../app/staff/google-drive/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Google接続・暗号化設定/);
  assert.match(html, /秘密値は画面へ表示しません/);
  assert.match(html, /長期認証情報は暗号化して保管/);
  assert.doesNotMatch(html, /GOOGLE_DRIVE_CLIENT_SECRET|GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET|refresh_token/);
});

test("server-renders the administrator-only one-time candidate invite entry", async () => {
  const response = await render("/staff/invites");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /候補者リンクの/);
  assert.match(html, /安全な発行/);
  assert.match(html, /管理者アクセスキー/);
  assert.match(html, /1回限り使用できる/);
  assert.match(html, /同じリンクの再利用・期限切れ・改ざんを自動で拒否/);
  assert.doesNotMatch(html, /INTERVIEW_ADMIN_TOKEN|INTERVIEW_INVITE_SIGNING_SECRET/);
});

test("server-renders the selection-excluded portal check", async () => {
  const response = await render("/mobile-test");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /オンライン一次面接の/);
  assert.match(html, /オンライン一次面接ポータル確認/);
  assert.match(html, /オンライン採用担当者 茂木/);
  assert.doesNotMatch(html, /茂木さん/);
  assert.match(html, /選考対象外/);
  assert.match(html, /この確認内容は保存しません/);
  assert.match(html, /録画・音声接続・採用評価は行いません/);
  assert.match(html, /接続確認をはじめる/);
  assert.match(html, /interviewer-woman-medium-v2\.png/);
  assert.doesNotMatch(html, /スマートフォン|スマホ|ONLINE INTERVIEW/);
  assert.doesNotMatch(html, /求職者面談|公式面談|面談担当|INTERVIEW_REVIEW_TOKEN|OpenAI API/);
});
