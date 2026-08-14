const EMBEDDED_BROWSER_PATTERN = /(?:\bLine\/|FBAN|FBAV|Instagram|MicroMessenger|TikTok|BytedanceWebview|\bGSA\/|;\s*wv\)|\bwv\b.*Version\/4\.0)/i;

export function isEmbeddedInterviewBrowser(userAgent) {
  const normalized = String(userAgent || "");
  if (EMBEDDED_BROWSER_PATTERN.test(normalized)) return true;
  // A generic iOS WKWebView often omits the host app name entirely. Unlike
  // Safari/Chrome/Firefox on iOS, it also omits the Safari token. The same UA
  // can be exposed by an installed PWA, which cannot prove uninterrupted
  // camera capture either; keep camera mode fail-closed and leave text mode.
  return /(?:iPhone|iPad|iPod).*AppleWebKit/i.test(normalized) && !/Safari\//i.test(normalized);
}

export function cameraInterviewReadiness(input) {
  if (input.embeddedBrowser) {
    return { ready: false, code: "EMBEDDED_BROWSER", message: "SafariまたはChromeで開いてください。" };
  }
  if (input.recoveryRequired) {
    return { ready: false, code: "LOCAL_MEDIA_INTERRUPTED", message: "マイクを再取得して、声をもう一度確認してください。" };
  }
  if (!input.hasLiveVideo) {
    return { ready: false, code: "CAMERA_NOT_LIVE", message: "カメラ映像を確認できません。" };
  }
  if (!input.hasLiveAudio) {
    return { ready: false, code: "MICROPHONE_NOT_LIVE", message: "マイク接続を確認できません。" };
  }
  if (!input.microphoneVerified) {
    return { ready: false, code: "MICROPHONE_NOT_HEARD", message: "マイクに向かって話し、入力メーターが動くことを確認してください。" };
  }
  if (!input.speakerVerified) {
    return { ready: false, code: "SPEAKER_NOT_VERIFIED", message: "「確認音を再生」を押し、音声が聞こえることを確認してください。" };
  }
  return { ready: true, code: "READY", message: "映像・マイク・スピーカーを確認済みです。" };
}

export function initialLocalMediaHealth() {
  return { blocked: false, code: null, revision: 0 };
}

export function reduceLocalMediaHealth(state, event) {
  if (["track_muted", "track_ended", "device_changed", "page_hidden"].includes(event.type)) {
    return {
      blocked: true,
      code: event.type === "track_muted"
        ? "LOCAL_MIC_TRACK_MUTED"
        : event.type === "track_ended"
          ? "LOCAL_MIC_TRACK_ENDED"
          : event.type === "device_changed"
            ? "LOCAL_MEDIA_DEVICE_CHANGED"
            : "LOCAL_MEDIA_PAGE_HIDDEN",
      revision: state.revision + 1,
    };
  }
  // Merely receiving an `unmute` event cannot clear a sticky interruption: the
  // browser may have silently switched devices. Only an explicit user-driven
  // getUserMedia recovery followed by a real-energy check may resume.
  if (event.type === "track_unmuted" || event.type === "microphone_verified") return state;
  if (event.type === "explicit_recovery_verified") {
    return { blocked: false, code: null, revision: state.revision + 1 };
  }
  return state;
}

export function initialMicrophoneVerification() {
  return { consecutiveSamples: 0, verified: false };
}

export function reduceMicrophoneVerification(state, input) {
  if (state.verified) return state;
  if (!input.trackLive || input.level < 4) return initialMicrophoneVerification();
  const consecutiveSamples = state.consecutiveSamples + 1;
  return { consecutiveSamples, verified: consecutiveSamples >= 5 };
}

export function reduceSpeakerVerification(state, event) {
  if (event === "reset") return "idle";
  if (event === "playback_started") return "playing";
  if (event === "playback_failed") return "error";
  if (event === "playback_completed") return state === "playing" ? "played" : state;
  // play() resolving, onplaying, or onended only proves browser playback. The
  // candidate's explicit confirmation is the separate evidence of audibility.
  if (event === "candidate_confirmed") return state === "played" ? "passed" : state;
  return state;
}
