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
  assert.match(html, /評価は権限を付与された採用担当者だけが確認/);
  assert.match(html, /録画・文字起こし・選考利用に同意する/);
  assert.match(html, /<label for="candidate-name">氏名<\/label>/);
  assert.match(html, /placeholder="例：山田 花子"/);
  assert.match(html, /採用記録の照合と保存管理に使用します/);
  assert.match(html, /氏名を入力してください。/);
  assert.match(html, /入力した氏名は採用記録の照合と保存管理に使用します/);
  assert.match(html, /カメラ・マイクを確認して開始/);
  assert.match(html, /カメラとマイクの「許可」/);
  assert.doesNotMatch(html, /この画面を共有/);
  assert.match(html, /面接実施日から原則1年間を保存見直し期限として管理します/);
  assert.doesNotMatch(html, /社内確認環境|テスト名/);
  assert.match(html, /笑顔の有無、顔立ち・容姿/);
  assert.match(html, /自動処理だけで合否を決定しません/);
  assert.match(html, /参加方法や技術不具合は不利益に扱わず/);
  assert.match(html, /文字入力/);
  assert.match(html, /カメラ・マイク不要/);
  assert.match(html, /接続確認（選考対象外）/);
  assert.match(html, /interviewer-mogi\.jpg/);
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
  const interviewSource = await readFile(new URL("../lib/interview.ts", import.meta.url), "utf8");
  const recordingRouteSource = await readFile(new URL("../app/api/interviews/recording/route.ts", import.meta.url), "utf8");
  const archiveRouteSource = await readFile(new URL("../app/api/interviews/archive/route.ts", import.meta.url), "utf8");
  const evaluationRouteSource = await readFile(new URL("../app/api/evaluate/route.ts", import.meta.url), "utf8");
  const recordedCompleteRouteSource = await readFile(new URL("../app/api/interviews/recorded/complete/route.ts", import.meta.url), "utf8");
  const recordingCompleteRouteSource = await readFile(new URL("../app/api/interviews/recording/upload/complete/route.ts", import.meta.url), "utf8");
  const staffReviewRouteSource = await readFile(new URL("../app/api/staff/review/route.ts", import.meta.url), "utf8");
  const driveSyncSource = await readFile(new URL("../lib/google-drive-sync.ts", import.meta.url), "utf8");
  const recordingUploadSource = await readFile(new URL("../lib/recording-upload.js", import.meta.url), "utf8");
  const interviewerStageSource = await readFile(new URL("../app/interviewer-stage.tsx", import.meta.url), "utf8");
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
  assert.match(source, /type: "conversation\.item\.truncate"/);
  assert.match(source, /remoteAudioRef\.current\?\.pause\(\)/);
  assert.match(source, /reportCandidateEvent/);
  assert.match(source, /scheduleResponseAfterCandidatePause/);
  assert.match(source, /clearCandidateResponseDelay/);
  assert.match(source, /回答の続きがないか、少し待っています/);
  assert.match(source, /channel\.onclose/);
  assert.match(source, /channelOpenTimerRef/);
  assert.match(source, /attachRemoteAudioToRecording/);
  assert.match(source, /remoteAnalyser/);
  assert.match(source, /REMOTE_AUDIO_SILENT/);
  // Recording coverage is a full-session, fail-closed signal. Mobile Safari can
  // expose the non-standard AudioContext state "interrupted", so production
  // code deliberately treats every non-running/non-closed state alike.
  assert.match(source, /recordingContext\.state !== "running" && recordingContext\.state !== "closed"/);
  assert.match(source, /REMOTE_AUDIO_CONTEXT_INTERRUPTED/);
  assert.match(source, /addEventListener\("statechange", handleContextState\)/);
  assert.match(source, /addEventListener\("mute", handleMute\)/);
  assert.match(source, /addEventListener\("unmute", handleUnmute\)/);
  assert.match(source, /addEventListener\("ended", handleEnded\)/);
  assert.match(source, /addEventListener\("pagehide", markPageHidden\)/);
  assert.match(source, /addEventListener\("pageshow", resumeInterviewAudio\)/);
  assert.match(source, /addEventListener\("touchend", resumeInterviewAudio\)/);
  assert.match(source, /reduceRecordingAudioCoverage/);
  const remoteMonitorBody = source.slice(
    source.indexOf("mix.remoteMonitorTimer = window.setInterval"),
    source.indexOf("}, 250);", source.indexOf("mix.remoteMonitorTimer = window.setInterval")),
  );
  assert.match(remoteMonitorBody, /remoteCoverageInvalid/);
  assert.match(remoteMonitorBody, /reduceRecordingAudioCoverage/);
  assert.doesNotMatch(remoteMonitorBody, /clearInterval/);
  assert.match(source, /mix\.remoteCoverageInvalid[\s\S]*?updateRecordingAudioCoverage\(false\)/);
  assert.match(source, /recordingHasBothAudioRef\.current === true[\s\S]*?"both"[\s\S]*?"candidate-only"[\s\S]*?"unverified"/);
  assert.match(recordingUploadSource, /X-Recording-Part-Index/);
  assert.match(recordingUploadSource, /X-Recording-Part-Sha256/);
  assert.match(recordingUploadSource, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(recordingUploadSource, /upload\/start/);
  assert.match(recordingUploadSource, /upload\/complete/);
  assert.match(source, /RECORDER_FINALIZE_TIMEOUT/);
  assert.match(source, /recordingFinalizeTimedOut[\s\S]*120_000/);
  const recordingUploadIndex = source.indexOf("await uploadRecording(recordingBlob);");
  const finalizationIndex = source.indexOf("await storeInterviewFinalization();", recordingUploadIndex);
  assert.ok(
    recordingUploadIndex >= 0 && finalizationIndex > recordingUploadIndex,
    "recording storage must finish before fallback completion can start the Drive archive",
  );
  assert.match(source, /await syncInterviewArchive\(\);/);
  assert.match(archiveRouteSource, /await stepInterviewToGoogleDrive\(sessionId\)/);
  assert.match(archiveRouteSource, /committedOffset: pendingStep\.committedOffset/);
  assert.match(driveSyncSource, /Advances a candidate archive by at most one Drive recording chunk/);
  assert.doesNotMatch(evaluationRouteSource, /scheduleGoogleDriveSync/);
  assert.doesNotMatch(recordedCompleteRouteSource, /scheduleGoogleDriveSync/);
  assert.doesNotMatch(recordingRouteSource, /scheduleGoogleDriveSync/);
  assert.doesNotMatch(recordingCompleteRouteSource, /scheduleGoogleDriveSync/);
  assert.doesNotMatch(staffReviewRouteSource, /scheduleGoogleDriveSync/);
  assert.doesNotMatch(driveSyncSource, /waitUntil|scheduleGoogleDriveSync/);
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
  assert.match(staffSource, /録画内の双方音声は未確認です/);
  assert.match(staffSource, /応募者の回答記録を基にした補助情報/);
  assert.match(staffSource, /文字起こし内一致（録画未照合）/);
  assert.doesNotMatch(staffSource, /<span>照合済み<\/span>/);
  assert.match(staffSource, /録画式は自動評価していません。人手による録画照合が必須です/);
  assert.match(staffSource, /保存状態：録画ファイルは保存済みです/);
  assert.match(staffSource, /品質状態：録画内の双方音声は未確認です/);
  assert.match(driveSyncSource, /評価本文の要確認事項/);
  assert.match(driveSyncSource, /応募者端末で生成された文字起こし/);
  assert.match(source, /stage === "setup"/);
  assert.match(source, /startMicrophoneMeter/);
  assert.match(source, /stopRealtime\(\{ keepLocalStream: true \}\)/);
  assert.doesNotMatch(source, /fetch\("\/api\/health"/);
  assert.match(source, /録画式のオンライン一次面接へ進む/);
  assert.match(source, /startRecordedFallback\(\{ continueCurrentAttempt: true \}\)/);
  assert.doesNotMatch(source, /面接回線へ再接続/);
  assert.match(source, /\/api\/interviews\/recorded\/start/);
  assert.match(source, /\/api\/interviews\/recorded\/answer/);
  assert.match(source, /\/api\/interviews\/recorded\/complete/);
  const recordedAnswerRetry = source.slice(
    source.indexOf("async function retryRecordedAnswerTranscription("),
    source.indexOf("function finishRecordedAnswerCapture("),
  );
  assert.match(recordedAnswerRetry, /\/api\/interviews\/recorded\/answer/);
  assert.doesNotMatch(recordedAnswerRetry, /X-Recorded-Answer-Bytes|body:/);
  assert.match(source, /回答音声の自動文字起こしを根拠に評価補助を作成しました/);
  assert.match(source, /採用担当者が録画と文字起こしを照合して最終判断/);
  assert.match(source, /録画・音声の品質は不利益に使用しません/);
  assert.match(source, /recordedAnswerBlobsRef/);
  assert.match(source, /audioBitsPerSecond: 48_000/);
  assert.match(source, /if \(!startRecordedAnswerCapture\(\)\)/);
  assert.match(source, /recorder\.onerror = \(\) => finishReject/);
  assert.match(source, /画面共有を追加（任意）/);
  assert.match(source, /output_modalities: \["audio"\]/);
  assert.match(source, /LIGHT_OPENING_QUESTION/);
  assert.match(interviewSource, /まず、今のお仕事や学校について、簡単に教えてください。/);
  assert.match(source, /自分の名前には敬称を付けず/);
  assert.match(source, /<InterviewerStage speaking=/);
  assert.match(interviewerStageSource, /音声案内中/);
  assert.match(interviewerStageSource, /回答を確認中/);
  assert.match(interviewerStageSource, /案内イメージ/);
  assert.match(interviewerStageSource, /prefers-reduced-motion: reduce/);
  for (let cut = 1; cut <= 10; cut += 1) {
    const image = await stat(new URL(`../public/interviewer-mogi-${cut}.jpg`, import.meta.url));
    assert.ok(image.size > 50_000, `interviewer-mogi-${cut}.jpg is unexpectedly small`);
  }
  assert.match(styles, /\.remote-audio-player/);
  assert.match(styles, /\.interviewer-stage/);
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
  const { isEmbeddedInterviewBrowser: detectEmbeddedBrowser } = await import("../lib/interview-device-readiness.js");
  assert.match(source, /setEmbeddedBrowser\(isEmbeddedInterviewBrowser\(navigator\.userAgent\)\)/);

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

test("candidate receipt stays fail-closed until the server verifies the final Drive archive", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const voiceSealRoute = await readFile(
    new URL("../app/api/interviews/voice/transcript/seal/route.ts", import.meta.url),
    "utf8",
  );
  const persistence = await readFile(new URL("../lib/interview-persistence.ts", import.meta.url), "utf8");

  // Neither an R2 recording upload nor a locally completed evaluation is a
  // candidate receipt. Only the archive API's stored result may unlock it.
  assert.match(
    source,
    /archiveSyncState === "stored" \? "ONLINE FIRST INTERVIEW RECEIVED" : "INTERVIEW SAVE NOT YET VERIFIED"/,
  );
  assert.match(
    source,
    /archiveSyncState === "stored" \? "オンライン一次面接を受け付けました。" : "面接記録の保存はまだ完了していません。"/,
  );
  assert.match(
    source,
    /mode === "text" && archiveSyncState === "stored" && <div className="validation-box"><strong>文字入力によるオンライン一次面接を受け付けました<\/strong>/,
  );
  assert.doesNotMatch(
    source,
    /recordingUploadState === "stored" && <div className="validation-box"><strong>[^<]*受け付けました/,
  );
  assert.doesNotMatch(source, /録画を継続できませんでした。面接は受け付け/);

  const archiveSync = source.slice(
    source.indexOf("async function syncInterviewArchive(attempt = 0)"),
    source.indexOf("async function uploadRecording(blob: Blob)"),
  );
  assert.match(archiveSync, /catch \(error\) \{\s*setArchiveSyncState\("error"\);\s*throw error;/);
  assert.match(archiveSync, /!response\.ok \|\|\s*!data\?\.stored/);
  assert.match(archiveSync, /needsRecording && data\.recordingIncluded !== true/);
  assert.match(archiveSync, /data\.transcriptAvailable !== true/);
  assert.match(archiveSync, /data\.transcriptKind !== "actual_transcript"/);
  assert.match(source, /const activeInterviewCanLoseUnsentMedia = stage === "interview" && mode !== "internal-test";/);
  assert.match(source, /!activeInterviewCanLoseUnsentMedia &&\s*!completionSavePending/);
  assert.match(source, /endingRef\.current = true;\s*\/\/ From this point[\s\S]*setCompletionSavePending\(true\);/);

  const retryRecording = source.slice(
    source.indexOf("async function retryRecordingUpload()"),
    source.indexOf("async function retryInterviewFinalization()"),
  );
  assert.equal(
    [...retryRecording.matchAll(/setRecordingUploadState\("error"\)/g)].length,
    1,
    "only the recording-upload catch may return the recording to error",
  );
  assert.ok(
    retryRecording.indexOf('setRecordingUploadState("error")') < retryRecording.indexOf("await storeInterviewFinalization()"),
    "evaluation or Drive failures must happen after the only recording-error assignment",
  );

  const completion = source.slice(
    source.indexOf("async function completeInterview(reason: string)"),
    source.indexOf("function handleRealtimeEvent(event: RealtimeEvent)"),
  );
  assert.match(completion, /let recordingStored = mode === "text";/);
  assert.match(completion, /completionPhase === "recording" && !recordingStored/);
  assert.doesNotMatch(completion, /recordingUploadState !== "stored"/);
  assert.match(completion, /録画データを端末で生成できなかったため、面接記録の保存は完了していません/);
  assert.ok(
    completion.indexOf("await sealRecordedFallbackCompletion();") >= 0 &&
      completion.indexOf("await sealRecordedFallbackCompletion();") < completion.indexOf("await uploadRecording(recordingBlob);"),
    "the exact fallback answer count must be durably sealed before recording upload and staff recovery",
  );
  assert.ok(
    completion.indexOf("await sealVoiceTranscriptCompletion();") >= 0 &&
      completion.indexOf("await sealVoiceTranscriptCompletion();") < completion.indexOf("await uploadRecording(recordingBlob);"),
    "a clean actual voice transcript must be durably sealed before the large recording upload",
  );
  assert.match(source, /\/api\/interviews\/recorded\/seal/);
  const voiceSeal = source.slice(
    source.indexOf("async function sealVoiceTranscriptCompletion()"),
    source.indexOf("async function syncInterviewArchive(attempt = 0)"),
  );
  assert.match(voiceSeal, /if \(voiceTranscriptCompletionBlocker\(\)\)/);
  assert.match(voiceSeal, /turn\.speaker === "candidate" && turn\.text\.trim\(\)\.length > 0/);
  assert.match(voiceSeal, /\/api\/interviews\/voice\/transcript\/seal/);
  assert.match(voiceSeal, /transcriptionComplete: true/);
  assert.match(voiceSealRoute, /authorizeInterviewRequest\(request, sessionId\)/);
  assert.match(voiceSealRoute, /hasTrustedRequestOrigin\(request\)/);
  assert.match(persistence, /event_type = 'voice_transcript_sealed'/);
  assert.match(persistence, /VOICE_TRANSCRIPT_SEAL_CONFLICT/);

  const retryRecordingWithSeal = source.slice(
    source.indexOf("async function retryRecordingUpload()"),
    source.indexOf("async function retryInterviewFinalization()"),
  );
  assert.ok(
    retryRecordingWithSeal.indexOf('mode === "voice"') >= 0 &&
      retryRecordingWithSeal.indexOf("await sealVoiceTranscriptCompletion();") <
        retryRecordingWithSeal.indexOf("await uploadRecording(blob);"),
    "recording retries must replay the lightweight transcript seal before media upload",
  );

  // Recorded fallback is receipted only after answer-audio transcription and
  // final Drive readback, while automatic evaluation remains disabled.
  assert.match(source, /録画と回答文字起こしの格納結果をサーバーで再確認済みです。採用担当者が両者を照合します。/);
});

test("capped or errored MediaRecorder output cannot be uploaded or receipted as a complete interview", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /const recordingCompleteRef = useRef\(false\);/);
  assert.match(source, /const recordingFinalStopRequestedRef = useRef\(false\);/);

  const recorderSetup = source.slice(
    source.indexOf("let recordingCaptureFailed = false;"),
    source.indexOf("function deviceErrorMessage(error: unknown)"),
  );
  const capHandler = recorderSetup.slice(
    recorderSetup.indexOf("if (nextSize > MAX_CLIENT_RECORDING_BYTES)"),
    recorderSetup.indexOf("recorder.onerror ="),
  );
  assert.match(capHandler, /recordingCaptureFailed = true;/);
  assert.match(capHandler, /recordingCompleteRef\.current = false;/);
  assert.match(capHandler, /recorder\.stop\(\);/);

  const errorHandler = recorderSetup.slice(
    recorderSetup.indexOf("recorder.onerror ="),
    recorderSetup.indexOf("recorder.onstop ="),
  );
  assert.match(errorHandler, /recordingCaptureFailed = true;/);
  assert.match(errorHandler, /recordingCompleteRef\.current = false;/);

  const stopHandler = recorderSetup.slice(
    recorderSetup.indexOf("recorder.onstop ="),
    recorderSetup.indexOf("recorder.start(1_000)"),
  );
  assert.match(stopHandler, /recordingCaptureFailed \|\|[\s\S]*recordingSizeCappedRef\.current \|\|[\s\S]*!recordingFinalStopRequestedRef\.current/);
  assert.match(stopHandler, /recordingResolveRef\.current\?\.\(null\);/);
  assert.ok(
    stopHandler.indexOf("recordingResolveRef.current?.(null);") <
      stopHandler.indexOf("recordingCompleteRef.current = true;"),
    "a partial Blob must resolve as null before the clean-stop path can mark a recording complete",
  );
  assert.match(source, /recordingFinalStopRequestedRef\.current = endingRef\.current;\s*activeRecorder\.stop\(\);/);

  const upload = source.slice(
    source.indexOf("async function uploadRecording(blob: Blob)"),
    source.indexOf("async function storeInterviewFinalization()"),
  );
  assert.match(upload, /if \(!recordingCompleteRef\.current\) \{[\s\S]*throw new Error/);
  assert.ok(
    upload.indexOf("if (!recordingCompleteRef.current)") < upload.indexOf("uploadRecordingResumably"),
    "recording completeness must be checked before any upload starts",
  );

  const retry = source.slice(
    source.indexOf("async function retryRecordingUpload()"),
    source.indexOf("function runPendingCompletion()"),
  );
  assert.match(retry, /if \(!recordingCompleteRef\.current\) \{[\s\S]*return;/);

  const completion = source.slice(
    source.indexOf("async function completeInterview(reason: string)"),
    source.indexOf("function handleRealtimeEvent(event: RealtimeEvent)"),
  );
  assert.match(completion, /const recordingComplete = mode === "text" \|\| \(!recordingFinalizeTimedOut && recordingCompleteRef\.current\);/);
  assert.match(completion, /if \(mode !== "text" && \(!recordingBlob \|\| !recordingComplete\)\) \{/);

  const archive = source.slice(
    source.indexOf("async function syncInterviewArchive(attempt = 0)"),
    source.indexOf("async function uploadRecording(blob: Blob)"),
  );
  assert.match(archive, /if \(mode !== "text" && !recordingCompleteRef\.current\) \{/);
  assert.match(
    source,
    /recordingUploadState === "error" && recordingBlobRef\.current && recordingCompleteRef\.current && <div[^>]*><strong>録画の送信を再開できます/,
  );
});

test("a failed realtime answer transcription requires one explicit repair before finalization", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /const voiceTranscriptionFailureRef = useRef\(false\);/);
  assert.match(source, /const realtimeTranscriptIntegrityRef = useRef\(initialRealtimeTranscriptIntegrity\(\)\);/);

  const failedEvent = source.slice(
    source.indexOf('if (type === "conversation.item.input_audio_transcription.failed")'),
    source.indexOf("const isAssistantDelta ="),
  );
  assert.match(failedEvent, /applyRealtimeTranscriptIntegrity\(event\);/);
  assert.match(failedEvent, /promptCandidateToRepeatForTranscript\(\);/);
  assert.match(failedEvent, /integrity\.transcriptionFailed[\s\S]*TRANSCRIPTION_ID_MISSING/);

  const finalization = source.slice(
    source.indexOf("async function storeInterviewFinalization()"),
    source.indexOf("function setArchiveCompletionMessage()"),
  );
  assert.match(
    finalization,
    /if \(mode === "voice" && voiceTranscriptCompletionBlocker\(\)\) \{[\s\S]*throw new Error/,
  );
  assert.ok(
    [...source.matchAll(/resetRealtimeTranscriptIntegrity\(\);/g)].length >= 3,
    "the voice-transcription integrity state must reset for new, restarted, and reset sessions",
  );
});

test("server-renders the protected recruiter review entry", async () => {
  const response = await render("/staff");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /公式選考レビュー/);
  assert.match(html, /OFFICIAL SELECTION REVIEW/);
  assert.match(html, /採用担当者専用/);
  assert.match(html, /担当者(?:表示)?名/);
  assert.match(html, /例：採用担当/);
  assert.match(html, /候補者一覧を表示/);
  assert.match(html, /候補者用URLをコピー/);
  assert.match(html, /最近の候補者一覧から記録を選べます/);
  assert.match(html, /閲覧と保存操作は監査ログへ記録/);
  assert.doesNotMatch(html, /staff-review-secret|INTERVIEW_STAFF_TOKEN/);
  const source = await readFile(new URL("../app/staff/page.tsx", import.meta.url), "utf8");
  assert.match(source, /SHARED RECRUITER ACCESS/);
  assert.match(source, /担当者表示名（自己申告）/);
  assert.match(source, /個人認証済みの本人情報ではありません/);
  assert.match(source, /録画未格納/);
  assert.match(source, /録画を含め格納完了/);
  assert.match(source, /review\.driveSync\.transcriptKind === "partial_transcript_human_review" \? "技術保留記録を格納（人手確認必須）"/);
  assert.match(source, /録画と中断時点までの一部文字起こしを、技術保留記録として格納しています/);
  assert.match(source, /review\.sourceTranscriptVerified === true && review\.driveSync\.recordingIncluded/);
  assert.match(source, /turn\.id\.startsWith\("recorded-transcribed-"\)/);
  assert.match(source, /自動評価なし・人手照合必須/);
  assert.match(source, /RECORDED_TRANSCRIPT_EVALUATION_WARNING/);
  assert.match(source, /録画式・回答根拠付き自動分析（録画未照合）/);
  assert.match(source, /自動文字起こし由来・録画未照合です。人手確認が必須で、自動合否は行いません/);
  assert.match(source, /録画パート不足——応募者の再開または人手確認待ち/);
  assert.match(source, /旧式録画の不足パートを検出——人手確認が必要/);
  assert.match(source, /Drive整合性/);
  assert.match(source, /保存後の差分を検出/);
  assert.match(source, /保存後差分を検出しました。格納完了とは扱わず/);
  assert.match(source, /現在内容は照合未完です。格納完了とは扱わず/);
  assert.match(source, /差分検出（要確認）/);
  assert.match(source, /現状維持・リンク保有者が編集可能/);
  assert.match(source, /保存完了は音声品質の確認完了を意味しません/);
  assert.match(source, /候補者を検索/);
  assert.match(source, /面接IDを直接指定/);
  assert.match(source, /navigator\.clipboard\.writeText/);
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
  assert.match(source, /承認済み保存先を照合しています/);
  assert.match(source, /body: JSON\.stringify\(\{\}\)/);
  assert.doesNotMatch(source, /apis\.google\.com\/js\/api\.js/);
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
  assert.match(html, /interviewer-mogi\.jpg/);
  assert.doesNotMatch(html, /スマートフォン|スマホ|ONLINE INTERVIEW/);
  assert.doesNotMatch(html, /求職者面談|公式面談|面談担当|INTERVIEW_STAFF_TOKEN|OpenAI API/);
});
