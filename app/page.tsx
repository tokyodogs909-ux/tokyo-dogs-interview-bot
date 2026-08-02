"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EMPLOYMENT_OPTIONS,
  INTERNAL_TEST_QUESTIONS,
  RECORDED_FALLBACK_QUESTIONS,
  INTERVIEW_ACCESS_MESSAGES,
  INTERVIEW_ACCESS_STATES,
  INTERVIEW_TOPIC_IDS,
  PREFERRED_LOCATION_MAX_LENGTH,
  normalizePreferredLocation,
  type InterviewAccessState,
  type InterviewTopicId,
  type TranscriptTurn,
} from "@/lib/interview";
import {
  initialTurnTakingState,
  isNewInterviewRecord,
  isExpectedResponseCancelError,
  reduceTurnTaking,
  supportedRecordingMimeTypes,
} from "@/lib/interview-turn-taking";

type Stage = "intro" | "setup" | "interview" | "evaluating" | "review";
/** "checking" while the pre-flight is in flight; every other value mirrors InterviewAccessState. */
type InviteGate = "checking" | InterviewAccessState;
type InterviewMode = "voice" | "text" | "recorded-fallback" | "internal-test";

// Keep the final single-request upload below the server's 95 MiB limit even on
// browsers that do not strictly honor the requested MediaRecorder bitrates.
// The recorder emits one-second chunks, so stopping at the last complete chunk
// also avoids retaining an unbounded video in mobile Safari memory.
const MAX_CLIENT_RECORDING_BYTES = 90 * 1024 * 1024;
type ConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "candidate-speaking"
  | "waiting-pause"
  | "ai-speaking"
  | "error";
type ConnectionStep = "idle" | "permissions" | "session" | "voice" | "ready";
type CandidateAudioState = "idle" | "checking" | "ready" | "detected" | "muted" | "error";
type RemoteAudioState = "idle" | "waiting" | "receiving" | "playing" | "blocked" | "error";
type NetworkAudioState = "idle" | "connecting" | "connected" | "reconnecting" | "error";
type RecordingCaptureState = "idle" | "starting" | "recording" | "error";
type SpeakerTestState = "idle" | "playing" | "passed" | "error";
type SetupPhase = "idle" | "requesting" | "devices-ready" | "connecting" | "error";
type RecordingAudioMix = {
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  localSource: MediaStreamAudioSourceNode;
  remoteSource: MediaStreamAudioSourceNode | null;
  remoteAnalyser: AnalyserNode | null;
  remoteMonitorTimer: number | null;
  remoteEnergyDetected: boolean;
  remoteQuietSamples: number;
};
type RemotePlaybackGraph = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  streamId: string;
};
type MicrophoneMeter = {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  animationFrame: number;
};

type RealtimeEvent = {
  type?: string;
  event_id?: string;
  item_id?: string;
  response_id?: string;
  output_index?: number;
  content_index?: number;
  transcript?: string;
  delta?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  error?: {
    message?: string;
    type?: string;
    code?: string;
    event_id?: string;
    param?: string;
  };
  item?: {
    id?: string;
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
  };
};

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

const CANDIDATE_RESPONSE_DELAY_MS = 3_200;
// How long after sending response.cancel a realtime "error" event is treated as
// the server rejecting that cancel (the response had already finished) instead
// of a real interview failure.
const CANCEL_RACE_GRACE_MS = 5_000;

function inviteTokenFromLocation() {
  return new URLSearchParams(window.location.search).get("invite")?.trim() ?? "";
}

function isInterviewAccessState(value: unknown): value is InterviewAccessState {
  return (INTERVIEW_ACCESS_STATES as readonly string[]).includes(value as string);
}

/**
 * Asks the server whether this browser holds a usable signed invite. Runs before the
 * camera and microphone prompt so a candidate on the plain top-level URL is told to
 * open their personal link instead of being walked through permissions only to fail
 * at the end. Any unexpected response is treated as "not allowed to start" — this
 * check must never be the thing that opens the interview up.
 */
async function checkInterviewAccess(): Promise<InterviewAccessState> {
  try {
    const response = await fetch(
      `/api/interviews/invite?token=${encodeURIComponent(inviteTokenFromLocation())}`,
      { headers: { Accept: "application/json" }, cache: "no-store" },
    );
    const data = (await response.json().catch(() => null)) as { status?: string } | null;
    if (response.ok && data?.status === "ok") return "ok";
    return isInterviewAccessState(data?.status) && data?.status !== "ok" ? data.status : "unreachable";
  } catch {
    return "unreachable";
  }
}

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function isCompleteInterviewEvent(event: RealtimeEvent) {
  if (
    event.type === "response.function_call_arguments.done" &&
    event.name === "complete_interview"
  ) {
    return true;
  }
  return (
    event.type === "response.output_item.done" &&
    event.item?.type === "function_call" &&
    event.item?.name === "complete_interview"
  );
}

type CompletionArguments = {
  completion_reason?: "all_topics_covered" | "candidate_requested_stop" | "safety_escalation";
  topics_covered?: InterviewTopicId[];
  topics_missing?: InterviewTopicId[];
};

function parseCompletionArguments(event: RealtimeEvent): CompletionArguments {
  const raw = event.arguments ?? event.item?.arguments ?? "";
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CompletionArguments;
  } catch {
    return {};
  }
}

function validateCompletionArguments(args: CompletionArguments) {
  if (
    args.completion_reason === "candidate_requested_stop" ||
    args.completion_reason === "safety_escalation"
  ) {
    return { accepted: true, missingTopicIds: args.topics_missing ?? [] };
  }

  const covered = new Set(args.topics_covered ?? []);
  const declaredMissing = new Set(args.topics_missing ?? []);
  const missingTopicIds = INTERVIEW_TOPIC_IDS.filter(
    (topicId) => !covered.has(topicId) || declaredMissing.has(topicId),
  );
  return {
    accepted:
      args.completion_reason === "all_topics_covered" &&
      declaredMissing.size === 0 &&
      missingTopicIds.length === 0,
    missingTopicIds,
  };
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("intro");
  const [sessionId, setSessionId] = useState("TD-PENDING");
  const [candidateName, setCandidateName] = useState("");
  const [employment, setEmployment] = useState<(typeof EMPLOYMENT_OPTIONS)[number]>("正社員");
  const [location, setLocation] = useState("");
  const [consent, setConsent] = useState(false);
  const [mode, setMode] = useState<InterviewMode>("voice");
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [connectionStep, setConnectionStep] = useState<ConnectionStep>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [textDraft, setTextDraft] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [processingWarning, setProcessingWarning] = useState("");
  const [sessionStarting, setSessionStarting] = useState(false);
  const [screenCaptureState, setScreenCaptureState] = useState<"idle" | "ready" | "ended" | "unavailable">("idle");
  const [recordingUploadState, setRecordingUploadState] = useState<"idle" | "uploading" | "stored" | "error">("idle");
  const [recordingCaptureState, setRecordingCaptureState] = useState<RecordingCaptureState>("idle");
  const [recordingHasBothAudio, setRecordingHasBothAudio] = useState<boolean | null>(null);
  const [candidateAudioState, setCandidateAudioState] = useState<CandidateAudioState>("idle");
  const [remoteAudioState, setRemoteAudioState] = useState<RemoteAudioState>("idle");
  const [networkAudioState, setNetworkAudioState] = useState<NetworkAudioState>("idle");
  const [audioNotice, setAudioNotice] = useState("");
  const [speakerTestState, setSpeakerTestState] = useState<SpeakerTestState>("idle");
  const [setupPhase, setSetupPhase] = useState<SetupPhase>("idle");
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [embeddedBrowser, setEmbeddedBrowser] = useState(false);
  const [copiedPortalLink, setCopiedPortalLink] = useState(false);
  const [screenShareSupported, setScreenShareSupported] = useState(false);
  const [inviteGate, setInviteGate] = useState<InviteGate>("checking");
  const [recordedQuestionIndex, setRecordedQuestionIndex] = useState(0);
  const [recordedQuestionReady, setRecordedQuestionReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const preparedAudioRef = useRef<HTMLAudioElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingBytesRef = useRef(0);
  const recordingSizeCappedRef = useRef(false);
  const recordingBlobRef = useRef<Blob | null>(null);
  const recordingPromiseRef = useRef<Promise<Blob | null> | null>(null);
  const recordingResolveRef = useRef<((blob: Blob | null) => void) | null>(null);
  const recordingAudioContextRef = useRef<AudioContext | null>(null);
  const recordingAudioMixRef = useRef<RecordingAudioMix | null>(null);
  const recordingHasBothAudioRef = useRef<boolean | null>(null);
  const playbackAudioContextRef = useRef<AudioContext | null>(null);
  const remotePlaybackGraphRef = useRef<RemotePlaybackGraph | null>(null);
  const microphoneMeterRef = useRef<MicrophoneMeter | null>(null);
  const playbackPrimeRef = useRef<{
    oscillator: OscillatorNode;
    gain: GainNode;
    destination: MediaStreamAudioDestinationNode;
  } | null>(null);
  const accessTokenRef = useRef("");
  const sessionIdRef = useRef("TD-PENDING");
  const transcriptRef = useRef<TranscriptTurn[]>([]);
  const recordedInterviewSessionRef = useRef<string | null>(null);
  const assistantPartialsRef = useRef(new Map<string, string>());
  const processedCompletionCallsRef = useRef(new Set<string>());
  const endingRef = useRef(false);
  const disconnectTimerRef = useRef<number | null>(null);
  const channelOpenTimerRef = useRef<number | null>(null);
  const responseWatchdogRef = useRef<number | null>(null);
  const candidateResponseDelayTimerRef = useRef<number | null>(null);
  const pendingCompletionTimerRef = useRef<number | null>(null);
  const pendingCompletionReasonRef = useRef<string | null>(null);
  const statsTimerRef = useRef<number | null>(null);
  const playbackRetryTimersRef = useRef<number[]>([]);
  const resumeRemoteAudioActionRef = useRef<(showNotice: boolean) => Promise<boolean>>(async () => false);
  const previousAudioStatsRef = useRef({ sent: 0, received: 0 });
  const turnStateRef = useRef(initialTurnTakingState());
  const pendingCancelEventsRef = useRef(new Map<string, number>());
  const currentAssistantAudioItemRef = useRef("");
  const assistantAudioStartedAtRef = useRef<number | null>(null);
  const recordingGenerationRef = useRef(0);
  const reportedCandidateEventsRef = useRef(new Set<string>());
  const recordedQuestionTimerRef = useRef<number | null>(null);
  const recordedFallbackActiveRef = useRef(false);

  const candidateTurns = useMemo(
    () => transcript.filter((turn) => turn.speaker === "candidate").length,
    [transcript],
  );

  useEffect(() => {
    streamRef.current = stream;
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, stage]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      // Instagram's in-app browser UA has no trailing slash after "Instagram"
      // (e.g. "... Instagram 275.0.0.27.98 (iPhone14,2; ...)"), unlike LINE/Facebook's
      // "Line/13.x" and "FBAN/FBIOS", so it needs its own unslashed alternative.
      setEmbeddedBrowser(/(?:Line|FBAN|FBAV)\/|Instagram/i.test(navigator.userAgent));
      setScreenShareSupported(
        typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
        window.matchMedia("(pointer: fine)").matches,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void checkInterviewAccess().then((state) => {
      if (!cancelled) setInviteGate(state);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (stage !== "interview") return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [stage]);

  useEffect(() => {
    conversationRef.current?.scrollTo({
      top: conversationRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [transcript]);

  useEffect(() => {
    if (stage !== "interview" || mode !== "voice") return;
    const resumePlayback = () => {
      if (document.visibilityState === "visible") void resumeRemoteAudioActionRef.current(false);
    };
    document.addEventListener("visibilitychange", resumePlayback);
    window.addEventListener("pageshow", resumePlayback);
    window.addEventListener("online", resumePlayback);
    return () => {
      document.removeEventListener("visibilitychange", resumePlayback);
      window.removeEventListener("pageshow", resumePlayback);
      window.removeEventListener("online", resumePlayback);
    };
  }, [stage, mode]);

  useEffect(() => {
    resumeRemoteAudioActionRef.current = resumeRemoteAudio;
  });

  useEffect(() => {
    const preparedAudio = preparedAudioRef.current;
    return () => {
      channelRef.current?.close();
      peerRef.current?.close();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      displayStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (disconnectTimerRef.current) window.clearTimeout(disconnectTimerRef.current);
      if (channelOpenTimerRef.current) window.clearTimeout(channelOpenTimerRef.current);
      if (responseWatchdogRef.current) window.clearTimeout(responseWatchdogRef.current);
      if (candidateResponseDelayTimerRef.current) window.clearTimeout(candidateResponseDelayTimerRef.current);
      if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
      if (statsTimerRef.current) window.clearInterval(statsTimerRef.current);
      if (recordedQuestionTimerRef.current) window.clearTimeout(recordedQuestionTimerRef.current);
      playbackRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      cleanupRecordingAudioMix();
      stopMicrophoneMeter();
      disconnectRemoteSpeaker();
      stopAudioPrime();
      if (preparedAudio) {
        preparedAudio.pause();
        preparedAudio.removeAttribute("src");
        preparedAudio.load();
      }
      void recordingAudioContextRef.current?.close();
      void playbackAudioContextRef.current?.close();
      window.speechSynthesis?.cancel();
    };
  }, []);

  function getPlaybackAudioContext() {
    if (!playbackAudioContextRef.current || playbackAudioContextRef.current.state === "closed") {
      playbackAudioContextRef.current = new AudioContext();
    }
    return playbackAudioContextRef.current;
  }

  function stopMicrophoneMeter() {
    const meter = microphoneMeterRef.current;
    if (!meter) return;
    window.cancelAnimationFrame(meter.animationFrame);
    try {
      meter.source.disconnect();
      meter.analyser.disconnect();
    } catch {
      // The audio graph can already be disconnected after an iOS audio-session reset.
    }
    microphoneMeterRef.current = null;
    setMicrophoneLevel(0);
  }

  async function startMicrophoneMeter(activeStream: MediaStream) {
    stopMicrophoneMeter();
    const audioTrack = activeStream.getAudioTracks()[0];
    if (!audioTrack) return;
    try {
      let context = recordingAudioContextRef.current;
      if (!context || context.state === "closed") {
        context = new AudioContext();
        recordingAudioContextRef.current = context;
      }
      if (context.state !== "running") await context.resume();
      const source = context.createMediaStreamSource(new MediaStream([audioTrack]));
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const meter: MicrophoneMeter = { source, analyser, animationFrame: 0 };
      const update = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / samples.length);
        const level = Math.min(100, Math.round(rms * 520));
        setMicrophoneLevel((current) => Math.abs(current - level) >= 2 ? level : current);
        if (level >= 4) setCandidateAudioState("detected");
        else if (audioTrack.enabled && !audioTrack.muted) setCandidateAudioState("ready");
        meter.animationFrame = window.requestAnimationFrame(update);
      };
      microphoneMeterRef.current = meter;
      update();
    } catch {
      setMicrophoneLevel(0);
    }
  }

  function stopAudioPrime() {
    const prime = playbackPrimeRef.current;
    if (!prime) return;
    try {
      prime.oscillator.stop();
    } catch {
      // The oscillator may already have stopped when the remote stream arrives.
    }
    prime.oscillator.disconnect();
    prime.gain.disconnect();
    prime.destination.disconnect();
    prime.destination.stream.getTracks().forEach((track) => track.stop());
    playbackPrimeRef.current = null;
  }

  function disconnectRemoteSpeaker() {
    const graph = remotePlaybackGraphRef.current;
    if (!graph) return;
    try {
      graph.source.disconnect();
      graph.gain.disconnect();
    } catch {
      // The nodes may already be disconnected after a mobile audio-session reset.
    }
    remotePlaybackGraphRef.current = null;
  }

  async function attachRemoteAudioToSpeaker(remoteStream: MediaStream) {
    const remoteTracks = remoteStream.getAudioTracks().filter((track) => track.readyState === "live");
    if (!remoteTracks.length) return false;
    try {
      const context = getPlaybackAudioContext();
      const existing = remotePlaybackGraphRef.current;
      if (!existing || existing.streamId !== remoteStream.id) {
        disconnectRemoteSpeaker();
        const source = context.createMediaStreamSource(new MediaStream(remoteTracks));
        const gain = context.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(context.destination);
        remotePlaybackGraphRef.current = { context, source, gain, streamId: remoteStream.id };
      }
      if (context.state !== "running") await context.resume();
      return context.state === "running";
    } catch {
      disconnectRemoteSpeaker();
      return false;
    }
  }

  function isRemoteAudioPlaybackActive(remoteStream: MediaStream) {
    const graph = remotePlaybackGraphRef.current;
    if (
      graph?.streamId === remoteStream.id &&
      graph.context.state === "running"
    ) {
      return true;
    }
    const audio = remoteAudioRef.current;
    return Boolean(
      audio &&
      audio.srcObject === remoteStream &&
      !audio.paused &&
      !audio.muted,
    );
  }

  function primeRemoteAudioPlayback() {
    const audio = remoteAudioRef.current;
    if (!audio) return;
    try {
      const context = getPlaybackAudioContext();
      void context.resume().catch(() => undefined);
      if (!playbackPrimeRef.current) {
        const destination = context.createMediaStreamDestination();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 440;
        gain.gain.value = 0.00001;
        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start();
        playbackPrimeRef.current = { oscillator, gain, destination };
      }
      audio.srcObject = playbackPrimeRef.current.destination.stream;
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audio.muted = false;
      audio.volume = 1;
      void audio.play().catch(() => undefined);
    } catch {
      // The explicit recovery button remains available if Web Audio is unavailable.
    }
  }

  function speakOnDevice(text: string, updateSpeakerTest = false, keepAudioPrimed = false) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      if (updateSpeakerTest) setSpeakerTestState("error");
      setAudioNotice("この端末では音声確認を開始できませんでした。端末の音量と消音設定をご確認ください。");
      return;
    }
    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.volume = 1;
    const japaneseVoice = window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("ja"));
    if (japaneseVoice) utterance.voice = japaneseVoice;
    utterance.onstart = () => {
      if (updateSpeakerTest) setSpeakerTestState("playing");
    };
    utterance.onend = () => {
      if (updateSpeakerTest) setSpeakerTestState("passed");
      if (!keepAudioPrimed && !remoteStreamRef.current) stopAudioPrime();
    };
    utterance.onerror = (event) => {
      if (event.error === "canceled" || event.error === "interrupted") return;
      if (updateSpeakerTest) setSpeakerTestState("error");
      if (!keepAudioPrimed && !remoteStreamRef.current) stopAudioPrime();
      setAudioNotice("音声確認を再生できませんでした。端末の消音を解除し、音量を上げてもう一度お試しください。");
    };
    window.speechSynthesis.speak(utterance);
  }

  async function playPreparedAudio(
    source: string,
    options: { updateSpeakerTest?: boolean; keepAudioPrimed?: boolean } = {},
  ) {
    const audio = preparedAudioRef.current;
    if (!audio) {
      if (options.updateSpeakerTest) setSpeakerTestState("error");
      setAudioNotice("確認音声の準備ができませんでした。ページを再読み込みして、もう一度お試しください。");
      return false;
    }

    audio.pause();
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    audio.src = source;
    audio.currentTime = 0;
    audio.muted = false;
    audio.volume = 1;
    audio.setAttribute("playsinline", "");
    if (options.updateSpeakerTest) setSpeakerTestState("playing");

    const fail = () => {
      if (options.updateSpeakerTest) setSpeakerTestState("error");
      if (!options.keepAudioPrimed && !remoteStreamRef.current) stopAudioPrime();
      setAudioNotice("確認音声を再生できませんでした。端末の消音を解除し、音量を上げて「もう一度聞く」を押してください。");
    };
    audio.onplaying = () => {
      if (options.updateSpeakerTest) setSpeakerTestState("playing");
      setAudioNotice("");
    };
    audio.onended = () => {
      if (options.updateSpeakerTest) setSpeakerTestState("passed");
      if (!options.keepAudioPrimed && !remoteStreamRef.current) stopAudioPrime();
    };
    audio.onerror = fail;

    try {
      await audio.play();
      return true;
    } catch {
      fail();
      return false;
    }
  }

  function playSpeakerTest() {
    primeRemoteAudioPlayback();
    void playPreparedAudio("/audio/motegi-speaker-check.mp3", {
      updateSpeakerTest: true,
      keepAudioPrimed: stage === "setup" || Boolean(streamRef.current),
    });
  }

  async function copyPortalLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedPortalLink(true);
      window.setTimeout(() => setCopiedPortalLink(false), 2_000);
    } catch {
      setCopiedPortalLink(false);
    }
  }

  function readLatestInterviewerTurn() {
    const latestQuestion = [...transcriptRef.current]
      .reverse()
      .find((turn) => turn.speaker === "interviewer");
    if (!latestQuestion) {
      speakOnDevice("オンライン採用担当者の茂木です。最初の質問を準備しています。少しお待ちください。");
      return;
    }
    speakOnDevice(latestQuestion.text);
  }

  function clearResponseWatchdog() {
    if (responseWatchdogRef.current) window.clearTimeout(responseWatchdogRef.current);
    responseWatchdogRef.current = null;
  }

  function isCandidateSpeaking() {
    return turnStateRef.current.candidateSpeaking;
  }

  function isAwaitingResponse() {
    return turnStateRef.current.awaitingResponse;
  }

  function sendResponseCancel() {
    const channel = channelRef.current;
    if (!channel || channel.readyState !== "open") return;
    // Stop both local playback routes immediately. response.cancel stops future
    // audio at the service, but already-buffered WebRTC audio can otherwise keep
    // speaking over the candidate on mobile devices.
    remoteAudioRef.current?.pause();
    disconnectRemoteSpeaker();
    const now = Date.now();
    for (const [eventId, sentAt] of pendingCancelEventsRef.current) {
      if (now - sentAt > CANCEL_RACE_GRACE_MS) pendingCancelEventsRef.current.delete(eventId);
    }
    const eventId = `cancel_${crypto.randomUUID()}`;
    pendingCancelEventsRef.current.set(eventId, now);
    try {
      channel.send(JSON.stringify({ type: "response.cancel", event_id: eventId }));
      const itemId = currentAssistantAudioItemRef.current;
      const startedAt = assistantAudioStartedAtRef.current;
      if (itemId && startedAt !== null) {
        channel.send(JSON.stringify({
          type: "conversation.item.truncate",
          event_id: `truncate_${crypto.randomUUID()}`,
          item_id: itemId,
          content_index: 0,
          audio_end_ms: Math.max(0, Math.min(120_000, Date.now() - startedAt)),
        }));
      }
    } catch {
      pendingCancelEventsRef.current.delete(eventId);
    }
  }

  // Applies one realtime turn-taking event to the shared state machine and runs
  // the side effects it asks for. Keeping the decisions in lib/interview-turn-taking.js
  // lets the recorded event orders be regression-tested without a browser.
  function applyTurnTaking(
    event: Parameters<typeof reduceTurnTaking>[1],
    options: { suppressNextQuestion?: boolean } = {},
  ) {
    const { state, actions } = reduceTurnTaking(turnStateRef.current, event);
    turnStateRef.current = state;
    let scheduledNextQuestion = false;
    for (const action of actions) {
      if (action === "cancelActiveResponse") sendResponseCancel();
      else if (action === "clearNextQuestionDelay") clearCandidateResponseDelay();
      else if (action === "clearResponseWatchdog") clearResponseWatchdog();
      else if (action === "armResponseWatchdog") armResponseWatchdog(false);
      else if (action === "scheduleNextQuestion" && !options.suppressNextQuestion) {
        scheduleResponseAfterCandidatePause();
        scheduledNextQuestion = true;
      }
    }
    return { state, scheduledNextQuestion };
  }

  function reportCandidateEvent(
    eventType: "audio_playback_blocked" | "transcription_failed" | "recording_unavailable" | "connection_failed" | "candidate_requested_stop",
    code = "",
  ) {
    const activeSessionId = sessionIdRef.current;
    const accessToken = accessTokenRef.current;
    const dedupeKey = `${eventType}:${code}`;
    if (!activeSessionId.startsWith("TD-") || activeSessionId === "TD-PENDING" || !accessToken || reportedCandidateEventsRef.current.has(dedupeKey)) return;
    reportedCandidateEventsRef.current.add(dedupeKey);
    void fetch("/api/interviews/event", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: activeSessionId, eventType, code }),
      keepalive: true,
    }).catch(() => undefined);
  }

  function clearCandidateResponseDelay() {
    if (candidateResponseDelayTimerRef.current) {
      window.clearTimeout(candidateResponseDelayTimerRef.current);
    }
    candidateResponseDelayTimerRef.current = null;
  }

  function scheduleResponseAfterCandidatePause() {
    clearCandidateResponseDelay();
    if (endingRef.current || isCandidateSpeaking() || isAwaitingResponse()) return;
    setConnectionState("waiting-pause");
    candidateResponseDelayTimerRef.current = window.setTimeout(() => {
      candidateResponseDelayTimerRef.current = null;
      if (endingRef.current || isCandidateSpeaking() || isAwaitingResponse()) return;
      const channel = channelRef.current;
      if (!channel || channel.readyState !== "open") {
        setConnectionState("error");
        setNetworkAudioState("error");
        setErrorMessage("TD-CONN-DATA: 回答後の質問を開始できませんでした。接続をやり直してください。");
        return;
      }
      channel.send(JSON.stringify({
        type: "response.create",
        response: { output_modalities: ["audio"] },
      }));
      armResponseWatchdog(true);
    }, CANDIDATE_RESPONSE_DELAY_MS);
  }

  function armResponseWatchdog(allowAutomaticRetry: boolean) {
    clearResponseWatchdog();
    turnStateRef.current = { ...turnStateRef.current, awaitingResponse: true };
    responseWatchdogRef.current = window.setTimeout(() => {
      if (!isAwaitingResponse() || endingRef.current) return;
      const channel = channelRef.current;
      if (allowAutomaticRetry && channel?.readyState === "open") {
        setNetworkAudioState("reconnecting");
        setAudioNotice("返答の受信に時間がかかっているため、音声を再接続しています。");
        channel.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions: "直前の会話への返答が端末で受信できなかった可能性があります。重複を避け、会話の続きとして短く返答し、一つだけ質問してください。",
          },
        }));
        armResponseWatchdog(false);
        return;
      }
      turnStateRef.current = { ...turnStateRef.current, awaitingResponse: false, candidateTurnPending: false };
      setConnectionState("error");
      setNetworkAudioState("error");
      setAudioNotice("");
      setErrorMessage("TD-CONN-RESPONSE: 茂木からの返答を受信できませんでした。通信環境を確認し、接続をやり直してください。");
    }, allowAutomaticRetry ? 16_000 : 24_000);
  }

  async function resumeRemoteAudio(showNotice: boolean) {
    const audio = remoteAudioRef.current;
    const remoteStream = remoteStreamRef.current;
    if (!audio || !remoteStream?.getAudioTracks().length) {
      setRemoteAudioState("waiting");
      if (showNotice) setAudioNotice("茂木の音声を受信しています。少しお待ちください。");
      return false;
    }
    stopAudioPrime();
    if (audio.srcObject !== remoteStream) audio.srcObject = remoteStream;
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audio.volume = 1;
    try {
      const speakerConnected = await attachRemoteAudioToSpeaker(remoteStream);
      audio.muted = speakerConnected;
      const recordingContext = recordingAudioContextRef.current;
      if (recordingContext?.state === "suspended") await recordingContext.resume();
      try {
        await audio.play();
      } catch (error) {
        if (!speakerConnected) throw error;
      }
      setRemoteAudioState("playing");
      setAudioNotice("");
      return true;
    } catch {
      disconnectRemoteSpeaker();
      audio.muted = false;
      try {
        await audio.play();
        setRemoteAudioState("playing");
        setAudioNotice("");
        return true;
      } catch {
        // An explicit candidate gesture is required when both playback routes are blocked.
      }
      setRemoteAudioState("blocked");
      if (showNotice) setAudioNotice("端末が音声の自動再生を止めています。「茂木の音声を再開」を押してください。");
      return false;
    }
  }

  function queueRemoteAudioRecovery() {
    playbackRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    playbackRetryTimersRef.current = [0, 250, 1_000, 2_500].map((delay, index) => window.setTimeout(() => {
      const remoteStream = remoteStreamRef.current;
      if (remoteStream && isRemoteAudioPlaybackActive(remoteStream)) {
        setRemoteAudioState("playing");
        setAudioNotice("");
        return;
      }
      void resumeRemoteAudio(index === 3);
    }, delay));
  }

  function monitorAudioStats(peer: RTCPeerConnection) {
    if (statsTimerRef.current) window.clearInterval(statsTimerRef.current);
    previousAudioStatsRef.current = { sent: 0, received: 0 };
    statsTimerRef.current = window.setInterval(async () => {
      if (peer.connectionState !== "connected") return;
      try {
        const report = await peer.getStats();
        let sent = 0;
        let received = 0;
        report.forEach((item) => {
          const stats = item as RTCStats & {
            type: string;
            kind?: string;
            mediaType?: string;
            bytesSent?: number;
            bytesReceived?: number;
          };
          const isAudio = stats.kind === "audio" || stats.mediaType === "audio";
          if (stats.type === "outbound-rtp" && isAudio) sent += stats.bytesSent ?? 0;
          if (stats.type === "inbound-rtp" && isAudio) received += stats.bytesReceived ?? 0;
        });
        const previous = previousAudioStatsRef.current;
        const microphoneEnabled = streamRef.current?.getAudioTracks()[0]?.enabled ?? false;
        if (sent > previous.sent && microphoneEnabled && !isCandidateSpeaking()) setCandidateAudioState("ready");
        if (received > previous.received) {
          if (isCandidateSpeaking()) {
            setRemoteAudioState("receiving");
            previousAudioStatsRef.current = { sent, received };
            return;
          }
          const remoteStream = remoteStreamRef.current;
          if (remoteStream && isRemoteAudioPlaybackActive(remoteStream)) {
            setRemoteAudioState("playing");
          } else {
            setRemoteAudioState("receiving");
            void resumeRemoteAudio(false).then((playing) => {
              if (!playing && !endingRef.current) {
                setAudioNotice("質問音声は届いていますが、端末で再生が止まっています。「茂木の音声を再開」を押してください。");
              }
            });
          }
        }
        previousAudioStatsRef.current = { sent, received };
      } catch {
        // A transient stats failure must not interrupt the interview itself.
      }
    }, 4_000);
  }

  function upsertTurn(turn: TranscriptTurn) {
    const current = transcriptRef.current;
    const index = current.findIndex((item) => item.id === turn.id);
    const next = index >= 0
      ? current.map((item, itemIndex) => itemIndex === index ? turn : item)
      : [...current, turn];
    transcriptRef.current = next;
    setTranscript(next);
  }

  function cleanupRecordingAudioMix() {
    const mix = recordingAudioMixRef.current;
    if (!mix) return;
    if (mix.remoteMonitorTimer !== null) window.clearInterval(mix.remoteMonitorTimer);
    try {
      mix.localSource.disconnect();
      mix.remoteSource?.disconnect();
      mix.remoteAnalyser?.disconnect();
      mix.destination.disconnect();
    } catch {
      // Nodes can already be disconnected after a recorder failure.
    }
    mix.destination.stream.getTracks().forEach((track) => track.stop());
    recordingAudioMixRef.current = null;
  }

  function updateRecordingAudioCoverage(value: boolean | null) {
    recordingHasBothAudioRef.current = value;
    setRecordingHasBothAudio(value);
  }

  function attachRemoteAudioToRecording(remoteStream: MediaStream) {
    const remoteTracks = remoteStream.getAudioTracks().filter((track) => track.readyState === "live");
    if (!remoteTracks.length) return false;
    const mix = recordingAudioMixRef.current;
    if (!mix || recorderRef.current?.state !== "recording") {
      updateRecordingAudioCoverage(false);
      return false;
    }
    try {
      if (mix.remoteMonitorTimer !== null) window.clearInterval(mix.remoteMonitorTimer);
      mix.remoteSource?.disconnect();
      mix.remoteAnalyser?.disconnect();
      const remoteSource = mix.context.createMediaStreamSource(new MediaStream(remoteTracks));
      const analyser = mix.context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.65;
      remoteSource.connect(analyser);
      analyser.connect(mix.destination);
      mix.remoteSource = remoteSource;
      mix.remoteAnalyser = analyser;
      mix.remoteEnergyDetected = false;
      mix.remoteQuietSamples = 0;
      if (mix.context.state === "suspended") void mix.context.resume().catch(() => undefined);
      updateRecordingAudioCoverage(false);
      const samples = new Uint8Array(analyser.fftSize);
      mix.remoteMonitorTimer = window.setInterval(() => {
        if (recordingAudioMixRef.current !== mix || mix.remoteEnergyDetected) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          sum += normalized * normalized;
        }
        if (Math.sqrt(sum / samples.length) >= 0.004) {
          mix.remoteEnergyDetected = true;
          updateRecordingAudioCoverage(true);
          if (mix.remoteMonitorTimer !== null) window.clearInterval(mix.remoteMonitorTimer);
          mix.remoteMonitorTimer = null;
          return;
        }
        if (turnStateRef.current.awaitingResponse) mix.remoteQuietSamples += 1;
        if (mix.remoteQuietSamples >= 40) {
          reportCandidateEvent("recording_unavailable", "REMOTE_AUDIO_SILENT");
          setAudioNotice("録画内の茂木の音声を確認できません。面接は継続し、採用担当者が記録状態を確認します。");
          if (mix.remoteMonitorTimer !== null) window.clearInterval(mix.remoteMonitorTimer);
          mix.remoteMonitorTimer = null;
        }
      }, 250);
      return false;
    } catch {
      updateRecordingAudioCoverage(false);
      reportCandidateEvent("recording_unavailable", "REMOTE_AUDIO_MIX_FAILED");
      setAudioNotice("録画内の茂木の音声を確認できません。面接は継続し、採用担当者が記録状態を確認します。");
      return false;
    }
  }

  async function startRecording(
    activeStream: MediaStream | null,
    displayStream: MediaStream | null,
    remoteStream: MediaStream | null,
    options: { resume?: boolean } = {},
  ) {
    if (!activeStream || typeof MediaRecorder === "undefined") {
      setRecordingCaptureState("error");
      recordingPromiseRef.current = Promise.resolve(null);
      return;
    }
    // A recoverable WebRTC drop must not split the recording into independently
    // encoded WebM/MP4 containers. Concatenating those byte streams can produce a
    // file that only plays its first segment. Keep the original MediaRecorder
    // running and attach the replacement remote audio track to the existing mix.
    if (options.resume && recorderRef.current?.state === "recording") {
      if (remoteStream) attachRemoteAudioToRecording(remoteStream);
      setRecordingCaptureState("recording");
      return;
    }
    if (options.resume && recordingSizeCappedRef.current) {
      setRecordingCaptureState("error");
      return;
    }
    setRecordingCaptureState("starting");
    updateRecordingAudioCoverage(null);
    // A reconnect (options.resume) restarts the MediaRecorder but must keep the
    // chunks captured before the disconnect so the final blob still contains the
    // full interview instead of only the segment recorded after recovery.
    if (!options.resume) {
      chunksRef.current = [];
      recordingBytesRef.current = 0;
      recordingSizeCappedRef.current = false;
    }
    // Each recorder belongs to one generation. A previous recorder's stop event
    // can still be queued when a reconnect starts a new one; without this guard
    // it would resolve the new promise with the pre-disconnect blob and the
    // interview would be uploaded truncated.
    const generation = recordingGenerationRef.current + 1;
    recordingGenerationRef.current = generation;
    const ownsRecording = () => recordingGenerationRef.current === generation;
    recordingBlobRef.current = null;
    recordingPromiseRef.current = new Promise((resolve) => {
      recordingResolveRef.current = resolve;
    });
    cleanupRecordingAudioMix();
    let stopComposite: (() => void) | null = null;
    let videoTracks = activeStream.getVideoTracks().slice(0, 1);
    if (displayStream?.getVideoTracks().length && activeStream.getVideoTracks().length) {
      try {
        const canvas = document.createElement("canvas");
        if (typeof canvas.captureStream !== "function") throw new Error("CANVAS_CAPTURE_UNAVAILABLE");
        canvas.width = 1280;
        canvas.height = 720;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("CANVAS_CONTEXT_UNAVAILABLE");
        const screenVideo = document.createElement("video");
        const cameraVideo = document.createElement("video");
        screenVideo.srcObject = displayStream;
        cameraVideo.srcObject = activeStream;
        screenVideo.muted = true;
        cameraVideo.muted = true;
        screenVideo.playsInline = true;
        cameraVideo.playsInline = true;
        void screenVideo.play().catch(() => undefined);
        void cameraVideo.play().catch(() => undefined);
        let animationFrame = 0;
        const draw = () => {
          context.fillStyle = "#e8f5fb";
          context.fillRect(0, 0, canvas.width, canvas.height);
          const screenIsLive = displayStream.getVideoTracks().some((track) => track.readyState === "live");
          if (screenIsLive && screenVideo.readyState >= 2) {
            context.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
          }
          if (cameraVideo.readyState >= 2) {
            if (screenIsLive) {
              const width = 320;
              const height = 180;
              const x = canvas.width - width - 24;
              const y = canvas.height - height - 24;
              context.fillStyle = "#ffffff";
              context.fillRect(x - 5, y - 5, width + 10, height + 10);
              context.drawImage(cameraVideo, x, y, width, height);
            } else {
              context.drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);
            }
          }
          animationFrame = window.requestAnimationFrame(draw);
        };
        draw();
        const canvasStream = canvas.captureStream(15);
        videoTracks = canvasStream.getVideoTracks().slice(0, 1);
        stopComposite = () => {
          window.cancelAnimationFrame(animationFrame);
          canvasStream.getTracks().forEach((track) => track.stop());
          screenVideo.pause();
          cameraVideo.pause();
          screenVideo.srcObject = null;
          cameraVideo.srcObject = null;
        };
      } catch {
        setScreenCaptureState("unavailable");
        setAudioNotice("この端末では面接画面の合成録画を開始できないため、カメラと双方の音声を録画します。");
      }
    }
    let audioTracks = activeStream.getAudioTracks().slice(0, 1);
    let audioContext: AudioContext | null = recordingAudioContextRef.current;
    let hasBothAudio = false;
    if (audioTracks.length) {
      try {
        if (!audioContext || audioContext.state === "closed") {
          audioContext = new AudioContext();
          recordingAudioContextRef.current = audioContext;
        }
        if (audioContext.state !== "running") await audioContext.resume();
        const destination = audioContext.createMediaStreamDestination();
        const localSource = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
        localSource.connect(destination);
        recordingAudioMixRef.current = {
          context: audioContext,
          destination,
          localSource,
          remoteSource: null,
          remoteAnalyser: null,
          remoteMonitorTimer: null,
          remoteEnergyDetected: false,
          remoteQuietSamples: 0,
        };
        audioTracks = destination.stream.getAudioTracks();
      } catch {
        updateRecordingAudioCoverage(false);
        cleanupRecordingAudioMix();
        setAudioNotice("録画内の双方音声を確認できないため、応募者側の音声で録画を継続します。採用担当者が記録状態を確認します。");
      }
    }
    const recordingStream = new MediaStream([
      ...videoTracks,
      ...audioTracks,
    ]);
    const hasVideo = recordingStream.getVideoTracks().length > 0;
    // iOS Safari records MP4 only and Android/desktop Chrome WebM only, so the
    // container is chosen per device instead of assumed.
    const candidates = supportedRecordingMimeTypes(
      hasVideo,
      (mimeType) => MediaRecorder.isTypeSupported(mimeType),
    );
    let selectedRecorder: MediaRecorder | null = null;
    for (const mimeType of candidates) {
      try {
        const recorder = new MediaRecorder(recordingStream, {
          mimeType,
          audioBitsPerSecond: 48_000,
          ...(hasVideo ? { videoBitsPerSecond: 360_000 } : {}),
        });
        recorder.ondataavailable = (event) => {
          if (event.data.size <= 0 || recordingSizeCappedRef.current) return;
          const nextSize = recordingBytesRef.current + event.data.size;
          if (nextSize > MAX_CLIENT_RECORDING_BYTES) {
            recordingSizeCappedRef.current = true;
            reportCandidateEvent("recording_unavailable", "CLIENT_RECORDING_SIZE_LIMIT");
            setRecordingCaptureState("error");
            setAudioNotice("録画容量が安全上限に達したため、ここまでの録画を保護しました。面接は継続し、採用担当者が記録状態を確認します。");
            if (recorder.state !== "inactive") {
              try {
                recorder.stop();
              } catch {
                recordingResolveRef.current?.(null);
                recordingResolveRef.current = null;
              }
            }
            return;
          }
          chunksRef.current.push(event.data);
          recordingBytesRef.current = nextSize;
        };
        recorder.onerror = () => {
          if (!ownsRecording()) return;
          setRecordingCaptureState("error");
          reportCandidateEvent("recording_unavailable", "RECORDER_ERROR");
          setAudioNotice("録画を継続できませんでした。面接は受け付け、採用担当者が記録状態を確認します。");
          if (recorder.state !== "inactive") {
            try {
              recorder.stop();
            } catch {
              recordingResolveRef.current?.(null);
              recordingResolveRef.current = null;
            }
          }
        };
        recorder.onstop = () => {
          stopComposite?.();
          cleanupRecordingAudioMix();
          if (recorderRef.current === recorder) recorderRef.current = null;
          if (!ownsRecording()) return;
          if (!chunksRef.current.length) {
            setRecordingCaptureState("error");
            recordingResolveRef.current?.(null);
            recordingResolveRef.current = null;
            return;
          }
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || (hasVideo ? "video/webm" : "audio/webm"),
          });
          recordingBlobRef.current = blob;
          recordingResolveRef.current?.(blob);
          recordingResolveRef.current = null;
        };
        recorder.start(1_000);
        selectedRecorder = recorder;
        recorderRef.current = recorder;
        hasBothAudio = remoteStream ? attachRemoteAudioToRecording(remoteStream) : false;
        break;
      } catch {
        // Try the next browser-supported recording format.
      }
    }
    if (!selectedRecorder) {
      stopComposite?.();
      cleanupRecordingAudioMix();
      setRecordingCaptureState("error");
      reportCandidateEvent("recording_unavailable", "FORMAT_UNAVAILABLE");
      setAudioNotice("この端末では録画を開始できませんでした。面接は継続し、採用担当者が記録状態を確認します。");
      recordingResolveRef.current?.(null);
      recordingResolveRef.current = null;
      return;
    }
    updateRecordingAudioCoverage(hasBothAudio);
    setRecordingCaptureState("recording");
  }

  function deviceErrorMessage(error: unknown) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return embeddedBrowser
        ? "TD-CONN-MEDIA: この画面内ではカメラ・マイクを開始できませんでした。右上または右下のメニューから、端末の標準ブラウザで開いてください。"
        : "TD-CONN-MEDIA: ブラウザのサイト設定から、カメラとマイクを「許可」にしてもう一度お試しください。";
    }
    if (name === "NotFoundError") return "TD-CONN-MEDIA: 使用できるカメラまたはマイクが見つかりません。端末の設定をご確認ください。";
    if (name === "NotReadableError") return "TD-CONN-MEDIA: カメラまたはマイクをほかのアプリが使用しています。通話・撮影アプリを閉じてもう一度お試しください。";
    if (error instanceof Error && (error.message.startsWith("オンライン一次面接") || error.message.startsWith("TD-CONN"))) return error.message;
    return "TD-CONN-MEDIA: カメラとマイクを開始できませんでした。「許可」を選び、もう一度お試しください。";
  }

  async function enableScreenCapture() {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
      setScreenCaptureState("unavailable");
      return;
    }
    try {
      displayStreamRef.current?.getTracks().forEach((track) => track.stop());
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 20 } },
        audio: false,
      });
      displayStreamRef.current = displayStream;
      setScreenCaptureState("ready");
      displayStream.getVideoTracks()[0]?.addEventListener("ended", () => {
        displayStreamRef.current = null;
        setScreenCaptureState("ended");
      });
    } catch {
      setScreenCaptureState("unavailable");
    }
  }

  async function connectPreparedInterview() {
    const activeStream = streamRef.current;
    if (!activeStream || sessionStarting) return;
    const preferredLocation = normalizePreferredLocation(location);
    if (!preferredLocation) return;
    setSessionStarting(true);
    setSetupPhase("connecting");
    setConnectionState("connecting");
    setConnectionStep("session");
    setNetworkAudioState("connecting");
    setRemoteAudioState("waiting");
    setErrorMessage("");
    let continueWithRecordedInterview = false;
    try {
      let activeSessionId = sessionIdRef.current;
      let activeAccessToken = accessTokenRef.current;
      if (!activeSessionId || activeSessionId === "TD-PENDING" || !activeAccessToken) {
        const response = await fetch("/api/interviews/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidateName,
            employment,
            location: preferredLocation,
            consent: true,
            inviteToken: inviteTokenFromLocation(),
          }),
        });
        const data = (await response.json()) as { sessionId?: string; accessToken?: string; error?: string };
        if (!response.ok || !data.sessionId || !data.accessToken) {
          throw new Error(data.error || "オンライン一次面接の記録を準備できませんでした。");
        }
        activeSessionId = data.sessionId;
        activeAccessToken = data.accessToken;
        accessTokenRef.current = activeAccessToken;
        sessionIdRef.current = activeSessionId;
        setSessionId(activeSessionId);
      }
      await connectRealtime("voice", { sessionId: activeSessionId, accessToken: activeAccessToken });
    } catch {
      setStage("setup");
      setSetupPhase("error");
      setConnectionState("error");
      setNetworkAudioState("error");
      setRemoteAudioState("waiting");
      setErrorMessage("自然音声の回線を確認できなかったため、録画式のオンライン一次面接へ自動で切り替えます。カメラとマイクは確認済みです。");
      continueWithRecordedInterview = Boolean(
        streamRef.current &&
        sessionIdRef.current &&
        sessionIdRef.current !== "TD-PENDING" &&
        accessTokenRef.current,
      );
    } finally {
      setSessionStarting(false);
    }
    if (continueWithRecordedInterview) {
      await startRecordedFallback({ continueCurrentAttempt: true });
    }
  }

  function speakRecordedQuestion(text: string) {
    return new Promise<void>((resolve) => {
      if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
        resolve();
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ja-JP";
      utterance.rate = 0.92;
      utterance.pitch = 1;
      const voices = window.speechSynthesis.getVoices();
      utterance.voice = voices.find((voice) => voice.lang.toLowerCase().startsWith("ja")) ?? null;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      window.setTimeout(finish, Math.min(24_000, Math.max(6_000, text.length * 180)));
      window.speechSynthesis.speak(utterance);
    });
  }

  function armRecordedAnswerButton() {
    if (!recordedFallbackActiveRef.current) return;
    if (recordedQuestionTimerRef.current) window.clearTimeout(recordedQuestionTimerRef.current);
    setRecordedQuestionReady(false);
    recordedQuestionTimerRef.current = window.setTimeout(() => {
      recordedQuestionTimerRef.current = null;
      setRecordedQuestionReady(true);
      setConnectionState("candidate-speaking");
    }, 2_800);
  }

  async function startRecordedFallback(options: { continueCurrentAttempt?: boolean } = {}) {
    const activeStream = streamRef.current;
    const activeSessionId = sessionIdRef.current;
    const activeAccessToken = accessTokenRef.current;
    if (
      !activeStream ||
      !activeSessionId ||
      activeSessionId === "TD-PENDING" ||
      !activeAccessToken ||
      (sessionStarting && !options.continueCurrentAttempt)
    ) {
      setErrorMessage("面接記録の準備情報を確認できません。入力画面からもう一度開始してください。");
      return;
    }
    setSessionStarting(true);
    setErrorMessage("");
    primeRemoteAudioPlayback();
    try {
      const response = await fetch("/api/interviews/recorded/start", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${activeAccessToken}`,
          "X-Interview-Session": activeSessionId,
        },
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || "録画式のオンライン一次面接を開始できませんでした。");
      }
      stopRealtime({ keepLocalStream: true });
      recordedFallbackActiveRef.current = true;
      stopMicrophoneMeter();
      const firstQuestion = `TOKYO DOGSのオンライン一次面接です。オンライン採用担当者の茂木です。音声回線の予備方式で、画面の質問に声で回答し、話し終えたら次の質問へ進んでください。${RECORDED_FALLBACK_QUESTIONS[0]}`;
      const firstTurn: TranscriptTurn = {
        id: "recorded-fallback-question-1",
        speaker: "interviewer",
        text: firstQuestion,
        createdAt: new Date().toISOString(),
      };
      setMode("recorded-fallback");
      setRecordedQuestionIndex(0);
      setElapsed(0);
      setProcessingWarning("");
      transcriptRef.current = [firstTurn];
      setTranscript([firstTurn]);
      recordedInterviewSessionRef.current = activeSessionId;
      setConnectionState("ai-speaking");
      setConnectionStep("ready");
      setNetworkAudioState("idle");
      setRemoteAudioState("idle");
      setCandidateAudioState("ready");
      setStage("interview");
      await startRecording(activeStream, displayStreamRef.current, null, { resume: false });
      void speakRecordedQuestion(firstQuestion).then(armRecordedAnswerButton);
    } catch (error) {
      setSetupPhase("error");
      setErrorMessage(error instanceof Error ? error.message : "録画式のオンライン一次面接を開始できませんでした。");
    } finally {
      setSessionStarting(false);
    }
  }

  async function advanceRecordedFallback() {
    if (mode !== "recorded-fallback" || !recordedQuestionReady || endingRef.current) return;
    setRecordedQuestionReady(false);
    const answerNumber = recordedQuestionIndex + 1;
    upsertTurn({
      id: `recorded-fallback-answer-${answerNumber}`,
      speaker: "candidate",
      text: `回答${answerNumber}の発言内容は録画音声に記録されています。自動文字起こしではないため、採用担当者が録画を確認します。`,
      createdAt: new Date().toISOString(),
    });
    const nextIndex = recordedQuestionIndex + 1;
    if (nextIndex >= RECORDED_FALLBACK_QUESTIONS.length) {
      const closing = "オンライン一次面接は以上です。回答と録画は採用選考の重要な判断資料として、採用担当者の笠間と山本が確認します。ご回答ありがとうございました。";
      upsertTurn({
        id: "recorded-fallback-closing",
        speaker: "interviewer",
        text: closing,
        createdAt: new Date().toISOString(),
      });
      setConnectionState("ai-speaking");
      await speakRecordedQuestion(closing);
      await completeInterview("recorded_fallback_completed");
      return;
    }
    const nextQuestion = RECORDED_FALLBACK_QUESTIONS[nextIndex];
    setRecordedQuestionIndex(nextIndex);
    setConnectionState("ai-speaking");
    upsertTurn({
      id: `recorded-fallback-question-${nextIndex + 1}`,
      speaker: "interviewer",
      text: nextQuestion,
      createdAt: new Date().toISOString(),
    });
    void speakRecordedQuestion(nextQuestion).then(armRecordedAnswerButton);
  }

  async function prepareInterview() {
    if (!consent || sessionStarting) return;
    if (!candidateName.trim()) {
      setErrorMessage("氏名を入力してください。");
      return;
    }
    const preferredLocation = normalizePreferredLocation(location);
    if (!preferredLocation || preferredLocation.length > PREFERRED_LOCATION_MAX_LENGTH) {
      setErrorMessage("入職希望対象店舗を120文字以内で入力してください。");
      return;
    }
    // Stop here — before the camera/microphone prompt and before audible playback —
    // before the candidate is moved off this screen — when this browser has no usable
    // signed invite. Re-checked at click time (not just on mount) so a gate that is
    // still resolving cannot let a plain top-level visit through. The silent playback
    // prime runs inside the candidate's button gesture so iOS will allow the remote
    // interviewer stream after this asynchronous pre-flight finishes.
    primeRemoteAudioPlayback();
    setSessionStarting(true);
    const access = inviteGate === "ok" ? "ok" : await checkInterviewAccess();
    setInviteGate(access);
    setSessionStarting(false);
    if (access !== "ok") {
      setErrorMessage(INTERVIEW_ACCESS_MESSAGES[access]);
      return;
    }
    setLocation(preferredLocation);
    setStage("setup");
    setSetupPhase("requesting");
    setSessionStarting(true);
    setErrorMessage("");
    setAudioNotice("");
    setConnectionStep("permissions");
    setScreenCaptureState("idle");
    setMicrophoneLevel(0);
    setRecordingCaptureState("idle");
    updateRecordingAudioCoverage(null);
    setCandidateAudioState("checking");
    setRemoteAudioState("waiting");
    setNetworkAudioState("idle");
    void playPreparedAudio("/audio/motegi-device-permission.mp3", {
      updateSpeakerTest: true,
      keepAudioPrimed: true,
    });
    let nextStream: MediaStream | null = null;
    try {
      if (!window.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== "function") {
        throw new Error("TD-CONN-MEDIA: この画面ではカメラ・マイク機能を利用できません。端末の標準ブラウザで開いてください。");
      }
      try {
        if (!recordingAudioContextRef.current || recordingAudioContextRef.current.state === "closed") {
          recordingAudioContextRef.current = new AudioContext();
        }
        if (recordingAudioContextRef.current.state !== "running") {
          void recordingAudioContextRef.current.resume().catch(() => undefined);
        }
      } catch {
        // Camera preview remains available when Web Audio is unavailable.
      }
      nextStream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 540 } },
      });
      const microphoneTrack = nextStream.getAudioTracks()[0];
      const cameraTrack = nextStream.getVideoTracks()[0];
      if (!microphoneTrack || !cameraTrack) throw new Error("TD-CONN-MEDIA: カメラまたはマイクを確認できませんでした。端末の設定をご確認ください。");
      streamRef.current = nextStream;
      setStream(nextStream);
      setCandidateAudioState(microphoneTrack.muted ? "checking" : "ready");
      setSetupPhase("devices-ready");
      await startMicrophoneMeter(nextStream);
      void playPreparedAudio("/audio/motegi-devices-ready.mp3", {
        updateSpeakerTest: true,
        keepAudioPrimed: true,
      });
      microphoneTrack.addEventListener("mute", () => {
        if (!endingRef.current) {
          setCandidateAudioState("error");
          setAudioNotice("マイク入力が一時停止しています。ほかの通話アプリを閉じ、マイクの許可をご確認ください。");
        }
      });
      microphoneTrack.addEventListener("unmute", () => {
        setCandidateAudioState("ready");
        setAudioNotice("");
      });
      microphoneTrack.addEventListener("ended", () => {
        if (!endingRef.current) {
          stopMicrophoneMeter();
          setCandidateAudioState("error");
          setSetupPhase("error");
          setErrorMessage("TD-CONN-MIC: マイク接続が終了しました。端末の設定を確認し、最初からやり直してください。");
        }
      });
    } catch (error) {
      nextStream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStream(null);
      setStage("intro");
      setSetupPhase("error");
      setCandidateAudioState("error");
      setErrorMessage(deviceErrorMessage(error));
      setSessionStarting(false);
      return;
    }
    setSessionStarting(false);
    await connectPreparedInterview();
  }

  function startInternalTest() {
    stopRealtime();
    const id = `TD-TEST-${Date.now().toString(36).toUpperCase()}`;
    sessionIdRef.current = id;
    const firstTurn: TranscriptTurn = {
      id: "internal-test-question-1",
      speaker: "interviewer",
      text: `この接続確認は選考対象外です。外部サービスには接続せず、入力内容も採用評価には使用しません。${INTERNAL_TEST_QUESTIONS[0]}`,
      createdAt: new Date().toISOString(),
    };
    setSessionId(id);
    setMode("internal-test");
    setElapsed(0);
    setErrorMessage("");
    setProcessingWarning("");
    transcriptRef.current = [firstTurn];
    setTranscript([firstTurn]);
    setConnectionState("ready");
    setConnectionStep("ready");
    setStage("interview");
  }

  function stopRealtime(options: { keepLocalStream?: boolean; keepRecorder?: boolean } = {}) {
    clearResponseWatchdog();
    clearCandidateResponseDelay();
    turnStateRef.current = { ...turnStateRef.current, awaitingResponse: false, candidateTurnPending: false };
    if (channelOpenTimerRef.current) window.clearTimeout(channelOpenTimerRef.current);
    channelOpenTimerRef.current = null;
    if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
    pendingCompletionTimerRef.current = null;
    pendingCompletionReasonRef.current = null;
    if (statsTimerRef.current) window.clearInterval(statsTimerRef.current);
    statsTimerRef.current = null;
    playbackRetryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    playbackRetryTimersRef.current = [];
    if (recordedQuestionTimerRef.current) window.clearTimeout(recordedQuestionTimerRef.current);
    recordedQuestionTimerRef.current = null;
    recordedFallbackActiveRef.current = false;
    window.speechSynthesis?.cancel();
    disconnectRemoteSpeaker();
    stopAudioPrime();
    const activeChannel = channelRef.current;
    channelRef.current = null;
    activeChannel?.close();
    if (!options.keepLocalStream) {
      peerRef.current?.getSenders().forEach((sender) => sender.track?.stop());
    }
    peerRef.current?.close();
    peerRef.current = null;
    if (disconnectTimerRef.current) window.clearTimeout(disconnectTimerRef.current);
    disconnectTimerRef.current = null;
    const activeRecorder = recorderRef.current;
    if (!options.keepRecorder && activeRecorder && activeRecorder.state !== "inactive") {
      try {
        activeRecorder.requestData();
      } catch {
        // The recorder can already be stopping.
      }
      try {
        activeRecorder.stop();
      } catch {
        recordingResolveRef.current?.(null);
        recordingResolveRef.current = null;
        cleanupRecordingAudioMix();
      }
      if (!endingRef.current) setRecordingCaptureState("error");
    } else if (!options.keepRecorder) {
      cleanupRecordingAudioMix();
    }
    if (!options.keepLocalStream) {
      stopMicrophoneMeter();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
    displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = null;
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }
    displayStreamRef.current = null;
  }

  async function requestEvaluation() {
    setProcessingWarning("");
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessTokenRef.current}`,
      },
      body: JSON.stringify({
        sessionId,
        employment,
        location: normalizePreferredLocation(location),
        transcript: transcriptRef.current,
      }),
    });
    const data = (await response.json()) as {
      stored?: boolean;
      error?: string;
    };
    if (!response.ok || !data.stored) {
      throw new Error(data.error || "評価を完了できませんでした。");
    }
  }

  async function completeRecordedFallback() {
    const response = await fetch("/api/interviews/recorded/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessTokenRef.current}`,
      },
      body: JSON.stringify({
        sessionId,
        questionCount: RECORDED_FALLBACK_QUESTIONS.length,
      }),
    });
    const data = (await response.json().catch(() => null)) as { stored?: boolean; error?: string } | null;
    if (!response.ok || !data?.stored) {
      throw new Error(data?.error || "録画式面接の受付を完了できませんでした。");
    }
  }

  async function uploadRecording(blob: Blob) {
    setRecordingUploadState("uploading");
    const response = await fetch("/api/interviews/recording", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessTokenRef.current}`,
        "X-Interview-Session": sessionId,
        "X-Interview-Audio-Coverage": recordingHasBothAudioRef.current === true
          ? "both"
          : recordingHasBothAudioRef.current === false
            ? "candidate-only"
            : "unverified",
        "Content-Type": blob.type.split(";")[0] || "video/webm",
      },
      body: blob,
    });
    const data = (await response.json()) as { stored?: boolean; error?: string };
    if (!response.ok || !data.stored) {
      throw new Error(data.error || "録画を保存できませんでした。");
    }
    setRecordingUploadState("stored");
  }

  function runPendingCompletion() {
    const reason = pendingCompletionReasonRef.current;
    if (!reason) return;
    if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
    pendingCompletionTimerRef.current = null;
    pendingCompletionReasonRef.current = null;
    void completeInterview(reason);
  }

  function scheduleInterviewCompletion(reason: string) {
    if (endingRef.current || pendingCompletionReasonRef.current) return;
    pendingCompletionReasonRef.current = reason;
    pendingCompletionTimerRef.current = window.setTimeout(runPendingCompletion, 8_000);
  }

  async function completeInterview(reason: string) {
    if (endingRef.current) return;
    if (mode === "internal-test") {
      upsertTurn({
        id: `internal-test-complete-${Date.now()}`,
        speaker: "interviewer",
        text: "接続確認は以上です。この内容は選考や採用評価には使用しません。",
        createdAt: new Date().toISOString(),
      });
      setConnectionState("idle");
      setStage("review");
      void reason;
      return;
    }
    if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
    pendingCompletionTimerRef.current = null;
    pendingCompletionReasonRef.current = null;
    endingRef.current = true;
    setStage("evaluating");
    setConnectionState("idle");
    stopRealtime();
    // MediaRecorder.stop() finalizes its container asynchronously. Do not race it
    // against a short timer: a large iPhone MP4 can legitimately need more than six
    // seconds, and discarding that late blob permanently loses an otherwise valid
    // interview recording.
    const recordingBlob = await (
      recordingPromiseRef.current ?? Promise.resolve(recordingBlobRef.current)
    );
    if (!recordingBlob) reportCandidateEvent("recording_unavailable", "NO_RECORDING_AT_COMPLETION");
    if (recordingBlob && recordingHasBothAudioRef.current !== true) {
      reportCandidateEvent("recording_unavailable", "REMOTE_AUDIO_UNVERIFIED");
    }
    const recordingUpload = recordingBlob
      ? uploadRecording(recordingBlob).catch((error) => {
        setRecordingUploadState("error");
        reportCandidateEvent("recording_unavailable", "UPLOAD_FAILED");
        void error;
      })
      : Promise.resolve();

    try {
      if (transcriptRef.current.length === 0) {
        throw new Error("評価に必要な回答記録がありません。オンライン一次面接を最初からお試しください。");
      }
      if (mode === "recorded-fallback") {
        await completeRecordedFallback();
        setProcessingWarning("回答本文の自動文字起こしと自動評価は行わず、採用担当者が録画を確認します。");
      } else {
        await requestEvaluation();
      }
    } catch (error) {
      setProcessingWarning("回答記録の自動整理を完了できませんでした。採用担当者が記録状態を確認します。");
      void error;
    } finally {
      await recordingUpload;
      setStage("review");
      endingRef.current = false;
      void reason;
    }
  }

  function handleRealtimeEvent(event: RealtimeEvent) {
    const type = event.type ?? "";
    if (type === "input_audio_buffer.speech_started") {
      applyTurnTaking("candidate_speech_started");
      setConnectionState("candidate-speaking");
      setCandidateAudioState("detected");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      const { state } = applyTurnTaking("candidate_speech_stopped");
      setCandidateAudioState("ready");
      // When a response was still in flight the next question is scheduled by
      // response.done instead, so the candidate is never left waiting silently.
      if (state.candidateTurnPending) setConnectionState("ai-speaking");
      return;
    }
    if (type === "response.created") {
      currentAssistantAudioItemRef.current = "";
      assistantAudioStartedAtRef.current = null;
      applyTurnTaking("response_created");
      setConnectionState(isCandidateSpeaking() ? "candidate-speaking" : "ai-speaking");
      setNetworkAudioState("connected");
      return;
    }
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      if (event.item_id && !currentAssistantAudioItemRef.current) {
        currentAssistantAudioItemRef.current = event.item_id;
      }
      if (assistantAudioStartedAtRef.current === null) assistantAudioStartedAtRef.current = Date.now();
      if (!isCandidateSpeaking()) void resumeRemoteAudio(false);
      return;
    }
    if (type === "response.done") {
      const completionPending = Boolean(pendingCompletionReasonRef.current);
      const { scheduledNextQuestion } = applyTurnTaking("response_done", {
        suppressNextQuestion: completionPending,
      });
      if (completionPending) {
        if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
        pendingCompletionTimerRef.current = window.setTimeout(runPendingCompletion, 1_200);
        return;
      }
      if (!scheduledNextQuestion) {
        setConnectionState(isCandidateSpeaking() ? "candidate-speaking" : "ready");
      }
      setNetworkAudioState("connected");
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const text = event.transcript?.trim();
      if (text) {
        upsertTurn({
          id: event.item_id || event.event_id || `candidate-${Date.now()}`,
          speaker: "candidate",
          text,
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      setCandidateAudioState("ready");
      reportCandidateEvent("transcription_failed", "TRANSCRIPTION_FAILED");
      setAudioNotice("回答音声の文字起こしを一部確認できませんでした。内容が画面に表示されない場合は、下の入力欄から補足できます。");
      return;
    }

    const isAssistantDelta =
      type === "response.output_audio_transcript.delta" ||
      type === "response.audio_transcript.delta" ||
      type === "response.output_text.delta";
    const isAssistantDone =
      type === "response.output_audio_transcript.done" ||
      type === "response.audio_transcript.done" ||
      type === "response.output_text.done";
    if (isAssistantDelta || isAssistantDone) {
      // A barge-in (input_audio_buffer.speech_started) already cancelled the response.
      // Late-arriving deltas/done events for that cancelled response must not re-arm
      // the watchdog while the candidate is still answering.
      applyTurnTaking("assistant_output");
      if (event.item_id && !currentAssistantAudioItemRef.current) {
        currentAssistantAudioItemRef.current = event.item_id;
      }
      if (assistantAudioStartedAtRef.current === null) assistantAudioStartedAtRef.current = Date.now();
      const id = `${event.response_id || "response"}-${event.output_index || 0}-${event.content_index || 0}`;
      const current = assistantPartialsRef.current.get(id) ?? "";
      const text = isAssistantDone
        ? (event.transcript || current).trim()
        : `${current}${event.delta || ""}`;
      assistantPartialsRef.current.set(id, text);
      if (text) {
        upsertTurn({ id, speaker: "interviewer", text, createdAt: new Date().toISOString() });
      }
      return;
    }

    if (isCompleteInterviewEvent(event)) {
      const callId = event.call_id || event.item?.call_id;
      if (!callId || processedCompletionCallsRef.current.has(callId)) return;
      processedCompletionCallsRef.current.add(callId);
      const completion = validateCompletionArguments(parseCompletionArguments(event));
      if (callId && channelRef.current?.readyState === "open") {
        channelRef.current.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({
              accepted: completion.accepted,
              missing_topic_ids: completion.missingTopicIds,
            }),
          },
        }));
      }
      if (!completion.accepted) {
        channelRef.current?.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions: `オンライン一次面接はまだ完了できません。未確認テーマは${completion.missingTopicIds.join("、") || "T01〜T15"}です。終了案内はせず、既に得た回答を踏まえて、未確認テーマから一つだけ自然に質問してください。`,
          },
        }));
        armResponseWatchdog(true);
        return;
      }
      scheduleInterviewCompletion("ai_completed");
      return;
    }
    if (type === "error") {
      // A barge-in cancel races with the response finishing on the server: the
      // response.cancel then arrives with nothing left to cancel and the server
      // answers with an error. That is a normal end of the interviewer's turn, not
      // a broken interview, so it must not drop the candidate into the error
      // screen. The channel is still open here, and the turn continues.
      const cancelEventId = event.error?.event_id;
      const cancelRace = isExpectedResponseCancelError(
        cancelEventId,
        pendingCancelEventsRef.current,
        Date.now(),
        CANCEL_RACE_GRACE_MS,
      );
      if (cancelRace && channelRef.current?.readyState === "open" && !pendingCompletionReasonRef.current) {
        if (cancelEventId) pendingCancelEventsRef.current.delete(cancelEventId);
        applyTurnTaking("response_cancel_rejected");
        setNetworkAudioState("connected");
        return;
      }
      applyTurnTaking("response_failed");
      if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
      pendingCompletionTimerRef.current = null;
      pendingCompletionReasonRef.current = null;
      setConnectionState("error");
      setNetworkAudioState("error");
      setErrorMessage(event.error?.message || "オンライン一次面接で接続エラーが発生しました。再接続してください。");
    }
  }

  async function connectRealtime(
    selectedMode: InterviewMode,
    credentials?: { sessionId: string; accessToken: string },
  ) {
    const activeSessionId = credentials?.sessionId ?? sessionId;
    // Reconnecting to the same interview session must not discard the transcript and
    // recording already captured before the disconnect (TD-CONN-* recovery paths reuse
    // the same session id). Only a genuinely new session starts from a blank record.
    const isNewInterviewSession = isNewInterviewRecord(recordedInterviewSessionRef.current, activeSessionId);
    setMode(selectedMode);
    setErrorMessage("");
    setAudioNotice("");
    setConnectionState("connecting");
    setNetworkAudioState("connecting");
    setRemoteAudioState(selectedMode === "voice" ? "waiting" : "idle");
    setConnectionStep("voice");
    setStage("interview");
    if (isNewInterviewSession) {
      setElapsed(0);
      transcriptRef.current = [];
      setTranscript([]);
      recordedInterviewSessionRef.current = activeSessionId;
    }
    assistantPartialsRef.current.clear();
    processedCompletionCallsRef.current.clear();
    turnStateRef.current = initialTurnTakingState();
    pendingCancelEventsRef.current.clear();
    clearCandidateResponseDelay();
    endingRef.current = false;

    try {
      const activeAccessToken = credentials?.accessToken ?? accessTokenRef.current;
      if (!activeSessionId || activeSessionId === "TD-PENDING" || !activeAccessToken) {
        throw new Error("TD-CONN-SESSION: オンライン一次面接の接続情報が整っていません。最初から接続をやり直してください。");
      }
      let activeStream = streamRef.current;
      if (selectedMode === "voice" && !activeStream) {
        activeStream = await navigator.mediaDevices.getUserMedia({
          audio: AUDIO_CONSTRAINTS,
          video: { facingMode: "user" },
        });
        streamRef.current = activeStream;
        setStream(activeStream);
      }

      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      const failActiveConnection = (message: string) => {
        if (endingRef.current || peerRef.current !== peer) return;
        reportCandidateEvent("connection_failed", message.split(":")[0]);
        // Preserve the single recording container while the candidate reconnects.
        // Camera and local audio continue; the replacement remote track is mixed
        // back in after the next WebRTC connection succeeds.
        stopRealtime({ keepLocalStream: true, keepRecorder: true });
        if (streamRef.current) void startMicrophoneMeter(streamRef.current);
        setStage("setup");
        setSetupPhase("error");
        setConnectionState("error");
        setNetworkAudioState("error");
        setCandidateAudioState(streamRef.current ? "ready" : "error");
        setRemoteAudioState("waiting");
        setAudioNotice("");
        setErrorMessage(message);
      };
      peer.onconnectionstatechange = () => {
        if (peerRef.current !== peer) return;
        if (peer.connectionState === "connected") {
          if (disconnectTimerRef.current) window.clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
          setNetworkAudioState("connected");
          setAudioNotice("");
          monitorAudioStats(peer);
          return;
        }
        if (peer.connectionState === "failed") {
          failActiveConnection("TD-CONN-NETWORK: 音声接続が切れました。通信環境を確認して再度お試しください。");
          return;
        }
        if (peer.connectionState === "disconnected" && !disconnectTimerRef.current) {
          setNetworkAudioState("reconnecting");
          setAudioNotice("通信が一時的に不安定です。自動で再接続しています。");
          disconnectTimerRef.current = window.setTimeout(() => {
            if (peer.connectionState === "disconnected") {
              failActiveConnection("TD-CONN-NETWORK: 音声接続を復旧できませんでした。通信環境を確認して再度お試しください。");
            }
            disconnectTimerRef.current = null;
          }, 8_000);
        }
      };
      peer.ontrack = (event) => {
        if (event.track.kind !== "audio") return;
        const incomingStream = event.streams[0] ?? new MediaStream([event.track]);
        stopAudioPrime();
        remoteStreamRef.current = incomingStream;
        setRemoteAudioState("waiting");
        event.track.addEventListener("mute", () => {
          if (!endingRef.current && peerRef.current === peer) setRemoteAudioState("waiting");
        });
        event.track.addEventListener("unmute", () => queueRemoteAudioRecovery());
        event.track.addEventListener("ended", () => {
          if (!endingRef.current && peerRef.current === peer) {
            setRemoteAudioState("error");
            setConnectionState("error");
            setErrorMessage("TD-CONN-AUDIO: 茂木の音声受信が終了しました。接続をやり直してください。");
          }
        });
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = incomingStream;
        queueRemoteAudioRecovery();
        attachRemoteAudioToRecording(incomingStream);
      };
      peer.onicecandidateerror = () => {
        if (peerRef.current === peer && peer.connectionState !== "connected") {
          setNetworkAudioState("reconnecting");
          setAudioNotice("音声回線を別の経路で接続しています。少しお待ちください。");
        }
      };

      const audioTracks = activeStream?.getAudioTracks() ?? [];
      if (selectedMode === "voice" && audioTracks.length > 0 && activeStream) {
        audioTracks.forEach((track) => peer.addTrack(track, activeStream as MediaStream));
      } else {
        peer.addTransceiver("audio", { direction: "recvonly" });
      }

      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.onmessage = (message) => {
        try {
          handleRealtimeEvent(JSON.parse(message.data) as RealtimeEvent);
        } catch {
          // Ignore malformed non-critical events and keep the interview connected.
        }
      };
      channel.onerror = () => {
        if (endingRef.current || channelRef.current !== channel) return;
        failActiveConnection("TD-CONN-DATA: 質問と回答の接続でエラーが発生しました。接続をやり直してください。");
      };
      channel.onclose = () => {
        if (endingRef.current || channelRef.current !== channel) return;
        clearResponseWatchdog();
        failActiveConnection("TD-CONN-DATA: 質問と回答の接続が終了しました。接続をやり直してください。");
      };
      channel.onopen = () => {
        if (channelOpenTimerRef.current) window.clearTimeout(channelOpenTimerRef.current);
        channelOpenTimerRef.current = null;
        stopMicrophoneMeter();
        setConnectionState("ready");
        setConnectionStep("ready");
        setNetworkAudioState("connected");
        channel.send(JSON.stringify({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            instructions: "「TOKYO DOGSのオンライン一次面接です。オンライン採用担当者の茂木です。この面接は音声システムで進行します」と音声で開始してください。自分の名前には敬称を付けず、茂木または私と表現してください。15〜25分の面接であることと、回答が採用選考の重要な判断資料になることを短く説明し、話しやすい自己紹介から一問だけ質問してください。実在する人間がライブで参加しているとは説明しないでください。",
          },
        }));
        if (remoteStreamRef.current) queueRemoteAudioRecovery();
        armResponseWatchdog(true);
      };
      channelOpenTimerRef.current = window.setTimeout(() => {
        if (channel.readyState !== "open") {
          failActiveConnection("TD-CONN-CHANNEL: 音声と質問の接続を開始できませんでした。通信環境を確認し、接続をやり直してください。");
        }
      }, 28_000);

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const callController = new AbortController();
      const callTimeout = window.setTimeout(() => callController.abort(), 18_000);
      let sdpResponse: Response;
      try {
        sdpResponse = await fetch("/api/realtime/call", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${activeAccessToken}`,
            "Content-Type": "application/sdp",
            "X-Interview-Session": activeSessionId,
          },
          body: peer.localDescription?.sdp ?? offer.sdp ?? "",
          signal: callController.signal,
        });
      } finally {
        window.clearTimeout(callTimeout);
      }
      if (!sdpResponse.ok) {
        const detail = (await sdpResponse.text()).trim();
        throw new Error(detail.startsWith("TD-CONN-") && detail.length <= 300
          ? detail
          : "TD-CONN-VOICE: 音声通話を開始できませんでした。Wi-Fiと4G/5Gを切り替えて、最初からお試しください。");
      }
      await peer.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
      if (selectedMode === "voice" && activeStream) {
        await startRecording(activeStream, displayStreamRef.current, remoteStreamRef.current, {
          resume: !isNewInterviewSession,
        });
      }
    } catch (error) {
      stopRealtime({ keepLocalStream: true });
      if (streamRef.current) void startMicrophoneMeter(streamRef.current);
      setStage("setup");
      setSetupPhase("error");
      setConnectionState("error");
      setNetworkAudioState("error");
      setCandidateAudioState(streamRef.current ? "ready" : "error");
      setRemoteAudioState("waiting");
      setErrorMessage(error instanceof DOMException && error.name === "AbortError"
        ? "TD-CONN-TIMEOUT: 音声回線への接続がタイムアウトしました。通信環境を確認して最初からお試しください。"
        : error instanceof Error ? error.message : "オンライン一次面接を開始できませんでした。");
    }
  }

  function sendTextAnswer() {
    const text = textDraft.trim();
    if (!text) return;
    const id = `text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    upsertTurn({ id, speaker: "candidate", text, createdAt: new Date().toISOString() });
    setTextDraft("");

    if (mode === "internal-test") {
      const answered = transcriptRef.current.filter((turn) => turn.speaker === "candidate").length;
      const nextQuestion = INTERNAL_TEST_QUESTIONS[answered];
      setConnectionState("ai-speaking");
      window.setTimeout(() => {
        if (nextQuestion) {
          upsertTurn({
            id: `internal-test-question-${answered + 1}`,
            speaker: "interviewer",
            text: nextQuestion,
            createdAt: new Date().toISOString(),
          });
          setConnectionState("ready");
        } else {
          void completeInterview("internal_test_completed");
        }
      }, 450);
      return;
    }

    const channel = channelRef.current;
    if (!channel || channel.readyState !== "open") {
      setConnectionState("error");
      setNetworkAudioState("error");
      setErrorMessage("TD-CONN-DATA: 回答を送信できませんでした。接続をやり直してください。");
      return;
    }
    channel.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        id,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }));
    channel.send(JSON.stringify({ type: "response.create" }));
    armResponseWatchdog(true);
    setConnectionState("ai-speaking");
  }

  function toggleMute() {
    const next = !isMuted;
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setIsMuted(next);
    setCandidateAudioState(next ? "muted" : "ready");
    if (!next) setAudioNotice("");
  }

  function resetInterview() {
    stopRealtime();
    setSessionId("TD-PENDING");
    sessionIdRef.current = "TD-PENDING";
    accessTokenRef.current = "";
    setStage("intro");
    setConsent(false);
    setConnectionState("idle");
    setConnectionStep("idle");
    setElapsed(0);
    transcriptRef.current = [];
    setTranscript([]);
    processedCompletionCallsRef.current.clear();
    reportedCandidateEventsRef.current.clear();
    turnStateRef.current = initialTurnTakingState();
    pendingCancelEventsRef.current.clear();
    recordedInterviewSessionRef.current = null;
    setProcessingWarning("");
    setErrorMessage("");
    recordingBlobRef.current = null;
    recordingPromiseRef.current = null;
    recordingResolveRef.current = null;
    recordingBytesRef.current = 0;
    recordingSizeCappedRef.current = false;
    setRecordingUploadState("idle");
    setRecordingCaptureState("idle");
    updateRecordingAudioCoverage(null);
    setScreenCaptureState("idle");
    setSetupPhase("idle");
    setMicrophoneLevel(0);
    setCandidateAudioState("idle");
    setRemoteAudioState("idle");
    setNetworkAudioState("idle");
    setAudioNotice("");
    setIsMuted(false);
  }

  function restartConnection() {
    stopRealtime();
    accessTokenRef.current = "";
    setSessionId("TD-PENDING");
    sessionIdRef.current = "TD-PENDING";
    setConnectionState("idle");
    setConnectionStep("idle");
    setElapsed(0);
    transcriptRef.current = [];
    setTranscript([]);
    processedCompletionCallsRef.current.clear();
    turnStateRef.current = initialTurnTakingState();
    pendingCancelEventsRef.current.clear();
    // A restart issues a brand new interview id, so the next connection must not
    // resume the abandoned transcript and recording chunks.
    recordedInterviewSessionRef.current = null;
    chunksRef.current = [];
    recordingBytesRef.current = 0;
    recordingSizeCappedRef.current = false;
    recordingBlobRef.current = null;
    recordingPromiseRef.current = null;
    recordingResolveRef.current = null;
    setTextDraft("");
    setRecordingUploadState("idle");
    setRecordingCaptureState("idle");
    setScreenCaptureState("idle");
    setSetupPhase("idle");
    setMicrophoneLevel(0);
    setCandidateAudioState("idle");
    setRemoteAudioState("idle");
    setNetworkAudioState("idle");
    setAudioNotice("");
    setRecordedQuestionIndex(0);
    setRecordedQuestionReady(false);
    setStage("intro");
    setErrorMessage("接続をやり直します。同意はそのままです。開始ボタンを押し、表示される許可画面をご確認ください。");
  }

  const connectionCopy = {
    idle: "待機中",
    connecting: "オンライン一次面接へ接続中",
    ready: mode === "voice" ? "質問が終わったら、そのままお話しください" : mode === "recorded-fallback" ? "回答後、「回答を終えて次の質問へ」を押してください" : "回答を入力してください",
    "candidate-speaking": mode === "recorded-fallback" ? "回答を録画音声に記録中" : "お話を聞いています",
    "waiting-pause": "回答の続きがないか、少し待っています",
    "ai-speaking": "茂木が話しています",
    error: "接続を確認してください",
  }[connectionState];
  const connectionStepCopy = {
    idle: "",
    permissions: "1/3 カメラ・マイクの許可を確認中",
    session: "2/3 面接記録の準備中",
    voice: "3/3 安全な音声回線へ接続中",
    ready: "接続完了",
  }[connectionStep];
  const candidateAudioCopy = {
    idle: "待機中",
    checking: "確認中",
    ready: "送信中",
    detected: "音声を認識中",
    muted: "ミュート中",
    error: "要確認",
  }[candidateAudioState];
  const remoteAudioCopy = {
    idle: "待機中",
    waiting: "受信待ち",
    receiving: "受信・再生中",
    playing: "再生中",
    blocked: "再生操作が必要",
    error: "要確認",
  }[remoteAudioState];
  const networkAudioCopy = {
    idle: "待機中",
    connecting: "接続中",
    connected: "接続済み",
    reconnecting: "再接続中",
    error: "要確認",
  }[networkAudioState];
  const recordingCaptureCopy = recordingCaptureState === "recording"
    ? mode === "recorded-fallback"
      ? "カメラ映像とあなたの音声を録画中です。質問文は画面の記録にも保存します。"
      : recordingHasBothAudio === false
      ? "カメラ・応募者音声を録画中です。茂木の録音状態は採用担当者が確認します。"
      : screenCaptureState === "ready"
      ? "面接画面・カメラ・双方の音声を録画中です。"
      : screenCaptureState === "ended"
        ? "画面共有は終了しました。カメラ・双方の音声録画を継続しています。"
        : screenCaptureState === "unavailable"
          ? "画面共有を使わず、カメラ・双方の音声を録画中です。"
          : "カメラ・双方の音声を録画中です。"
    : recordingCaptureState === "starting"
      ? "録画の開始を確認しています。"
      : recordingCaptureState === "error"
        ? "録画開始を確認できません。採用担当者が記録状態を確認します。"
        : "録画の準備中です。";

  return (
    <main className="site-shell">
      <audio
        className="prepared-audio-player"
        data-testid="prepared-audio-player"
        ref={preparedAudioRef}
        tabIndex={-1}
        playsInline
        preload="auto"
        aria-label="オンライン一次面接の接続案内音声"
      />
      <audio
        className="remote-audio-player"
        data-testid="remote-audio-player"
        ref={remoteAudioRef}
        autoPlay
        controls
        tabIndex={-1}
        playsInline
        preload="auto"
        aria-label="オンライン採用担当者 茂木の音声"
        onCanPlay={() => void resumeRemoteAudio(false)}
        onPlaying={() => {
          if (remoteStreamRef.current) {
            setRemoteAudioState("playing");
            setAudioNotice("");
          }
        }}
        onPause={() => {
          const speakerGraphIsRunning = remotePlaybackGraphRef.current?.context.state === "running";
          if (remoteStreamRef.current && !endingRef.current && !speakerGraphIsRunning) {
            reportCandidateEvent("audio_playback_blocked", "HTML_AUDIO_PAUSED");
            setRemoteAudioState("blocked");
            setAudioNotice("担当者ガイド音声が停止しました。「茂木の音声を再開」を押してください。");
          }
        }}
        onWaiting={() => {
          if (remoteStreamRef.current && remotePlaybackGraphRef.current?.context.state !== "running") {
            setRemoteAudioState("receiving");
          }
        }}
        onStalled={() => {
          if (remoteStreamRef.current && remotePlaybackGraphRef.current?.context.state !== "running") {
            setRemoteAudioState("receiving");
            setAudioNotice("担当者ガイド音声を再受信しています。続かない場合は再生ボタンを押してください。");
          }
        }}
        onError={() => {
          if (!remotePlaybackGraphRef.current || remotePlaybackGraphRef.current.context.state !== "running") {
            setRemoteAudioState("error");
            setAudioNotice("茂木の音声を再生できません。「茂木の音声を再開」を押してください。");
          }
        }}
      />
      <header className="site-header">
        <button className="brand-button" onClick={() => stage === "intro" && window.scrollTo({ top: 0 })}>
          <img src="/tokyo-dogs-logo.jpg" alt="Tokyo Dogs" />
          <span><strong>TOKYO DOGS</strong><small>OFFICIAL SELECTION PORTAL</small></span>
        </button>
        <div className="header-meta">
          <span className="test-pill">オンライン一次面接</span>
          <span className="session-code">{sessionId}</span>
        </div>
      </header>

      {stage === "intro" && (
        <section className="intro-layout">
          <div className="intro-copy">
            <p className="eyebrow">共に歩む仲間達へ</p>
            <h1>あなたのことを、<br />あなたらしく話してください。</h1>
            <p className="lead">
              TOKYO DOGSの採用選考におけるオンライン一次面接です。これまでの経験、仕事選びの考え方、働き方の希望について、オンライン採用担当者の茂木が順番にお伺いします。
            </p>
            <div className="intro-interviewer">
              <img src="/interviewer-woman-medium-v2.png" alt="TOKYO DOGS オンライン採用担当者 茂木" />
              <div><span>ONLINE RECRUITER</span><strong>オンライン採用担当者 茂木</strong></div>
            </div>
            <div className="feature-row">
              <div><strong>15–25</strong><span>面接時間の目安</span></div>
              <div><strong>OFFICIAL</strong><span>TOKYO DOGS公式選考</span></div>
              <div><strong>REVIEW</strong><span>採用担当者が責任をもって確認</span></div>
            </div>
          </div>

            <div className="start-panel">
              <div className="panel-number">01</div>
              <div className="panel-title"><p>選考情報</p><h2>オンライン一次面接を開始</h2></div>
            <label htmlFor="candidate-name">氏名</label>
            <input id="candidate-name" className="candidate-name-input" type="text" value={candidateName} onChange={(event) => setCandidateName(event.target.value)} maxLength={60} autoComplete="name" required aria-required="true" placeholder="例：山田 花子" />
            <p className="field-help">採用記録の照合と保存管理に使用します。応募時の氏名を入力してください。</p>
            <span className="field-label" id="employment-label">雇用形態</span>
            <div className="segmented-control" role="group" aria-labelledby="employment-label">
              {EMPLOYMENT_OPTIONS.map((item) => (
                <button type="button" key={item} aria-pressed={employment === item} className={employment === item ? "active" : ""} onClick={() => setEmployment(item)}>{item}</button>
              ))}
            </div>
            <label htmlFor="location">入職希望対象店舗</label>
            <input id="location" className="candidate-name-input" type="text" value={location} onChange={(event) => setLocation(event.target.value)} maxLength={PREFERRED_LOCATION_MAX_LENGTH} autoComplete="off" required aria-required="true" aria-describedby="location-help" placeholder="例：越谷店、文京本駒込店（複数記入可）" />
            <p className="field-help" id="location-help">入職を希望する店舗を記入してください。複数ある場合や相談希望の場合も、そのまま記入できます。</p>
            <div className="role-line"><span>募集職種</span><strong>犬の幼稚園スタッフ<br />ドッグトレーナー候補</strong></div>
            <label className={`consent-line ${consent ? "checked" : ""}`} htmlFor="selection-consent">
              <input id="selection-consent" type="checkbox" checked={consent} aria-describedby="consent-summary consent-detail-summary" onChange={(event) => setConsent(event.target.checked)} />
              <span className="consent-copy">
                <strong>録画・文字起こし・選考利用に同意する</strong>
                <span id="consent-summary">面接の映像・双方の音声・回答内容を、採用選考と記録の照合に使用します。</span>
                <small>評価は笠間・山本だけが確認し、求職者には表示されません。</small>
              </span>
            </label>
            <details className="consent-details"><summary id="consent-detail-summary">録画とデータの詳しい取り扱い</summary><div><p><strong>利用目的</strong><br />入力した氏名は採用記録の照合と保存管理に使用します。録画はカメラ映像と双方の音声を含み、接客ロールプレイなどの職務関連行動、文字起こしの照合、通信トラブル時の記録確認に使用します。</p><p><strong>処理と閲覧</strong><br />音声と回答は外部の音声・文字処理サービスで処理されます。氏名、録画、文字起こし、評価補助は認証された笠間・山本が確認します。自動処理だけで合否を決定しません。</p><p><strong>保管</strong><br />氏名、録画、文字起こし、評価補助は自動削除せず、当社が手動で削除するまで保管します。削除や開示等のご相談は、応募時に利用した連絡経路で採用担当者へご連絡ください。</p><p><strong>公平性とご相談</strong><br />笑顔の有無、顔立ち・容姿、服装、背景、カメラ・音声品質、声質、障害・健康状態の推測は評価しません。技術不具合は不利益に扱わず、情報不足として採用担当者が確認します。機器操作や進行方法に配慮が必要な場合は、応募時に利用した連絡経路で採用担当者へご相談ください。面接中も中止できます。</p></div></details>
            <p className={`consent-status ${consent && candidateName.trim() && normalizePreferredLocation(location) ? "ready" : ""}`} role="status">
              {!candidateName.trim()
                ? "氏名を入力してください。"
                : !normalizePreferredLocation(location)
                  ? "入職希望対象店舗を入力してください。"
                  : consent
                    ? "✓ 氏名、入職希望対象店舗、同意が確認されました。面接を開始できます。"
                    : "上の同意欄を押してチェックしてください。"}
            </p>
            {embeddedBrowser && (
              <div className="embedded-browser-notice" role="status">
                <div><strong>SafariまたはChromeで開いてください</strong><span>LINE内の画面では、カメラや音声が止まることがあります。リンクをコピーし、端末の標準ブラウザで開いてください。</span></div>
                <button type="button" onClick={() => void copyPortalLink()}>{copiedPortalLink ? "コピーしました" : "リンクをコピー"}</button>
              </div>
            )}
            <div className={`speaker-test ${speakerTestState}`}>
              <div><strong>端末の音声を確認</strong><span>{speakerTestState === "playing" ? "音声を再生しています" : speakerTestState === "passed" ? "確認音声を再生しました" : speakerTestState === "error" ? "端末の音量設定をご確認ください" : "開始前に茂木の確認音声を聞けます"}</span></div>
              <button type="button" onClick={playSpeakerTest}>{speakerTestState === "idle" ? "音声を確認" : "もう一度聞く"}</button>
            </div>
            <ol className="connection-guide">
              <li><strong>1. 同意欄をチェック</strong><span>録画・文字起こし・選考利用の内容を確認して、同意欄を押します。</span></li>
              <li><strong>2. 開始ボタンを押す</strong><span>表示される確認画面で、カメラとマイクの「許可」を選びます。</span></li>
              <li><strong>3. 自動確認後に面接開始</strong><span>映像とマイク入力をこの画面で確認し、そのままオンライン一次面接へ接続します。</span></li>
            </ol>
            {inviteGate !== "checking" && inviteGate !== "ok" && (
              <div className="invite-required-notice" role="alert">
                <strong>{inviteGate === "missing" ? "専用リンクからお進みください" : "この専用リンクではお進みいただけません"}</strong>
                <span>{INTERVIEW_ACCESS_MESSAGES[inviteGate]}</span>
                <small>カメラ・マイクの許可は必要ありません。下の「接続確認（選考対象外）」は、この状態でもお使いいただけます。</small>
              </div>
            )}
            {errorMessage && <div className="inline-error" role="alert">{errorMessage}</div>}
            <button className="primary-action" aria-label="カメラ・マイクを確認して開始" disabled={inviteGate !== "ok" || !candidateName.trim() || !normalizePreferredLocation(location) || !consent || sessionStarting} onClick={() => void prepareInterview()}>
              {inviteGate === "checking" ? "専用リンクを確認中…" : sessionStarting ? "カメラ・マイクを確認中…" : "カメラ・マイクを確認して開始"} <span>→</span>
            </button>
            <button className="internal-test-button" onClick={startInternalTest}>接続確認（選考対象外）</button>
            <p className="internal-test-note">録画・音声接続・採用評価を行わず、文字入力で面接画面の操作を確認します。</p>
            <p className="fine-print">推奨ブラウザは最新版のSafariまたはChromeです。氏名と採用選考に必要な回答以外の個人情報は入力しないでください。</p>
          </div>
        </section>
      )}

      {stage === "setup" && (
        <section className="setup-layout">
          <div className="setup-copy">
            <button className="text-button" onClick={restartConnection}>← 入力画面に戻る</button>
            <p className="eyebrow">DEVICE CHECK</p>
            <h1>映像と音声を、<br />この画面で確認。</h1>
            <p>自分の映像が表示され、声に合わせてメーターが動けば端末の準備は完了です。接続失敗時も、カメラとマイクはそのまま確認できます。</p>
            <div className={`setup-status-card ${setupPhase}`} role="status">
              <i />
              <div><strong>{setupPhase === "requesting" ? "カメラとマイクの許可待ち" : setupPhase === "connecting" ? "安全な面接回線へ接続中" : setupPhase === "error" ? "端末の準備は完了・回線を再確認" : "カメラとマイクを確認済み"}</strong><span>{connectionStepCopy || "面接開始の準備が整いました。"}</span></div>
            </div>
          </div>

          <div className="device-card">
            <div className="camera-preview">
              {stream ? <video ref={videoRef} autoPlay muted playsInline /> : <div className="camera-empty"><img src="/tokyo-dogs-logo.jpg" alt="" /><span>カメラの許可を待っています</span></div>}
              {stream && <span className="connection-ok">カメラ接続済み</span>}
            </div>
            <div className="microphone-meter" aria-label="マイク入力レベル">
              <div><strong>マイク入力</strong><span>{candidateAudioCopy}</span></div>
              <div className="meter-track"><i style={{ width: `${Math.max(stream ? 4 : 0, microphoneLevel)}%` }} /></div>
              <small>話しかけると、声に合わせてメーターが動きます。</small>
            </div>
            <div className="device-check-list">
              <div className={stream?.getVideoTracks().some((track) => track.readyState === "live") ? "passed" : "checking"}><i /><span>カメラ</span><strong>{stream ? "映像を受信中" : "許可待ち"}</strong></div>
              <div className={candidateAudioState === "detected" ? "passed" : stream ? "checking" : "checking"}><i /><span>マイク</span><strong>{candidateAudioState === "detected" ? "声を確認済み" : stream ? "声を確認中" : "許可待ち"}</strong></div>
              <div className={speakerTestState === "passed" ? "passed" : "checking"}><i /><span>スピーカー</span><strong>{speakerTestState === "passed" ? "確認音を再生済み" : "自動再生を確認中"}</strong></div>
              <div className={networkAudioState === "connected" ? "passed" : networkAudioState === "error" ? "failed" : "checking"}><i /><span>面接回線</span><strong>{networkAudioCopy}</strong></div>
            </div>
            {errorMessage && <div className="inline-error" role="alert">{errorMessage}</div>}
            {setupPhase === "error" && accessTokenRef.current && (
              <div className="recorded-fallback-card" role="status">
                <strong>録画式のオンライン一次面接で続けます</strong>
                <span>質問を画面と端末音声で案内します。声で回答し、話し終えたら次へ進んでください。録画は選考資料として笠間・山本が確認します。</span>
                <button type="button" disabled={sessionStarting} onClick={() => void startRecordedFallback()}>{sessionStarting ? "予備方式を準備中…" : "録画式のオンライン一次面接へ進む"}</button>
              </div>
            )}
            <div className="setup-recovery-actions">
              <button type="button" onClick={playSpeakerTest}>確認音を再生</button>
              {screenShareSupported && <button type="button" onClick={() => void enableScreenCapture()}>{screenCaptureState === "ready" ? "画面共有を追加済み" : "画面共有を追加（任意）"}</button>}
            </div>
            <button className="primary-action setup-connect-button" disabled={!stream || sessionStarting} onClick={() => void (setupPhase === "error" ? startRecordedFallback() : connectPreparedInterview())}>
              {sessionStarting ? "オンライン一次面接へ接続中…" : setupPhase === "error" ? "録画式のオンライン一次面接へ進む" : "オンライン一次面接へ接続"} <span>→</span>
            </button>
            <p className="setup-footnote">カメラ映像と音声の確認後に録画を開始します。画面共有はPCのみ任意で追加できます。</p>
          </div>
        </section>
      )}

      {stage === "interview" && (
        <section className="interview-page">
          {mode === "internal-test" && <div className="internal-test-banner"><strong>接続確認</strong><span>選考対象外・録画・採用評価なし</span></div>}
          {mode === "recorded-fallback" && <div className="recorded-fallback-banner"><strong>オンライン一次面接・予備方式</strong><span>選考対象・録画を笠間・山本が確認</span></div>}
          <div className="interview-topline">
            <div className={`live-state ${connectionState}`}><i />{connectionCopy}</div>
            <div className="interview-time">{formatTime(elapsed)} {mode !== "internal-test" && <span>/ 目安 15–25分</span>}</div>
          </div>
          <div className="interview-card">
            <aside className="interview-side">
              <div className="candidate-preview">
                {stream ? <video ref={videoRef} autoPlay muted playsInline /> : <div><img src="/tokyo-dogs-logo.jpg" alt="" /><small>{mode === "internal-test" ? "CHECK MODE" : mode === "text" ? "TEXT MODE" : "接続中"}</small></div>}
              </div>
              <div className="candidate-details">
                <span>POSITION</span><strong>犬の幼稚園スタッフ<br />トレーナー候補</strong>
                <dl><div><dt>氏名</dt><dd>{mode === "internal-test" ? "接続確認" : candidateName.trim()}</dd></div><div><dt>雇用形態</dt><dd>{employment}</dd></div><div><dt>入職希望対象店舗</dt><dd>{normalizePreferredLocation(location) || "未入力"}</dd></div></dl>
              </div>
              <div className="privacy-box">
                <strong>{mode === "internal-test" ? "接続確認（選考対象外）" : "TOKYO DOGS オンライン一次面接"}</strong>
                <p>{mode === "internal-test"
                  ? "入力内容は送信・保存せず、録画・文字起こし・採用評価を行いません。"
                  : "ご回答、勤務条件、接客時の職務関連行動を採用選考の資料として確認します。容姿、笑顔の有無、機器や通信の不具合は評価しません。"}</p>
              </div>
              {(mode === "voice" || mode === "recorded-fallback") && <div className={`privacy-box recording-state ${recordingCaptureState}`}><strong>録画状態</strong><p>{recordingCaptureCopy}</p></div>}
            </aside>

            <div className="conversation-area">
              <div className="conversation-heading">
                <div className={`interviewer-profile ${connectionState}`}>
                  <div className="interviewer-avatar"><img src="/interviewer-woman-medium-v2.png" alt="TOKYO DOGS オンライン採用担当者 茂木" /></div>
                  <div><span>ONLINE RECRUITER</span><h2>オンライン採用担当者 茂木</h2></div>
                </div>
                <span>{candidateTurns} 回答</span>
              </div>
              {mode === "voice" && (
                <div className="audio-health" aria-label="双方向音声の接続状態">
                  <div className={candidateAudioState}><i /><span>あなたの音声</span><strong>{candidateAudioCopy}</strong></div>
                  <div className={remoteAudioState}><i /><span>茂木の音声</span><strong>{remoteAudioCopy}</strong></div>
                  <div className={networkAudioState}><i /><span>通信</span><strong>{networkAudioCopy}</strong></div>
                </div>
              )}
              {mode === "voice" && audioNotice && (
                <div className="audio-notice" role="status">
                  <span>{audioNotice}</span>
                  {(remoteAudioState === "blocked" || remoteAudioState === "error") && (
                    <button onClick={() => { primeRemoteAudioPlayback(); void resumeRemoteAudio(true); }}>茂木の音声を再開</button>
                  )}
                </div>
              )}
              {mode === "voice" && (
                <div className="audio-recovery-bar">
                  <span>聞こえない場合</span>
                  <button onClick={() => { primeRemoteAudioPlayback(); void resumeRemoteAudio(true); }}>茂木の音声を再開</button>
                  <button onClick={readLatestInterviewerTurn}>表示中の質問を読み上げ</button>
                </div>
              )}
              <div className="conversation-log" ref={conversationRef} aria-live="polite">
                {transcript.length === 0 ? (
                  <div className="waiting-message"><div className={`waiting-avatar ${connectionState}`}><img src="/interviewer-woman-medium-v2.png" alt="" /></div><div className="wave"><i /><i /><i /><i /></div><strong>{connectionState === "error" ? "接続できませんでした" : "オンライン一次面接を準備しています"}</strong><p>{connectionState === "error" ? errorMessage : connectionStepCopy || "まもなく茂木から最初の質問が始まります。"}</p></div>
                ) : transcript.map((turn) => (
                  <article className={`message ${turn.speaker}`} key={turn.id}>
                    <span>{turn.speaker === "interviewer" ? "茂木" : "あなた"}</span>
                    <p>{turn.text}</p>
                  </article>
                ))}
              </div>
              {mode === "recorded-fallback" ? (
                <div className="recorded-answer-control">
                  <div><strong>質問 {recordedQuestionIndex + 1} / {RECORDED_FALLBACK_QUESTIONS.length}</strong><span>回答はそのまま声でお話しください。話し終えた後にボタンを押します。</span></div>
                  <button type="button" disabled={!recordedQuestionReady || endingRef.current} onClick={() => void advanceRecordedFallback()}>{recordedQuestionIndex + 1 === RECORDED_FALLBACK_QUESTIONS.length ? "回答を終えて面接を完了" : "回答を終えて次の質問へ"}</button>
                </div>
              ) : (
                <div className="answer-composer">
                  <textarea value={textDraft} onChange={(event) => setTextDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendTextAnswer(); }} placeholder={mode === "voice" ? "聞き取りにくい時は、ここに入力できます" : "回答を入力してください"} rows={2} />
                  <button onClick={sendTextAnswer} disabled={!textDraft.trim() || connectionState === "idle" || connectionState === "connecting" || connectionState === "error"}>送信</button>
                </div>
              )}
              <div className="interview-controls">
                {(mode === "voice" || mode === "recorded-fallback") && <button className={isMuted ? "control danger" : "control"} onClick={toggleMute}>{isMuted ? "マイクを再開" : "マイクをミュート"}</button>}
                {connectionState === "error" && <button className="control" onClick={restartConnection}>最初から接続をやり直す</button>}
                {connectionState === "error" && <button className="control" onClick={startInternalTest}>選考対象外の接続確認へ切り替える</button>}
                <button className="finish-button" onClick={() => { if (window.confirm("オンライン一次面接を中止し、ここまでの記録を採用担当者へ送りますか？")) { reportCandidateEvent("candidate_requested_stop", "USER_ACTION"); void completeInterview("candidate_requested_stop"); } }}>面接を中止</button>
              </div>
            </div>
          </div>
        </section>
      )}

      {stage === "evaluating" && (
        <section className="evaluating-page">
          <img src="/tokyo-dogs-logo.jpg" alt="Tokyo Dogs" />
          <div className="evaluation-loader"><i /><i /><i /></div>
          <h1>回答内容を整理しています。</h1>
          <p>発言根拠を照合し、採用担当者向けの確認資料を作成しています。</p>
          <div className="evaluation-steps"><span className="done">文字起こし</span><span className="active">根拠を照合</span><span>評価を作成</span></div>
        </section>
      )}

      {stage === "review" && (
        <section className="review-page">
          <div className="review-heading">
            <div><p className="eyebrow">{mode === "internal-test" ? "PORTAL CHECK COMPLETE" : "ONLINE FIRST INTERVIEW RECEIVED"}</p><h1>{mode === "internal-test" ? "接続確認が完了しました。" : "オンライン一次面接を受け付けました。"}</h1><p>{mode === "internal-test" ? "録画・音声接続・採用評価は行っていません。この内容は採用判断には使用しません。" : "ご回答ありがとうございました。面接記録は採用担当者の笠間・山本が確認し、採用選考の判断資料として使用します。"}</p></div>
            <div className="recommendation human_review"><span>受付番号</span><strong>{mode === "internal-test" ? "TEST COMPLETE" : sessionId}</strong><small>{mode === "internal-test" ? "採用判断には使用しません" : "採用担当者のみ閲覧可能"}</small></div>
          </div>
          <div className="summary-card">
            <span>{mode === "internal-test" ? "接続確認の取り扱い" : "評価結果の取り扱い"}</span>
            <p>{mode === "internal-test"
              ? "入力内容は端末内の画面確認だけに使用し、外部送信・保存・録画・文字起こし・採用評価を行っていません。"
              : "採点結果、評価本文、文字起こし、録画はこの応募者画面には表示されません。認証された採用担当者だけが社内の確認画面で閲覧します。"}</p>
          </div>
          {processingWarning && <div className="validation-box"><strong>記録状態を採用担当者が確認します</strong><p>{processingWarning}</p></div>}
          {recordingUploadState === "stored" && <div className="validation-box"><strong>オンライン一次面接の記録を受け付けました</strong><p>録画は面接IDで保管し、採用担当者以外には開示しません。</p></div>}
          {recordingUploadState === "error" && <div className="validation-box"><strong>記録状態を採用担当者が確認します</strong><p>オンライン一次面接の受け付けは完了しています。受付番号をお控えください。</p></div>}
          <div className="review-actions"><div><span>{mode === "internal-test" ? "確認時間" : "面接時間"}</span><strong>{formatTime(elapsed)}</strong></div>{mode === "internal-test" && <button className="secondary-action" onClick={resetInterview}>最初から確認</button>}</div>
        </section>
      )}

      <footer className="site-footer"><span>TOKYO DOGS / OFFICIAL RECRUITMENT</span><span>CANDIDATE SELECTION PORTAL</span></footer>
    </main>
  );
}
