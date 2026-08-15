"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EMPLOYMENT_OPTIONS,
  INTERNAL_TEST_QUESTIONS,
  RECORDED_FALLBACK_QUESTIONS,
  TEXT_INTERVIEW_QUESTIONS,
  INTERVIEW_ACCESS_MESSAGES,
  INTERVIEW_ACCESS_STATES,
  INTERVIEW_TOPIC_IDS,
  LIGHT_OPENING_QUESTION,
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
import {
  INTERVIEW_MAX_SECONDS,
  mayDispatchTimedResponse,
  nextInterviewTimeAction,
  recordedFallbackQuietState,
} from "@/lib/interview-time-control";
import {
  isExactRecordedCompletionReplay,
  splitRecordedAnswerUpload,
} from "@/lib/recorded-answer-upload";
import { createLiveRecordingUploader, uploadRecordingResumably } from "@/lib/recording-upload";
import { createTranscriptDraftWriter } from "@/lib/transcript-draft";
import { reportCandidateEventOnce } from "@/lib/candidate-event-receipt";
import { runStickyInterviewCompletionHold } from "@/lib/interview-completion-hold";
import {
  initialRealtimeTranscriptIntegrity,
  realtimeTranscriptIntegrityBlocker,
  realtimeTranscriptIntegrityReady,
  reduceRealtimeTranscriptIntegrity,
} from "@/lib/realtime-transcript-integrity";
import { initialRecordingAudioCoverageState, reduceRecordingAudioCoverage } from "@/lib/recording-audio-coverage";
import {
  cameraInterviewReadiness,
  initialLocalMediaHealth,
  initialMicrophoneVerification,
  isEmbeddedInterviewBrowser,
  reduceLocalMediaHealth,
  reduceMicrophoneVerification,
  reduceSpeakerVerification,
} from "@/lib/interview-device-readiness";
import { InterviewerStage } from "./interviewer-stage";

type Stage = "intro" | "setup" | "interview" | "evaluating" | "review";
/** "checking" while the pre-flight is in flight; every other value mirrors InterviewAccessState. */
type InviteGate = "checking" | InterviewAccessState;
type InterviewMode = "voice" | "text" | "recorded-fallback" | "internal-test";
type InterviewFormat = "camera" | "text";
type InterviewCredentials = { sessionId: string; accessToken: string };
type InterviewContinuitySnapshot = {
  sessionId: string;
  candidateName: string;
  employment: string;
  location: string;
  status: string;
  recordingStatus: string;
  expiresAt: string;
  createdAt: string;
  mode: "voice" | "text" | "recorded-fallback";
  action: "resume_text" | "replace_with_text" | "processing" | "completed" | "held";
  transcript: TranscriptTurn[];
};
type InterviewContinuity = {
  accessToken: string;
  snapshot: InterviewContinuitySnapshot;
};
type RecordedAnswerReceipt = {
  state: "completed" | "pending";
  retryAfterSeconds: number;
};
type RecordedAnswerUploadPromises = {
  registration: Promise<void>;
  completion: Promise<void>;
};

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
type CompletionHold =
  | "none"
  | "candidate_requested_stop"
  | "safety_escalation"
  | "completion_reason_invalid"
  | "transcript_incomplete";
type CandidateEventReceiptState = "stored" | "unconfirmed";
const SUCCESSFUL_COMPLETION_REASONS = new Set([
  "ai_completed",
  "max_duration_reached",
  "max_duration_connection_unavailable",
  "recorded_fallback_max_duration_reached",
  "text_max_duration_reached",
  "recorded_fallback_completed",
  "text_interview_completed",
]);
type SpeakerTestState = "idle" | "playing" | "played" | "passed" | "error";
type SetupPhase = "idle" | "requesting" | "devices-ready" | "connecting" | "error";
type TimedInterviewAction = "warning" | "complete";
type RecordingAudioMix = {
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  localSource: MediaStreamAudioSourceNode;
  remoteSource: MediaStreamAudioSourceNode | null;
  remoteAnalyser: AnalyserNode | null;
  remoteMonitorTimer: number | null;
  remoteTrack: MediaStreamTrack | null;
  remoteTrackMuteHandler: (() => void) | null;
  remoteTrackUnmuteHandler: (() => void) | null;
  remoteTrackEndedHandler: (() => void) | null;
  contextStateHandler: (() => void) | null;
  remoteEnergySamples: number;
  remoteExpectedQuietSamples: number;
  remoteExpectedWindowSeen: boolean;
  remoteCoverageInvalid: boolean;
  remoteCoverageReported: boolean;
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
  response?: {
    id?: string;
    status?: string;
  };
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
  const [interviewFormat, setInterviewFormat] = useState<InterviewFormat>("camera");
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
  const [recordingUploadProgress, setRecordingUploadProgress] = useState(0);
  const [archiveSyncState, setArchiveSyncState] = useState<"idle" | "syncing" | "stored" | "error">("idle");
  const [completionSavePending, setCompletionSavePending] = useState(false);
  const [recordingCaptureState, setRecordingCaptureState] = useState<RecordingCaptureState>("idle");
  const [recordingHasBothAudio, setRecordingHasBothAudio] = useState<boolean | null>(null);
  const [candidateAudioState, setCandidateAudioState] = useState<CandidateAudioState>("idle");
  const [remoteAudioState, setRemoteAudioState] = useState<RemoteAudioState>("idle");
  const [networkAudioState, setNetworkAudioState] = useState<NetworkAudioState>("idle");
  const [audioNotice, setAudioNotice] = useState("");
  const [speakerTestState, setSpeakerTestState] = useState<SpeakerTestState>("idle");
  const [setupPhase, setSetupPhase] = useState<SetupPhase>("idle");
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [microphoneCheckPassed, setMicrophoneCheckPassed] = useState(false);
  const [localMediaRecoveryRequired, setLocalMediaRecoveryRequired] = useState(false);
  const [embeddedBrowser, setEmbeddedBrowser] = useState(false);
  const [copiedPortalLink, setCopiedPortalLink] = useState(false);
  const [screenShareSupported, setScreenShareSupported] = useState(false);
  const [inviteGate, setInviteGate] = useState<InviteGate>("checking");
  const [recordedQuestionIndex, setRecordedQuestionIndex] = useState(0);
  const [recordedQuestionReady, setRecordedQuestionReady] = useState(false);
  const [timeControlNotice, setTimeControlNotice] = useState("");
  const [completionHold, setCompletionHold] = useState<CompletionHold>("none");
  const [continuity, setContinuity] = useState<InterviewContinuity | null>(null);
  const [continuityChecking, setContinuityChecking] = useState(true);
  const [networkAvailable, setNetworkAvailable] = useState(true);

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
  // This is true only after MediaRecorder reaches a normal, error-free stop.
  // A Blob may still exist after a size cap or recorder error, but that Blob is
  // partial evidence and must never be uploaded or unlock a candidate receipt.
  const recordingCompleteRef = useRef(false);
  const recordingBlobRef = useRef<Blob | null>(null);
  const recordingLiveUploaderRef = useRef<ReturnType<typeof createLiveRecordingUploader> | null>(null);
  const recordingPromiseRef = useRef<Promise<Blob | null> | null>(null);
  const recordingResolveRef = useRef<((blob: Blob | null) => void) | null>(null);
  const recordedAnswerRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedAnswerChunksRef = useRef<Blob[]>([]);
  const recordedAnswerStartedAtRef = useRef<number | null>(null);
  // Registration proves that D1 has the exact answer index and R2 has the
  // corresponding audio bytes. Transcription may legitimately remain pending
  // after that receipt, so it has a separate promise and must not delay the
  // lightweight answer-count seal or the full recording upload.
  const recordedAnswerRegistrationPromisesRef = useRef(new Map<number, Promise<void>>());
  const recordedAnswerCompletionPromisesRef = useRef(new Map<number, Promise<void>>());
  const recordedAnswerRegisteredRef = useRef(new Set<number>());
  const recordedAnswerTranscribedRef = useRef(new Set<number>());
  const recordedAnswerCredentialsRef = useRef(new Map<number, InterviewCredentials>());
  const recordedAnswerBlobsRef = useRef(new Map<number, Blob>());
  const recordingAudioContextRef = useRef<AudioContext | null>(null);
  const recordingAudioMixRef = useRef<RecordingAudioMix | null>(null);
  const recordingHasBothAudioRef = useRef<boolean | null>(null);
  const assistantAudioExpectedRef = useRef(false);
  const assistantAudioExpectedUntilRef = useRef(0);
  const retryRecordedAnswersOnFinalizationRef = useRef(false);
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
  // UI partials are intentionally separate from this append-only sequence.
  // Only completed Realtime items enter the durable draft, in completion order.
  const completedTranscriptRef = useRef<TranscriptTurn[]>([]);
  const transcriptDraftWriterRef = useRef<ReturnType<typeof createTranscriptDraftWriter> | null>(null);
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
  const resumeRecordingAudioContextActionRef = useRef<() => Promise<boolean>>(async () => false);
  const invalidateRecordingRemoteCoverageActionRef = useRef<(code: string, reportNow?: boolean) => void>(() => undefined);
  const markLocalMediaInterruptedActionRef = useRef<(type: "track_muted" | "track_ended" | "device_changed" | "page_hidden") => void>(() => undefined);
  const previousAudioStatsRef = useRef({ sent: 0, received: 0 });
  const turnStateRef = useRef(initialTurnTakingState());
  const pendingCancelEventsRef = useRef(new Map<string, number>());
  const currentAssistantAudioItemRef = useRef("");
  const assistantAudioStartedAtRef = useRef<number | null>(null);
  const recordingGenerationRef = useRef(0);
  const recordingFinalStopRequestedRef = useRef(false);
  const recordingLocalContinuityValidRef = useRef(true);
  const attemptedCandidateEventsRef = useRef(new Set<string>());
  const reportedCandidateEventsRef = useRef(new Set<string>());
  const recordedQuestionTimerRef = useRef<number | null>(null);
  const recordedFallbackActiveRef = useRef(false);
  const modeRef = useRef<InterviewMode>("voice");
  const stageRef = useRef<Stage>("intro");
  const interviewStartedAtRef = useRef<number | null>(null);
  const microphoneLevelRef = useRef(0);
  const microphoneCheckPassedRef = useRef(false);
  const microphoneVerificationRef = useRef(initialMicrophoneVerification());
  const localMediaHealthRef = useRef(initialLocalMediaHealth());
  const localMediaRecoveryAttemptedRef = useRef(false);
  const localTrackHandlersRef = useRef(new Map<MediaStreamTrack, {
    mute: () => void;
    unmute: () => void;
    ended: () => void;
  }>());
  const recordedQuestionReadyRef = useRef(false);
  const timedWarningDeliveredRef = useRef(false);
  const timedMaximumRequestedRef = useRef(false);
  const timedActionRef = useRef<TimedInterviewAction | null>(null);
  const timedResponseRef = useRef<TimedInterviewAction | null>(null);
  const timedActionTimerRef = useRef<number | null>(null);
  const recordedFallbackQuietSinceRef = useRef<number | null>(null);
  const interviewFinalizationStoredRef = useRef(false);
  // Failure is sticky for the current session. Pending speech items and model
  // responses are tracked separately so a clean-looking partial transcript can
  // never be sealed before its final server events arrive.
  const voiceTranscriptionFailureRef = useRef(false);
  const realtimeTranscriptIntegrityRef = useRef(initialRealtimeTranscriptIntegrity());
  const completionHoldRef = useRef<CompletionHold>("none");
  const voiceTranscriptSealedRef = useRef(false);
  const queueTimedInterviewActionRef = useRef<(action: TimedInterviewAction) => void>(() => undefined);

  const candidateTurns = useMemo(
    () => transcript.filter((turn) => turn.speaker === "candidate").length,
    [transcript],
  );
  const cameraReadiness = useMemo(() => cameraInterviewReadiness({
    embeddedBrowser,
    recoveryRequired: localMediaRecoveryRequired,
    hasLiveVideo: Boolean(stream?.getVideoTracks().some((track) => track.readyState === "live")),
    hasLiveAudio: Boolean(stream?.getAudioTracks().some((track) => track.readyState === "live" && track.enabled)),
    microphoneVerified: microphoneCheckPassed,
    speakerVerified: speakerTestState === "passed",
  }), [embeddedBrowser, localMediaRecoveryRequired, microphoneCheckPassed, speakerTestState, stream]);

  useEffect(() => {
    streamRef.current = stream;
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, stage]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setEmbeddedBrowser(isEmbeddedInterviewBrowser(navigator.userAgent));
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
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    void fetch("/api/interviews/resume", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json().catch(() => null) as {
        available?: boolean;
        accessToken?: string;
        snapshot?: InterviewContinuitySnapshot;
      } | null;
      if (
        !cancelled && response.ok && data?.available === true &&
        typeof data.accessToken === "string" && data.snapshot?.sessionId
      ) setContinuity({ accessToken: data.accessToken, snapshot: data.snapshot });
    }).catch(() => undefined).finally(() => {
      window.clearTimeout(timeout);
      if (!cancelled) setContinuityChecking(false);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const updateNetwork = () => {
      const online = navigator.onLine;
      setNetworkAvailable(online);
      if (!online) return;
      void recordingLiveUploaderRef.current?.retry().catch(() => undefined);
      const completed = completedTranscriptRef.current;
      if (completed.length > 0) enqueueCompletedTranscriptSnapshot(completed);
    };
    updateNetwork();
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    return () => {
      window.removeEventListener("online", updateNetwork);
      window.removeEventListener("offline", updateNetwork);
    };
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    if (
      !navigator.mediaDevices?.addEventListener ||
      !["setup", "interview"].includes(stage) ||
      mode === "text" ||
      mode === "internal-test"
    ) return;
    const handleDeviceChange = () => markLocalMediaInterruptedActionRef.current("device_changed");
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [mode, stage]);

  useEffect(() => {
    const activeInterviewCanLoseUnsentMedia = stage === "interview" && mode !== "internal-test";
    if (
      !activeInterviewCanLoseUnsentMedia &&
      !completionSavePending &&
      recordingUploadState !== "uploading" &&
      recordingUploadState !== "error"
    ) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [completionSavePending, mode, recordingUploadState, stage]);

  useEffect(() => {
    queueTimedInterviewActionRef.current = queueTimedInterviewAction;
  });

  useEffect(() => {
    if (stage !== "interview") return;
    if (interviewStartedAtRef.current === null) {
      interviewStartedAtRef.current = Date.now();
    }
    const updateElapsed = () => {
      const startedAt = interviewStartedAtRef.current;
      if (startedAt !== null) setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [stage]);

  useEffect(() => {
    if (stage !== "interview" || mode === "internal-test") return;
    const action = nextInterviewTimeAction({
      elapsedSeconds: elapsed,
      warningDelivered: timedWarningDeliveredRef.current,
      maximumRequested: timedMaximumRequestedRef.current,
    });
    if (action) queueTimedInterviewActionRef.current(action);
  }, [elapsed, mode, stage]);

  useEffect(() => {
    conversationRef.current?.scrollTo({
      top: conversationRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [transcript]);

  useEffect(() => {
    if (stage !== "interview" || mode !== "voice") return;
    const resumeInterviewAudio = () => {
      if (document.visibilityState !== "visible") return;
      void resumeRemoteAudioActionRef.current(false);
      void resumeRecordingAudioContextActionRef.current();
    };
    const markHidden = () => {
      if (document.visibilityState === "hidden") invalidateRecordingRemoteCoverageActionRef.current("REMOTE_AUDIO_PAGE_HIDDEN", false);
    };
    const markPageHidden = () => invalidateRecordingRemoteCoverageActionRef.current("REMOTE_AUDIO_PAGE_HIDDEN", false);
    document.addEventListener("visibilitychange", markHidden);
    document.addEventListener("visibilitychange", resumeInterviewAudio);
    window.addEventListener("pageshow", resumeInterviewAudio);
    window.addEventListener("pagehide", markPageHidden);
    window.addEventListener("online", resumeInterviewAudio);
    window.addEventListener("pointerdown", resumeInterviewAudio);
    window.addEventListener("keydown", resumeInterviewAudio);
    window.addEventListener("touchend", resumeInterviewAudio);
    return () => {
      document.removeEventListener("visibilitychange", markHidden);
      document.removeEventListener("visibilitychange", resumeInterviewAudio);
      window.removeEventListener("pageshow", resumeInterviewAudio);
      window.removeEventListener("pagehide", markPageHidden);
      window.removeEventListener("online", resumeInterviewAudio);
      window.removeEventListener("pointerdown", resumeInterviewAudio);
      window.removeEventListener("keydown", resumeInterviewAudio);
      window.removeEventListener("touchend", resumeInterviewAudio);
    };
  }, [stage, mode]);

  useEffect(() => {
    if (stage !== "interview" || (mode !== "voice" && mode !== "recorded-fallback")) return;
    const markLocalHidden = () => {
      if (document.visibilityState === "hidden") {
        markLocalMediaInterruptedActionRef.current("page_hidden");
      }
    };
    const markLocalPageHidden = () => markLocalMediaInterruptedActionRef.current("page_hidden");
    document.addEventListener("visibilitychange", markLocalHidden);
    window.addEventListener("pagehide", markLocalPageHidden);
    return () => {
      document.removeEventListener("visibilitychange", markLocalHidden);
      window.removeEventListener("pagehide", markLocalPageHidden);
    };
  }, [mode, stage]);

  useEffect(() => {
    resumeRemoteAudioActionRef.current = resumeRemoteAudio;
    resumeRecordingAudioContextActionRef.current = resumeRecordingAudioContext;
    invalidateRecordingRemoteCoverageActionRef.current = invalidateRecordingRemoteCoverage;
    markLocalMediaInterruptedActionRef.current = markLocalMediaInterrupted;
  });

  useEffect(() => {
    const preparedAudio = preparedAudioRef.current;
    return () => {
      channelRef.current?.close();
      peerRef.current?.close();
      streamRef.current?.getAudioTracks().forEach(unbindLocalMicrophoneTrack);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      displayStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (disconnectTimerRef.current) window.clearTimeout(disconnectTimerRef.current);
      if (channelOpenTimerRef.current) window.clearTimeout(channelOpenTimerRef.current);
      if (responseWatchdogRef.current) window.clearTimeout(responseWatchdogRef.current);
      if (candidateResponseDelayTimerRef.current) window.clearTimeout(candidateResponseDelayTimerRef.current);
      if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
      if (timedActionTimerRef.current) window.clearTimeout(timedActionTimerRef.current);
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
    microphoneLevelRef.current = 0;
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
        microphoneLevelRef.current = level;
        setMicrophoneLevel((current) => Math.abs(current - level) >= 2 ? level : current);
        microphoneVerificationRef.current = reduceMicrophoneVerification(
          microphoneVerificationRef.current,
          {
            trackLive: audioTrack.readyState === "live" && audioTrack.enabled && !audioTrack.muted,
            level,
          },
        );
        if (microphoneVerificationRef.current.verified) {
          setCandidateAudioState("detected");
          if (!microphoneCheckPassedRef.current) {
            microphoneCheckPassedRef.current = true;
            setMicrophoneCheckPassed(true);
          }
          if (localMediaRecoveryAttemptedRef.current && localMediaHealthRef.current.blocked) {
            localMediaHealthRef.current = reduceLocalMediaHealth(localMediaHealthRef.current, {
              type: "explicit_recovery_verified",
            });
            localMediaRecoveryAttemptedRef.current = false;
            setLocalMediaRecoveryRequired(false);
            setAudioNotice("マイクの再取得と実音量を確認しました。準備が整ったら、明示的に再接続してください。");
          }
        }
        else if (audioTrack.enabled && !audioTrack.muted) setCandidateAudioState("ready");
        meter.animationFrame = window.requestAnimationFrame(update);
      };
      microphoneMeterRef.current = meter;
      update();
    } catch {
      microphoneLevelRef.current = 0;
      setMicrophoneLevel(0);
    }
  }

  function unbindLocalMicrophoneTrack(track: MediaStreamTrack) {
    const handlers = localTrackHandlersRef.current.get(track);
    if (!handlers) return;
    track.removeEventListener("mute", handlers.mute);
    track.removeEventListener("unmute", handlers.unmute);
    track.removeEventListener("ended", handlers.ended);
    localTrackHandlersRef.current.delete(track);
  }

  function abortActiveRecordedAnswerForMediaRecovery() {
    const recorder = recordedAnswerRecorderRef.current;
    recordedAnswerRecorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        recorder.stop();
      } catch {
        // The OS may already have stopped the answer recorder.
      }
    }
    recordedAnswerChunksRef.current = [];
    recordedAnswerStartedAtRef.current = null;
    recordedQuestionReadyRef.current = false;
    setRecordedQuestionReady(false);
  }

  function markLocalMediaInterrupted(type: "track_muted" | "track_ended" | "device_changed" | "page_hidden") {
    if (
      endingRef.current ||
      stageRef.current !== "interview" ||
      modeRef.current === "text" ||
      modeRef.current === "internal-test"
    ) return;
    const previous = localMediaHealthRef.current;
    localMediaHealthRef.current = reduceLocalMediaHealth(previous, { type });
    if (previous.blocked) return;
    const code = localMediaHealthRef.current.code || "LOCAL_MEDIA_INTERRUPTED";
    microphoneCheckPassedRef.current = false;
    microphoneVerificationRef.current = initialMicrophoneVerification();
    setMicrophoneCheckPassed(false);
    setSpeakerTestState("idle");
    setLocalMediaRecoveryRequired(true);
    setCandidateAudioState("error");
    setSetupPhase("error");
    setConnectionState("error");
    setNetworkAudioState("error");
    setErrorMessage("TD-CONN-MIC: マイク接続の変更を検知したため、質問を停止しました。「マイクを再取得」を押して、声の入力をもう一度確認してください。");
    setAudioNotice("マイクが変化したため、自動で別の機器へ切り替えず、面接を停止しています。");
    reportCandidateEvent("recording_unavailable", code);
    invalidateRecordingRemoteCoverage(code);
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      // The browser does not prove continuous camera/microphone capture across
      // a mute, device swap, app background, or track end. Recovery may let the
      // candidate continue, but the interrupted recording cannot receive the
      // same complete/archive receipt as uninterrupted media.
      recordingLocalContinuityValidRef.current = false;
      recordingCompleteRef.current = false;
    }
    if (modeRef.current === "recorded-fallback") abortActiveRecordedAnswerForMediaRecovery();
    if (stageRef.current === "interview") {
      stopRealtime({ keepLocalStream: true, keepRecorder: true });
      setStage("setup");
    }
  }

  function bindLocalMicrophoneTrack(track: MediaStreamTrack) {
    unbindLocalMicrophoneTrack(track);
    const handlers = {
      mute: () => markLocalMediaInterruptedActionRef.current("track_muted"),
      unmute: () => {
        if (localMediaHealthRef.current.blocked) {
          setCandidateAudioState("error");
          setAudioNotice("マイクが再開したように見えても、自動では面接を続けません。「マイクを再取得」を押してください。");
        } else {
          setCandidateAudioState("ready");
        }
      },
      ended: () => markLocalMediaInterruptedActionRef.current("track_ended"),
    };
    localTrackHandlersRef.current.set(track, handlers);
    track.addEventListener("mute", handlers.mute);
    track.addEventListener("unmute", handlers.unmute);
    track.addEventListener("ended", handlers.ended);
  }

  async function reacquireLocalMedia() {
    if (sessionStarting || !localMediaRecoveryRequired) return;
    setSessionStarting(true);
    setErrorMessage("");
    setAudioNotice("カメラとマイクの再取得を確認しています。許可画面が出た場合は「許可」を選んでください。");
    let acquiredStream: MediaStream | null = null;
    let nextStream: MediaStream | null = null;
    try {
      acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 540 } },
      });
      const nextMicrophone = acquiredStream.getAudioTracks()[0];
      const nextCamera = acquiredStream.getVideoTracks()[0];
      if (!nextMicrophone || !nextCamera) throw new Error("TD-CONN-MIC: カメラまたはマイクを再取得できませんでした。");

      const mix = recordingAudioMixRef.current;
      const previousStream = streamRef.current;
      const activeRecorder = recorderRef.current?.state === "recording";
      if (activeRecorder) {
        if (!mix || mix.context.state === "closed") {
          throw new Error("TD-CONN-MIC: 録画を壊さずにマイクを更新できません。採用担当者へ受付番号をお知らせください。");
        }
        const recorderCamera = previousStream?.getVideoTracks()[0];
        if (!recorderCamera || recorderCamera.readyState !== "live" || recorderCamera.muted) {
          throw new Error("TD-CONN-CAMERA: 録画中のカメラを安全に継続できません。採用担当者へ受付番号をお知らせください。");
        }
        const replacementSource = mix.context.createMediaStreamSource(new MediaStream([nextMicrophone]));
        replacementSource.connect(mix.destination);
        try {
          mix.localSource.disconnect();
        } catch {
          // The old source may already be disconnected after an OS interruption.
        }
        mix.localSource = replacementSource;
        // MediaRecorder cannot safely swap encoded video tracks mid-container.
        // Keep the exact original recorder-owned camera track for the preview;
        // never imply that the newly acquired camera was added to the recording.
        nextCamera.stop();
        nextStream = new MediaStream([recorderCamera, nextMicrophone]);
      } else {
        nextStream = acquiredStream;
      }

      previousStream?.getAudioTracks().forEach(unbindLocalMicrophoneTrack);
      streamRef.current = nextStream;
      setStream(nextStream);
      bindLocalMicrophoneTrack(nextMicrophone);
      microphoneCheckPassedRef.current = false;
      microphoneVerificationRef.current = initialMicrophoneVerification();
      setMicrophoneCheckPassed(false);
      localMediaRecoveryAttemptedRef.current = true;
      setCandidateAudioState("checking");
      setSetupPhase("devices-ready");
      await startMicrophoneMeter(nextStream);
      if (activeRecorder) previousStream?.getAudioTracks().forEach((track) => track.stop());
      else previousStream?.getTracks().forEach((track) => track.stop());
      setAudioNotice("マイクに向かって話し、入力メーターが動いた後に「オンライン一次面接へ再接続」を押してください。");
    } catch (error) {
      acquiredStream?.getTracks().forEach((track) => track.stop());
      if (recorderRef.current?.state === "recording") {
        recordingFinalStopRequestedRef.current = false;
        recordingCompleteRef.current = false;
        try {
          recorderRef.current.stop();
        } catch {
          recordingResolveRef.current?.(null);
          recordingResolveRef.current = null;
        }
      }
      localMediaRecoveryAttemptedRef.current = false;
      setCandidateAudioState("error");
      setSetupPhase("error");
      setErrorMessage(deviceErrorMessage(error));
    } finally {
      setSessionStarting(false);
    }
  }

  async function resumeAfterLocalMediaRecovery() {
    if (!cameraReadiness.ready || localMediaHealthRef.current.blocked) {
      setErrorMessage(`TD-CONN-CHECK: ${cameraReadiness.message}`);
      return;
    }
    setErrorMessage("");
    if (modeRef.current === "recorded-fallback") {
      recordedFallbackActiveRef.current = true;
      setSetupPhase("devices-ready");
      setConnectionState("ready");
      setNetworkAudioState("idle");
      setStage("interview");
      setAudioNotice("マイクの再取得後、同じ質問の回答を最初から録音します。");
      armRecordedAnswerButton();
      return;
    }
    await connectPreparedInterview();
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
      if (updateSpeakerTest) setSpeakerTestState((state) => reduceSpeakerVerification(state, "playback_failed") as SpeakerTestState);
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
      if (updateSpeakerTest) setSpeakerTestState((state) => reduceSpeakerVerification(state, "playback_started") as SpeakerTestState);
    };
    utterance.onend = () => {
      if (updateSpeakerTest) setSpeakerTestState((state) => reduceSpeakerVerification(state, "playback_completed") as SpeakerTestState);
      if (!keepAudioPrimed && !remoteStreamRef.current) stopAudioPrime();
    };
    utterance.onerror = (event) => {
      if (event.error === "canceled" || event.error === "interrupted") return;
      if (updateSpeakerTest) setSpeakerTestState((state) => reduceSpeakerVerification(state, "playback_failed") as SpeakerTestState);
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
      if (options.updateSpeakerTest) setSpeakerTestState((state) => reduceSpeakerVerification(state, "playback_failed") as SpeakerTestState);
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
    if (options.updateSpeakerTest) setSpeakerTestState((state) => reduceSpeakerVerification(state, "playback_started") as SpeakerTestState);

    const fail = () => {
      if (options.updateSpeakerTest) setSpeakerTestState((state) => reduceSpeakerVerification(state, "playback_failed") as SpeakerTestState);
      if (!options.keepAudioPrimed && !remoteStreamRef.current) stopAudioPrime();
      setAudioNotice("確認音声を再生できませんでした。端末の消音を解除し、音量を上げて「もう一度聞く」を押してください。");
    };
    audio.onplaying = () => {
      if (options.updateSpeakerTest) setSpeakerTestState((state) => reduceSpeakerVerification(state, "playback_started") as SpeakerTestState);
      setAudioNotice("");
    };
    audio.onended = () => {
      if (options.updateSpeakerTest) setSpeakerTestState((state) => reduceSpeakerVerification(state, "playback_completed") as SpeakerTestState);
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

  function confirmSpeakerHeard() {
    if (speakerTestState !== "played") return;
    setSpeakerTestState((state) => reduceSpeakerVerification(state, "candidate_confirmed") as SpeakerTestState);
    setAudioNotice("確認音が聞こえたことを確認しました。");
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

  function resetRealtimeTranscriptIntegrity() {
    voiceTranscriptionFailureRef.current = false;
    realtimeTranscriptIntegrityRef.current = initialRealtimeTranscriptIntegrity();
  }

  function applyRealtimeTranscriptIntegrity(event: RealtimeEvent) {
    const next = reduceRealtimeTranscriptIntegrity(realtimeTranscriptIntegrityRef.current, event);
    realtimeTranscriptIntegrityRef.current = next;
    if (next.transcriptionFailed) voiceTranscriptionFailureRef.current = true;
    return next;
  }

  function voiceTranscriptCompletionBlocker() {
    if (voiceTranscriptionFailureRef.current) return "transcription_failed";
    return realtimeTranscriptIntegrityBlocker(realtimeTranscriptIntegrityRef.current);
  }

  function updateCompletionHold(next: CompletionHold) {
    completionHoldRef.current = next;
    setCompletionHold(next);
  }

  async function reportCandidateEvent(
    eventType: "audio_playback_blocked" | "transcription_failed" | "recording_unavailable" | "connection_failed" | "candidate_requested_stop" | "safety_escalation" | "completion_reason_invalid" | "time_limit_reached" | "reasonable_accommodation_text_selected",
    code = "",
  ): Promise<CandidateEventReceiptState> {
    const activeSessionId = sessionIdRef.current;
    const accessToken = accessTokenRef.current;
    if (!activeSessionId.startsWith("TD-") || activeSessionId === "TD-PENDING" || !accessToken) {
      return "unconfirmed";
    }
    const result = await reportCandidateEventOnce({
      sessionId: activeSessionId,
      accessToken,
      eventType,
      code,
      attemptedKeys: attemptedCandidateEventsRef.current,
      storedKeys: reportedCandidateEventsRef.current,
    });
    return result.state;
  }

  function clearCandidateResponseDelay() {
    if (candidateResponseDelayTimerRef.current) {
      window.clearTimeout(candidateResponseDelayTimerRef.current);
    }
    candidateResponseDelayTimerRef.current = null;
  }

  function clearTimedActionTimer() {
    if (timedActionTimerRef.current) window.clearTimeout(timedActionTimerRef.current);
    timedActionTimerRef.current = null;
  }

  function resetTimedInterviewControl(options: { resetClock?: boolean } = {}) {
    clearTimedActionTimer();
    timedWarningDeliveredRef.current = false;
    timedMaximumRequestedRef.current = false;
    timedActionRef.current = null;
    timedResponseRef.current = null;
    recordedFallbackQuietSinceRef.current = null;
    recordedQuestionReadyRef.current = false;
    setTimeControlNotice("");
    if (options.resetClock !== false) interviewStartedAtRef.current = null;
  }

  function startInterviewClock() {
    resetTimedInterviewControl({ resetClock: false });
    interviewStartedAtRef.current = Date.now();
    setElapsed(0);
  }

  function timedResponseInstructions(action: TimedInterviewAction) {
    if (action === "warning") {
      return "面接開始から24分が経過しました。応募者の回答を遮らず、残り約3分であることを穏やかに一文で伝えてください。その後、既に得た回答を踏まえ、未確認事項のうち選考上もっとも重要なものを一つだけ短く質問してください。終了案内や完了ツールの呼び出しはまだ行わないでください。";
    }
    return "面接時間の上限に達しました。新しい質問はせず、応募者の直前の回答を短く受け止めてください。回答途中で遮らなかったことが自然に伝わるようにし、面接記録を採用担当者が確認する旨とお礼を簡潔に述べて、これでオンライン一次面接を終了すると案内してください。完了ツールは呼び出さないでください。";
  }

  function finishTimedVoiceResponse(action: TimedInterviewAction) {
    timedResponseRef.current = null;
    if (action === "warning") {
      timedWarningDeliveredRef.current = true;
      if (timedActionRef.current === "warning") timedActionRef.current = null;
      setTimeControlNotice("残り時間は約3分です。現在の回答を遮らず、必要な確認を絞って進めています。");
      if (timedActionRef.current === "complete") scheduleTimedVoiceResponse(800);
      return;
    }
    if (isCandidateSpeaking()) {
      timedActionRef.current = "complete";
      return;
    }
    timedActionRef.current = null;
    scheduleInterviewCompletion("max_duration_reached", 1_200);
  }

  function dispatchTimedVoiceResponse() {
    timedActionTimerRef.current = null;
    const action = timedActionRef.current;
    if (!action || modeRef.current !== "voice") return;
    if (!mayDispatchTimedResponse({
      candidateSpeaking: isCandidateSpeaking(),
      awaitingResponse: isAwaitingResponse(),
      timedResponseInFlight: Boolean(timedResponseRef.current),
      ending: endingRef.current,
    })) return;
    const channel = channelRef.current;
    if (!channel || channel.readyState !== "open") {
      if (action === "complete" && !isCandidateSpeaking()) {
        timedActionRef.current = null;
        scheduleInterviewCompletion("max_duration_connection_unavailable", 1_200);
      }
      return;
    }
    clearCandidateResponseDelay();
    timedResponseRef.current = action;
    channel.send(JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: timedResponseInstructions(action),
      },
    }));
    armResponseWatchdog(true);
    setConnectionState("ai-speaking");
  }

  function scheduleTimedVoiceResponse(delay = CANDIDATE_RESPONSE_DELAY_MS) {
    if (modeRef.current !== "voice" || endingRef.current || timedResponseRef.current) return;
    clearTimedActionTimer();
    timedActionTimerRef.current = window.setTimeout(dispatchTimedVoiceResponse, delay);
  }

  async function completeRecordedFallbackAtTimeLimit(answerAlreadyRecorded = false) {
    if (endingRef.current || !recordedFallbackActiveRef.current) return;
    clearTimedActionTimer();
    recordedQuestionReadyRef.current = false;
    setRecordedQuestionReady(false);
    if (!answerAlreadyRecorded) {
      const answerNumber = recordedQuestionIndex + 1;
      finishRecordedAnswerCapture(answerNumber);
      upsertTurn({
        id: `recorded-fallback-answer-${answerNumber}`,
        speaker: "candidate",
        text: `回答${answerNumber}の発言内容は録画音声に記録されています。自動文字起こし完了後、採用担当者が録画と照合します。`,
        createdAt: new Date().toISOString(),
      });
    }
    const closing = "お話の途中では遮らずに確認しました。面接時間の上限となりましたので、オンライン一次面接は以上です。回答と録画は、権限を付与された採用担当者が確認します。ご回答ありがとうございました。";
    upsertTurn({
      id: "recorded-fallback-time-limit-closing",
      speaker: "interviewer",
      text: closing,
      createdAt: new Date().toISOString(),
    });
    setConnectionState("ai-speaking");
    await speakRecordedQuestion(closing);
    await completeInterview("recorded_fallback_max_duration_reached");
  }

  function monitorRecordedFallbackForSafeClose() {
    timedActionTimerRef.current = null;
    if (
      modeRef.current !== "recorded-fallback" ||
      !timedMaximumRequestedRef.current ||
      !recordedFallbackActiveRef.current ||
      endingRef.current
    ) return;
    if (!recordedQuestionReadyRef.current) {
      timedActionTimerRef.current = window.setTimeout(monitorRecordedFallbackForSafeClose, 250);
      return;
    }
    const quiet = recordedFallbackQuietState({
      microphoneLevel: microphoneLevelRef.current,
      quietSince: recordedFallbackQuietSinceRef.current,
      now: Date.now(),
    });
    recordedFallbackQuietSinceRef.current = quiet.quietSince;
    if (quiet.ready) {
      void completeRecordedFallbackAtTimeLimit();
      return;
    }
    timedActionTimerRef.current = window.setTimeout(monitorRecordedFallbackForSafeClose, 250);
  }

  function queueTimedInterviewAction(action: TimedInterviewAction) {
    if (action === "warning") {
      if (timedWarningDeliveredRef.current || timedMaximumRequestedRef.current) return;
      if (!timedActionRef.current) timedActionRef.current = "warning";
      setTimeControlNotice("開始から24分が経過しました。回答を遮らず、残り約3分で確認をまとめます。");
      if (modeRef.current === "voice" && !timedActionTimerRef.current && !timedResponseRef.current) {
        scheduleTimedVoiceResponse();
      }
      return;
    }
    if (!timedMaximumRequestedRef.current) {
      timedMaximumRequestedRef.current = true;
      reportCandidateEvent("time_limit_reached", "MAX_27_MINUTES");
    }
    timedActionRef.current = "complete";
    setTimeControlNotice("面接時間の上限です。現在の回答が終わってから、安全に面接を終了します。");
    if (modeRef.current === "recorded-fallback") {
      if (!timedActionTimerRef.current) {
        recordedFallbackQuietSinceRef.current = null;
        timedActionTimerRef.current = window.setTimeout(monitorRecordedFallbackForSafeClose, 250);
      }
      return;
    }
    if (modeRef.current === "text") {
      const pendingText = textDraft.trim();
      if (pendingText) {
        recordCompletedTurn({
          id: `text-time-limit-${Date.now()}`,
          speaker: "candidate",
          text: pendingText,
          createdAt: new Date().toISOString(),
        });
        setTextDraft("");
      }
      scheduleInterviewCompletion("text_max_duration_reached", 1_200);
      return;
    }
    if (!timedActionTimerRef.current && !timedResponseRef.current) scheduleTimedVoiceResponse();
  }

  function scheduleResponseAfterCandidatePause() {
    clearCandidateResponseDelay();
    if (timedActionRef.current) {
      scheduleTimedVoiceResponse();
      return;
    }
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
      if (recordingContext && recordingContext.state !== "running" && recordingContext.state !== "closed") {
        await resumeRecordingAudioContext();
      }
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
    const stableTurn = index >= 0 && current[index].createdAt
      ? { ...turn, createdAt: current[index].createdAt }
      : turn;
    const next = index >= 0
      ? current.map((item, itemIndex) => itemIndex === index ? stableTurn : item)
      : [...current, stableTurn];
    transcriptRef.current = next;
    setTranscript(next);
    return stableTurn;
  }

  function initializeTranscriptDraftWriter(
    credentials: InterviewCredentials,
    draftMode: "voice" | "text",
  ) {
    transcriptDraftWriterRef.current = createTranscriptDraftWriter({
      sessionId: credentials.sessionId,
      accessToken: credentials.accessToken,
      mode: draftMode,
    });
  }

  function enqueueCompletedTranscriptSnapshot(snapshot = completedTranscriptRef.current) {
    const writer = transcriptDraftWriterRef.current;
    if (!writer || snapshot.length < 1) return;
    void writer.enqueue(snapshot).catch(() => {
      setProcessingWarning("回答記録の途中保存を確認できませんでした。面接終了時に同じ受付番号で再確認します。この画面は閉じないでください。");
    });
  }

  function recordCompletedTurn(turn: TranscriptTurn, options: { enqueue?: boolean } = {}) {
    const uiTurn = upsertTurn(turn);
    const current = completedTranscriptRef.current;
    const existing = current.find((item) => item.id === uiTurn.id);
    if (existing) {
      if (existing.speaker !== uiTurn.speaker || existing.text !== uiTurn.text) {
        voiceTranscriptionFailureRef.current = true;
        realtimeTranscriptIntegrityRef.current = {
          ...realtimeTranscriptIntegrityRef.current,
          transcriptionFailed: true,
        };
        setProcessingWarning("同じ発言の確定内容が一致しなかったため、面接記録を自動確定しません。採用担当者が確認します。");
      }
      return current;
    }
    const next = [...current, uiTurn];
    completedTranscriptRef.current = next;
    if (options.enqueue !== false) enqueueCompletedTranscriptSnapshot(next);
    return next;
  }

  function finalizationTranscript() {
    return modeRef.current === "voice" || modeRef.current === "text"
      ? completedTranscriptRef.current
      : transcriptRef.current;
  }

  async function sealDurableTranscriptDraft(draftMode: "voice" | "text") {
    const snapshot = finalizationTranscript();
    if (!snapshot.some((turn) => turn.speaker === "candidate" && turn.text.trim().length > 0)) {
      throw new Error("確定できる回答記録がありません。");
    }
    let writer = transcriptDraftWriterRef.current;
    if (!writer) {
      const activeSessionId = sessionIdRef.current;
      const activeAccessToken = accessTokenRef.current;
      if (!activeSessionId || activeSessionId === "TD-PENDING" || !activeAccessToken) {
        throw new Error("回答記録の保存情報を確認できません。");
      }
      initializeTranscriptDraftWriter(
        { sessionId: activeSessionId, accessToken: activeAccessToken },
        draftMode,
      );
      writer = transcriptDraftWriterRef.current;
    }
    await writer!.seal(snapshot);
  }

  function cleanupRecordingAudioMix() {
    const mix = recordingAudioMixRef.current;
    if (!mix) return;
    if (mix.remoteMonitorTimer !== null) window.clearInterval(mix.remoteMonitorTimer);
    if (mix.remoteTrack) {
      if (mix.remoteTrackMuteHandler) mix.remoteTrack.removeEventListener("mute", mix.remoteTrackMuteHandler);
      if (mix.remoteTrackUnmuteHandler) mix.remoteTrack.removeEventListener("unmute", mix.remoteTrackUnmuteHandler);
      if (mix.remoteTrackEndedHandler) mix.remoteTrack.removeEventListener("ended", mix.remoteTrackEndedHandler);
    }
    if (mix.contextStateHandler) mix.context.removeEventListener("statechange", mix.contextStateHandler);
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
    if (value === true && recordingAudioMixRef.current?.remoteCoverageInvalid) value = false;
    recordingHasBothAudioRef.current = value;
    setRecordingHasBothAudio(value);
  }

  function isAssistantRecordingAudioExpected() {
    return (
      !isCandidateSpeaking() &&
      (assistantAudioExpectedRef.current || Date.now() < assistantAudioExpectedUntilRef.current)
    );
  }

  function markAssistantRecordingAudioExpected(expected: boolean) {
    assistantAudioExpectedRef.current = expected;
    assistantAudioExpectedUntilRef.current = expected ? 0 : Date.now() + 1_500;
  }

  function reportRecordingRemoteCoverageIssue(code: string) {
    reportCandidateEvent("recording_unavailable", code);
    setAudioNotice("録画内の茂木の音声を確認できません。面接は継続し、採用担当者が記録状態を確認します。");
  }

  function invalidateRecordingRemoteCoverage(code: string, reportNow = true) {
    const mix = recordingAudioMixRef.current;
    if (!mix || recorderRef.current?.state !== "recording" || endingRef.current) return;
    commitRecordingAudioCoverage(mix, reduceRecordingAudioCoverage(readRecordingAudioCoverage(mix), {
      type: code === "REMOTE_AUDIO_PAGE_HIDDEN" ? "hidden" : code === "REMOTE_AUDIO_CONTEXT_INTERRUPTED" ? "interrupted" : "track_unavailable",
    }));
    updateRecordingAudioCoverage(false);
    if (reportNow && isAssistantRecordingAudioExpected() && !mix.remoteCoverageReported) {
      mix.remoteCoverageReported = true;
      reportRecordingRemoteCoverageIssue(code);
    }
  }

  async function resumeRecordingAudioContext() {
    const mix = recordingAudioMixRef.current;
    const context = mix?.context ?? recordingAudioContextRef.current;
    if (!context || context.state === "closed") return false;
    const recovering = context.state !== "running";
    if (recovering) {
      invalidateRecordingRemoteCoverage("REMOTE_AUDIO_CONTEXT_INTERRUPTED");
      try {
        await context.resume();
      } catch {
        return false;
      }
    }
    if (mix && recovering && String(context.state) === "running") {
      commitRecordingAudioCoverage(mix, reduceRecordingAudioCoverage(readRecordingAudioCoverage(mix), { type: "recovered" }));
    }
    return context.state === "running";
  }

  function readRecordingAudioCoverage(mix: RecordingAudioMix) {
    return {
      energySamples: mix.remoteEnergySamples,
      quietSamples: mix.remoteExpectedQuietSamples,
      expectedWindowSeen: mix.remoteExpectedWindowSeen,
      invalid: mix.remoteCoverageInvalid,
      verified: recordingHasBothAudioRef.current === true,
    };
  }

  function commitRecordingAudioCoverage(mix: RecordingAudioMix, state: ReturnType<typeof initialRecordingAudioCoverageState>) {
    mix.remoteEnergySamples = state.energySamples;
    mix.remoteExpectedQuietSamples = state.quietSamples;
    mix.remoteExpectedWindowSeen = state.expectedWindowSeen;
    mix.remoteCoverageInvalid = state.invalid;
    updateRecordingAudioCoverage(state.verified);
  }

  function verifyRecordingRemoteCoverageAtCompletion() {
    const mix = recordingAudioMixRef.current;
    if (
      !mix ||
      mix.remoteCoverageInvalid ||
      !mix.remoteExpectedWindowSeen ||
      !mix.remoteTrack ||
      mix.remoteTrack.readyState !== "live" ||
      mix.remoteTrack.muted ||
      mix.context.state !== "running"
    ) {
      updateRecordingAudioCoverage(false);
    }
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
      if (mix.remoteTrack) {
        if (mix.remoteTrackMuteHandler) mix.remoteTrack.removeEventListener("mute", mix.remoteTrackMuteHandler);
        if (mix.remoteTrackUnmuteHandler) mix.remoteTrack.removeEventListener("unmute", mix.remoteTrackUnmuteHandler);
        if (mix.remoteTrackEndedHandler) mix.remoteTrack.removeEventListener("ended", mix.remoteTrackEndedHandler);
        if (mix.remoteTrack !== remoteTracks[0]) invalidateRecordingRemoteCoverage("REMOTE_AUDIO_TRACK_REPLACED");
      }
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
      mix.remoteTrack = remoteTracks[0];
      mix.remoteEnergySamples = 0;
      mix.remoteExpectedQuietSamples = 0;
      const handleMute = () => invalidateRecordingRemoteCoverage("REMOTE_AUDIO_TRACK_MUTED");
      const handleUnmute = () => {
        mix.remoteEnergySamples = 0;
        mix.remoteExpectedQuietSamples = 0;
        void resumeRecordingAudioContext();
      };
      const handleEnded = () => invalidateRecordingRemoteCoverage("REMOTE_AUDIO_TRACK_ENDED");
      mix.remoteTrackMuteHandler = handleMute;
      mix.remoteTrackUnmuteHandler = handleUnmute;
      mix.remoteTrackEndedHandler = handleEnded;
      mix.remoteTrack.addEventListener("mute", handleMute);
      mix.remoteTrack.addEventListener("unmute", handleUnmute);
      mix.remoteTrack.addEventListener("ended", handleEnded);
      if (mix.context.state !== "running" && mix.context.state !== "closed") void resumeRecordingAudioContext();
      updateRecordingAudioCoverage(false);
      const samples = new Uint8Array(analyser.fftSize);
      mix.remoteMonitorTimer = window.setInterval(() => {
        if (recordingAudioMixRef.current !== mix || recorderRef.current?.state !== "recording") return;
        if (mix.context.state !== "running" || mix.remoteTrack?.readyState !== "live" || mix.remoteTrack.muted) {
          invalidateRecordingRemoteCoverage("REMOTE_AUDIO_MIX_NOT_RUNNING");
          return;
        }
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          sum += normalized * normalized;
        }
        const previousInvalid = mix.remoteCoverageInvalid;
        const nextCoverage = reduceRecordingAudioCoverage(readRecordingAudioCoverage(mix), {
          type: "sample",
          expected: isAssistantRecordingAudioExpected(),
          candidateSpeaking: isCandidateSpeaking(),
          contextRunning: mix.context.state === "running",
          trackLive: mix.remoteTrack?.readyState === "live",
          trackMuted: Boolean(mix.remoteTrack?.muted),
          rms: Math.sqrt(sum / samples.length),
        });
        commitRecordingAudioCoverage(mix, nextCoverage);
        if (nextCoverage.invalid && (!previousInvalid || !mix.remoteCoverageReported) && isAssistantRecordingAudioExpected()) {
          mix.remoteCoverageReported = true;
          reportRecordingRemoteCoverageIssue(previousInvalid ? "REMOTE_AUDIO_COVERAGE_INVALID" : "REMOTE_AUDIO_SILENT");
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
      recordingCompleteRef.current = false;
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
      recordingCompleteRef.current = false;
      setRecordingCaptureState("error");
      return;
    }
    if (options.resume) {
      // If the original recorder stopped, its encoded container is incomplete.
      // Starting a second MediaRecorder and concatenating containers would make
      // a seemingly successful but truncated recording. Keep the accepted v3
      // parts for staff recovery and require an explicit candidate restart.
      recordingCompleteRef.current = false;
      setRecordingCaptureState("error");
      setAudioNotice("録画が途中で終了したため、自動で別の録画へ切り替えません。採用担当者へ受付番号をお知らせください。");
      return;
    }
    setRecordingCaptureState("starting");
    updateRecordingAudioCoverage(null);
    // A reconnect (options.resume) restarts the MediaRecorder but must keep the
    // chunks captured before the disconnect so the final blob still contains the
    // full interview instead of only the segment recorded after recovery.
    if (!options.resume) {
      chunksRef.current = [];
      recordingLiveUploaderRef.current = null;
      recordingBytesRef.current = 0;
      recordingSizeCappedRef.current = false;
      recordingCompleteRef.current = false;
      recordingLocalContinuityValidRef.current = true;
    }
    // Each recorder belongs to one generation. A previous recorder's stop event
    // can still be queued when a reconnect starts a new one; without this guard
    // it would resolve the new promise with the pre-disconnect blob and the
    // interview would be uploaded truncated.
    const generation = recordingGenerationRef.current + 1;
    recordingGenerationRef.current = generation;
    const ownsRecording = () => recordingGenerationRef.current === generation;
    recordingCompleteRef.current = false;
    recordingFinalStopRequestedRef.current = false;
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
        const initialCoverage = initialRecordingAudioCoverageState();
        recordingAudioMixRef.current = {
          context: audioContext,
          destination,
          localSource,
          remoteSource: null,
          remoteAnalyser: null,
          remoteMonitorTimer: null,
          remoteTrack: null,
          remoteTrackMuteHandler: null,
          remoteTrackUnmuteHandler: null,
          remoteTrackEndedHandler: null,
          contextStateHandler: null,
          remoteEnergySamples: initialCoverage.energySamples,
          remoteExpectedQuietSamples: initialCoverage.quietSamples,
          remoteExpectedWindowSeen: initialCoverage.expectedWindowSeen,
          remoteCoverageInvalid: initialCoverage.invalid,
          remoteCoverageReported: false,
        };
        const mix = recordingAudioMixRef.current;
        const handleContextState = () => {
          if (mix.context.state !== "running" && mix.context.state !== "closed") {
            invalidateRecordingRemoteCoverage("REMOTE_AUDIO_CONTEXT_INTERRUPTED");
            void resumeRecordingAudioContext();
          }
        };
        mix.contextStateHandler = handleContextState;
        mix.context.addEventListener("statechange", handleContextState);
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
    let recordingCaptureFailed = false;
    for (const mimeType of candidates) {
      try {
        const recorder = new MediaRecorder(recordingStream, {
          mimeType,
          audioBitsPerSecond: 48_000,
          ...(hasVideo ? { videoBitsPerSecond: 360_000 } : {}),
        });
        const liveUploader = createLiveRecordingUploader({
          sessionId: sessionIdRef.current,
          accessToken: accessTokenRef.current,
          contentType: recorder.mimeType || mimeType,
          onProgress: setRecordingUploadProgress,
          onError: () => {
            setRecordingUploadState("error");
            setAudioNotice("録画データの送信が一時停止しています。未送信データをこの画面に保持しているため、画面を閉じずに面接を続けてください。");
          },
        });
        recorder.ondataavailable = (event) => {
          if (event.data.size <= 0 || recordingSizeCappedRef.current) return;
          const nextSize = recordingBytesRef.current + event.data.size;
          if (nextSize > MAX_CLIENT_RECORDING_BYTES) {
            recordingCaptureFailed = true;
            recordingSizeCappedRef.current = true;
            recordingCompleteRef.current = false;
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
          try {
            liveUploader.append(event.data);
          } catch {
            recordingCaptureFailed = true;
            recordingCompleteRef.current = false;
            setRecordingCaptureState("error");
            setRecordingUploadState("error");
            reportCandidateEvent("recording_unavailable", "LIVE_RECORDING_BUFFER_FAILED");
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
          recordingBytesRef.current = nextSize;
        };
        recorder.onerror = () => {
          if (!ownsRecording()) return;
          recordingCaptureFailed = true;
          recordingCompleteRef.current = false;
          setRecordingCaptureState("error");
          reportCandidateEvent("recording_unavailable", "RECORDER_ERROR");
          setAudioNotice("録画を継続できませんでした。面接記録の保存はまだ完了していません。採用担当者が記録状態を確認します。");
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
          if (recordingBytesRef.current <= 0) {
            recordingCompleteRef.current = false;
            setRecordingCaptureState("error");
            recordingResolveRef.current?.(null);
            recordingResolveRef.current = null;
            return;
          }
          // Version 3 owns the actual byte chunks and releases only durable
          // full parts. Keep a zero-byte completion token for the existing
          // finalization state machine instead of rebuilding the entire media
          // Blob in mobile RAM.
          const blob = new Blob([], {
            type: recorder.mimeType || (hasVideo ? "video/webm" : "audio/webm"),
          });
          // Retain partial bytes locally as incident evidence, but resolve the
          // upload promise with null unless the recorder stopped cleanly.
          recordingBlobRef.current = blob;
          if (
            recordingCaptureFailed ||
            recordingSizeCappedRef.current ||
            !recordingLocalContinuityValidRef.current ||
            !recordingFinalStopRequestedRef.current
          ) {
            recordingCompleteRef.current = false;
            recordingResolveRef.current?.(null);
            recordingResolveRef.current = null;
            return;
          }
          recordingCompleteRef.current = true;
          recordingResolveRef.current?.(blob);
          recordingResolveRef.current = null;
        };
        recorder.start(1_000);
        selectedRecorder = recorder;
        recorderRef.current = recorder;
        recordingLiveUploaderRef.current = liveUploader;
        setRecordingUploadState("uploading");
        setRecordingUploadProgress(0);
        void liveUploader.start();
        hasBothAudio = remoteStream ? attachRemoteAudioToRecording(remoteStream) : false;
        break;
      } catch {
        // Try the next browser-supported recording format.
      }
    }
    if (!selectedRecorder) {
      recordingCompleteRef.current = false;
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
    const readiness = cameraInterviewReadiness({
      embeddedBrowser,
      recoveryRequired: localMediaHealthRef.current.blocked,
      hasLiveVideo: activeStream.getVideoTracks().some((track) => track.readyState === "live"),
      hasLiveAudio: activeStream.getAudioTracks().some((track) => track.readyState === "live" && track.enabled),
      microphoneVerified: microphoneCheckPassedRef.current,
      speakerVerified: speakerTestState === "passed",
    });
    if (!readiness.ready) {
      setErrorMessage(`TD-CONN-CHECK: ${readiness.message}`);
      return;
    }
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
            interviewMode: "camera",
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
        setContinuity(null);
      }
      if (recordedInterviewSessionRef.current !== activeSessionId || !transcriptDraftWriterRef.current) {
        initializeTranscriptDraftWriter(
          { sessionId: activeSessionId, accessToken: activeAccessToken },
          "voice",
        );
      }
      await connectRealtime("voice", { sessionId: activeSessionId, accessToken: activeAccessToken });
    } catch {
      setStage("setup");
      setSetupPhase("error");
      setConnectionState("error");
      setNetworkAudioState("error");
      setRemoteAudioState("waiting");
      setErrorMessage("自然音声の回線を確認できなかったため、録画式へ切り替えます。録画にはカメラ映像と応募者の音声を保存し、端末で読む質問音声は含めず質問文を別に記録します。");
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
    recordedQuestionReadyRef.current = false;
    setRecordedQuestionReady(false);
    recordedQuestionTimerRef.current = window.setTimeout(() => {
      recordedQuestionTimerRef.current = null;
      if (!startRecordedAnswerCapture()) {
        recordedQuestionReadyRef.current = false;
        setRecordedQuestionReady(false);
        setConnectionState("error");
        return;
      }
      recordedQuestionReadyRef.current = true;
      setRecordedQuestionReady(true);
      setConnectionState("candidate-speaking");
    }, 2_800);
  }

  function startRecordedAnswerCapture() {
    const microphoneTrack = streamRef.current?.getAudioTracks().find((track) => track.readyState === "live");
    if (!microphoneTrack || typeof MediaRecorder === "undefined" || recordedAnswerRecorderRef.current) {
      setProcessingWarning("回答音声の保存を開始できませんでした。同じ質問のまま接続を確認してください。");
      return false;
    }
    const candidates = supportedRecordingMimeTypes(false, (mimeType) => MediaRecorder.isTypeSupported(mimeType));
    for (const mimeType of candidates) {
      try {
        const recorder = new MediaRecorder(new MediaStream([microphoneTrack]), {
          mimeType,
          audioBitsPerSecond: 48_000,
        });
        const chunks: Blob[] = [];
        const startedAt = Date.now();
        recordedAnswerChunksRef.current = chunks;
        recordedAnswerStartedAtRef.current = startedAt;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = () => {
          if (recordedAnswerRecorderRef.current === recorder) {
            recordedAnswerRecorderRef.current = null;
            recordedAnswerChunksRef.current = [];
            recordedAnswerStartedAtRef.current = null;
          }
          setProcessingWarning("回答音声の文字起こし用保存を継続できませんでした。面接は受領完了にせず、保存状態を確認します。");
        };
        recorder.start(1_000);
        recordedAnswerRecorderRef.current = recorder;
        return true;
      } catch {
        // Try the next independently playable audio container.
      }
    }
    setProcessingWarning("この端末で回答音声を文字起こし用に保存できません。面接は受領完了にせず、保存状態を確認します。");
    return false;
  }

  async function uploadRecordedAnswer(
    answerIndex: number,
    blob: Blob,
    credentials: InterviewCredentials,
  ): Promise<RecordedAnswerReceipt> {
    const response = await fetch("/api/interviews/recorded/answer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "X-Interview-Session": credentials.sessionId,
        "X-Recorded-Answer-Index": String(answerIndex),
        "X-Recorded-Answer-Bytes": String(blob.size),
        "Content-Type": blob.type.split(";")[0] || "audio/webm",
      },
      body: blob,
    });
    const data = (await response.json().catch(() => null)) as {
      stored?: boolean;
      transcribed?: boolean;
      pending?: boolean;
      answerIndex?: number;
      retryAfterSeconds?: number;
      error?: string;
    } | null;
    const exactReceipt = data?.stored === true && data.answerIndex === answerIndex;
    if (response.status === 200 && exactReceipt && data?.transcribed === true) {
      return { state: "completed", retryAfterSeconds: 0 };
    }
    if (
      response.status === 202 &&
      exactReceipt &&
      data?.transcribed === false &&
      data.pending === true
    ) {
      return {
        state: "pending",
        retryAfterSeconds: Math.max(1, Math.min(15, Number(data.retryAfterSeconds) || 5)),
      };
    }
    throw new Error(data?.error || "回答音声の文字起こしを完了できませんでした。");
  }

  async function retryRecordedAnswerTranscription(
    answerIndex: number,
    attemptsRemaining: number,
    credentials: { sessionId: string; accessToken: string },
  ): Promise<void> {
    if (attemptsRemaining <= 0) {
      throw new Error("回答音声の文字起こしが保留中です。しばらくしてから保存を再試行してください。");
    }
    const response = await fetch("/api/interviews/recorded/answer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "X-Interview-Session": credentials.sessionId,
        "X-Recorded-Answer-Index": String(answerIndex),
      },
    });
    const data = (await response.json().catch(() => null)) as {
      stored?: boolean;
      transcribed?: boolean;
      pending?: boolean;
      answerIndex?: number;
      retryAfterSeconds?: number;
      error?: string;
    } | null;
    const exactReceipt = data?.stored === true && data.answerIndex === answerIndex;
    if (response.status === 200 && exactReceipt && data?.transcribed === true) return;
    if (response.status === 202 && exactReceipt && data?.transcribed === false && data.pending === true) {
      const retrySeconds = Math.max(1, Math.min(15, Number(data.retryAfterSeconds) || 5));
      await new Promise((resolve) => window.setTimeout(resolve, retrySeconds * 1_000));
      return await retryRecordedAnswerTranscription(answerIndex, attemptsRemaining - 1, credentials);
    }
    if (response.status === 409) {
      // Staff recovery may have transcribed every durable answer and completed
      // the interview while this candidate retry was in flight. This status is
      // only a signal to verify the separate completion receipt, never success.
      throw new Error("RECORDED_ANSWER_SESSION_STATE_CONFLICT");
    }
    throw new Error(data?.error || "回答音声の文字起こしを完了できませんでした。");
  }

  function recordedAnswerCredentials(answerIndex: number, proposed?: InterviewCredentials) {
    const existing = recordedAnswerCredentialsRef.current.get(answerIndex);
    if (existing) return existing;
    const snapshot = proposed
      ? { sessionId: proposed.sessionId, accessToken: proposed.accessToken }
      : { sessionId: sessionIdRef.current, accessToken: accessTokenRef.current };
    recordedAnswerCredentialsRef.current.set(answerIndex, snapshot);
    return snapshot;
  }

  function trackRecordedAnswerUpload(
    answerIndex: number,
    register: () => Promise<RecordedAnswerReceipt>,
    proposedCredentials?: InterviewCredentials,
  ): RecordedAnswerUploadPromises {
    const credentials = recordedAnswerCredentials(answerIndex, proposedCredentials);
    const promises = splitRecordedAnswerUpload({
      register,
      afterRegistration: () => {
        // A stopped request from an abandoned/restarted interview must not mark
        // the same numeric answer index in the new session as registered.
        if (recordedAnswerCredentialsRef.current.get(answerIndex) === credentials) {
          recordedAnswerRegisteredRef.current.add(answerIndex);
        }
      },
      complete: async (receipt) => {
        if (receipt.state === "pending") {
          await new Promise((resolve) => window.setTimeout(resolve, receipt.retryAfterSeconds * 1_000));
          await retryRecordedAnswerTranscription(answerIndex, 3, credentials);
        }
        if (recordedAnswerCredentialsRef.current.get(answerIndex) === credentials) {
          recordedAnswerTranscribedRef.current.add(answerIndex);
        }
      },
    });
    recordedAnswerRegistrationPromisesRef.current.set(answerIndex, promises.registration);
    recordedAnswerCompletionPromisesRef.current.set(answerIndex, promises.completion);
    // The completion branch intentionally runs while registration, sealing and
    // recording upload proceed. Attach a handler now so a rejected background
    // retry is not reported as an unhandled promise before finalization awaits it.
    void promises.registration.catch(() => undefined);
    void promises.completion.catch(() => undefined);
    return promises;
  }

  function restartRecordedAnswerTranscription(answerIndex: number) {
    if (!recordedAnswerRegisteredRef.current.has(answerIndex)) {
      throw new Error("RECORDED_ANSWER_REGISTRATION_MISSING");
    }
    if (recordedAnswerTranscribedRef.current.has(answerIndex)) return Promise.resolve();
    const credentials = recordedAnswerCredentialsRef.current.get(answerIndex);
    if (!credentials) throw new Error("RECORDED_ANSWER_CREDENTIALS_MISSING");
    const completion = retryRecordedAnswerTranscription(answerIndex, 3, credentials).then(() => {
      if (recordedAnswerCredentialsRef.current.get(answerIndex) === credentials) {
        recordedAnswerTranscribedRef.current.add(answerIndex);
      }
    });
    recordedAnswerCompletionPromisesRef.current.set(answerIndex, completion);
    void completion.catch(() => undefined);
    return completion;
  }

  function resendRecordedAnswerRegistration(answerIndex: number) {
    const blob = recordedAnswerBlobsRef.current.get(answerIndex);
    const credentials = recordedAnswerCredentialsRef.current.get(answerIndex);
    if (!blob || !credentials) throw new Error("RECORDED_ANSWER_UPLOAD_MISSING");
    return trackRecordedAnswerUpload(
      answerIndex,
      () => uploadRecordedAnswer(answerIndex, blob, credentials),
      credentials,
    );
  }

  function finishRecordedAnswerCapture(answerIndex: number): RecordedAnswerUploadPromises {
    const credentials = recordedAnswerCredentials(answerIndex);
    const recorder = recordedAnswerRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return trackRecordedAnswerUpload(
        answerIndex,
        () => Promise.reject(new Error("RECORDED_ANSWER_AUDIO_MISSING")),
        credentials,
      );
    }
    recordedAnswerRecorderRef.current = null;
    const chunks = recordedAnswerChunksRef.current;
    const startedAt = recordedAnswerStartedAtRef.current;
    recordedAnswerChunksRef.current = [];
    recordedAnswerStartedAtRef.current = null;
    let resolveReceipt: (receipt: RecordedAnswerReceipt) => void = () => undefined;
    let rejectReceipt: (error: unknown) => void = () => undefined;
    const receipt = new Promise<RecordedAnswerReceipt>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    const promises = trackRecordedAnswerUpload(answerIndex, () => receipt, credentials);
    {
      let settled = false;
      const finishResolve = (value: RecordedAnswerReceipt) => {
        if (settled) return;
        settled = true;
        resolveReceipt(value);
      };
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        rejectReceipt(error);
      };
      recorder.onerror = () => finishReject(new Error("RECORDED_ANSWER_AUDIO_FAILED"));
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (!startedAt || Date.now() - startedAt < 500 || blob.size <= 0) {
          finishReject(new Error("RECORDED_ANSWER_AUDIO_MISSING"));
          return;
        }
        recordedAnswerBlobsRef.current.set(answerIndex, blob);
        uploadRecordedAnswer(answerIndex, blob, credentials).then(finishResolve, finishReject);
      };
      try {
        recorder.requestData();
        recorder.stop();
      } catch (error) {
        finishReject(error);
      }
    }
    return promises;
  }

  function discardRecordedAnswerCapture() {
    const recorder = recordedAnswerRecorderRef.current;
    recordedAnswerRecorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        recorder.stop();
      } catch {
        // The recorder may already be stopping during a connection reset.
      }
    }
    recordedAnswerChunksRef.current = [];
    recordedAnswerStartedAtRef.current = null;
    recordedAnswerRegistrationPromisesRef.current.clear();
    recordedAnswerCompletionPromisesRef.current.clear();
    recordedAnswerRegisteredRef.current.clear();
    recordedAnswerTranscribedRef.current.clear();
    recordedAnswerCredentialsRef.current.clear();
    recordedAnswerBlobsRef.current.clear();
    retryRecordedAnswersOnFinalizationRef.current = false;
  }

  function stopCurrentRecordedAnswerForTechnicalHold() {
    const recorder = recordedAnswerRecorderRef.current;
    recordedAnswerRecorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      // This answer was interrupted by an explicit stop/technical hold. Earlier
      // answer receipts stay durable, but this partial answer is never promoted
      // into the contiguous completed-answer set.
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        recorder.stop();
      } catch {
        // The recorder may already be stopping.
      }
    }
    recordedAnswerChunksRef.current = [];
    recordedAnswerStartedAtRef.current = null;
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
    if (
      localMediaHealthRef.current.blocked ||
      !microphoneCheckPassedRef.current ||
      speakerTestState !== "passed" ||
      !activeStream.getAudioTracks().some((track) => track.readyState === "live" && track.enabled)
    ) {
      setErrorMessage("TD-CONN-CHECK: マイクの実音量と確認音の再生を完了してから、録画式面接へ進んでください。");
      return;
    }
    if (
      recordingLiveUploaderRef.current ||
      recordingBytesRef.current > 0 ||
      recorderRef.current?.state === "recording"
    ) {
      // A running/started Version 3 upload owns one immutable byte stream and
      // uploadId. Starting fallback with a second MediaRecorder would either
      // conflict at the deterministic R2 keys or concatenate two media
      // containers into a file that appears complete but is truncated.
      setErrorMessage("TD-CONN-RECORDING: 通常音声方式の録画がすでに始まっているため、同じ受付番号で別の録画式へは切り替えません。通常音声方式へ再接続するか、採用担当者へ受付番号をお知らせください。");
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
      const firstQuestion = `TOKYO DOGSのオンライン一次面接です。オンライン採用担当者の茂木です。音声回線の予備方式で、画面の質問に声で回答し、話し終えたら次の質問へ進んでください。録画にはあなたの音声を保存し、この端末で読む質問音声は含めず、質問文を別に記録します。${RECORDED_FALLBACK_QUESTIONS[0]}`;
      const firstTurn: TranscriptTurn = {
        id: "recorded-fallback-question-1",
        speaker: "interviewer",
        text: firstQuestion,
        createdAt: new Date().toISOString(),
      };
      modeRef.current = "recorded-fallback";
      setMode("recorded-fallback");
      setRecordedQuestionIndex(0);
      startInterviewClock();
      setProcessingWarning("");
      transcriptRef.current = [firstTurn];
      setTranscript([firstTurn]);
      recordedInterviewSessionRef.current = activeSessionId;
      if (!options.continueCurrentAttempt) {
        recordedAnswerRegistrationPromisesRef.current.clear();
        recordedAnswerCompletionPromisesRef.current.clear();
        recordedAnswerRegisteredRef.current.clear();
        recordedAnswerTranscribedRef.current.clear();
        recordedAnswerCredentialsRef.current.clear();
        recordedAnswerBlobsRef.current.clear();
      }
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
    if (
      mode !== "recorded-fallback" ||
      !recordedQuestionReady ||
      !recordedQuestionReadyRef.current ||
      endingRef.current
    ) return;
    recordedQuestionReadyRef.current = false;
    setRecordedQuestionReady(false);
    const answerNumber = recordedQuestionIndex + 1;
    finishRecordedAnswerCapture(answerNumber);
    upsertTurn({
      id: `recorded-fallback-answer-${answerNumber}`,
      speaker: "candidate",
      text: `回答${answerNumber}の発言内容は録画音声に記録されています。自動文字起こし完了後、採用担当者が録画と照合します。`,
      createdAt: new Date().toISOString(),
    });
    if (timedMaximumRequestedRef.current || elapsed >= INTERVIEW_MAX_SECONDS) {
      await completeRecordedFallbackAtTimeLimit(true);
      return;
    }
    const nextIndex = recordedQuestionIndex + 1;
    if (nextIndex >= RECORDED_FALLBACK_QUESTIONS.length) {
      const closing = "オンライン一次面接は以上です。回答と録画は採用選考の重要な判断資料として、権限を付与された採用担当者が確認します。ご回答ありがとうございました。";
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
    const warningPrefix = timedActionRef.current === "warning"
      ? "開始から24分が経過しました。残り約3分ですので、必要な確認を絞って進めます。"
      : "";
    if (warningPrefix) {
      timedWarningDeliveredRef.current = true;
      timedActionRef.current = null;
      setTimeControlNotice("残り時間は約3分です。現在の回答を遮らず、必要な確認を絞って進めています。");
    }
    const nextQuestion = `${warningPrefix}${RECORDED_FALLBACK_QUESTIONS[nextIndex]}`;
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
    if (embeddedBrowser) {
      setErrorMessage("TD-CONN-WEBVIEW: カメラ・音声方式はLINEやSNS内の画面では開始できません。リンクをコピーし、SafariまたはChromeで開いてください。文字入力方式はこの画面でも利用できます。");
      return;
    }
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
    microphoneCheckPassedRef.current = false;
    microphoneVerificationRef.current = initialMicrophoneVerification();
    setMicrophoneCheckPassed(false);
    localMediaHealthRef.current = initialLocalMediaHealth();
    localMediaRecoveryAttemptedRef.current = false;
    setLocalMediaRecoveryRequired(false);
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
      bindLocalMicrophoneTrack(microphoneTrack);
      await startMicrophoneMeter(nextStream);
      void playPreparedAudio("/audio/motegi-devices-ready.mp3", {
        updateSpeakerTest: true,
        keepAudioPrimed: true,
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
  }

  async function startTextInterview() {
    if (!consent || sessionStarting) return;
    const preferredLocation = normalizePreferredLocation(location);
    if (!candidateName.trim()) {
      setErrorMessage("氏名を入力してください。");
      return;
    }
    if (!preferredLocation || preferredLocation.length > PREFERRED_LOCATION_MAX_LENGTH) {
      setErrorMessage("入職希望対象店舗を120文字以内で入力してください。");
      return;
    }
    setSessionStarting(true);
    setErrorMessage("");
    try {
      const access = inviteGate === "ok" ? "ok" : await checkInterviewAccess();
      setInviteGate(access);
      if (access !== "ok") throw new Error(INTERVIEW_ACCESS_MESSAGES[access]);
      const response = await fetch("/api/interviews/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateName,
          employment,
          location: preferredLocation,
          consent: true,
          interviewMode: "text",
          inviteToken: inviteTokenFromLocation(),
        }),
      });
      const data = (await response.json().catch(() => null)) as { sessionId?: string; accessToken?: string; error?: string } | null;
      if (!response.ok || !data?.sessionId || !data.accessToken) {
        throw new Error(data?.error || "オンライン一次面接の記録を準備できませんでした。");
      }
      accessTokenRef.current = data.accessToken;
      sessionIdRef.current = data.sessionId;
      setSessionId(data.sessionId);
      setContinuity(null);
      resetRealtimeTranscriptIntegrity();
      updateCompletionHold("none");
      const started = await fetch("/api/interviews/text/start", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${data.accessToken}`,
          "X-Interview-Session": data.sessionId,
        },
      });
      if (!started.ok) {
        const startData = (await started.json().catch(() => null)) as { error?: string } | null;
        throw new Error(startData?.error || "文字入力によるオンライン一次面接を開始できませんでした。");
      }
      const firstTurn: TranscriptTurn = {
        id: "text-interview-question-1",
        speaker: "interviewer",
        text: `TOKYO DOGSのオンライン一次面接です。オンライン採用担当者の茂木です。カメラとマイクを使用せず、文字入力で進めます。入力方法の違いは評価に使用しません。${TEXT_INTERVIEW_QUESTIONS[0]}`,
        createdAt: new Date().toISOString(),
      };
      modeRef.current = "text";
      setMode("text");
      setLocation(preferredLocation);
      startInterviewClock();
      transcriptRef.current = [firstTurn];
      setTranscript([firstTurn]);
      completedTranscriptRef.current = [firstTurn];
      initializeTranscriptDraftWriter(
        { sessionId: data.sessionId, accessToken: data.accessToken },
        "text",
      );
      setProcessingWarning("");
      try {
        await transcriptDraftWriterRef.current!.enqueue([firstTurn]);
      } catch {
        // A later append contains this exact first turn and the server accepts it
        // only as an append-only prefix. Finalization still fails closed unless
        // the complete snapshot receives an exact receipt.
        setProcessingWarning("最初の質問の途中保存を確認できませんでした。次の回答送信時と面接終了時に同じ受付番号で再確認します。");
      }
      setConnectionState("ready");
      setConnectionStep("ready");
      setRecordingUploadState("idle");
      setArchiveSyncState("idle");
      setCompletionSavePending(false);
      interviewFinalizationStoredRef.current = false;
      voiceTranscriptSealedRef.current = false;
      setStage("interview");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "文字入力によるオンライン一次面接を開始できませんでした。");
    } finally {
      setSessionStarting(false);
    }
  }

  async function openTextContinuity(next: InterviewContinuity) {
    const { snapshot, accessToken } = next;
    if (!(EMPLOYMENT_OPTIONS as readonly string[]).includes(snapshot.employment)) {
      throw new Error("保存済みの雇用形態を確認できませんでした。");
    }
    const firstTurn: TranscriptTurn = {
      id: "text-interview-question-1",
      speaker: "interviewer",
      text: `TOKYO DOGSのオンライン一次面接です。オンライン採用担当者の茂木です。カメラとマイクを使用せず、文字入力で進めます。入力方法の違いは評価に使用しません。${TEXT_INTERVIEW_QUESTIONS[0]}`,
      createdAt: new Date().toISOString(),
    };
    const resumedTurns = snapshot.transcript.length > 0 ? [...snapshot.transcript] : [firstTurn];
    const answered = resumedTurns.filter((turn) => turn.speaker === "candidate").length;
    const last = resumedTurns.at(-1);
    if (last?.speaker === "candidate" && answered < TEXT_INTERVIEW_QUESTIONS.length) {
      resumedTurns.push({
        id: `text-interview-question-${answered + 1}`,
        speaker: "interviewer",
        text: TEXT_INTERVIEW_QUESTIONS[answered],
        createdAt: new Date().toISOString(),
      });
    }

    accessTokenRef.current = accessToken;
    sessionIdRef.current = snapshot.sessionId;
    setSessionId(snapshot.sessionId);
    setCandidateName(snapshot.candidateName);
    setEmployment(snapshot.employment as (typeof EMPLOYMENT_OPTIONS)[number]);
    setLocation(snapshot.location);
    setConsent(true);
    setInterviewFormat("text");
    modeRef.current = "text";
    setMode("text");
    resetRealtimeTranscriptIntegrity();
    updateCompletionHold("none");
    startInterviewClock();
    transcriptRef.current = resumedTurns;
    setTranscript(resumedTurns);
    completedTranscriptRef.current = resumedTurns;
    initializeTranscriptDraftWriter(
      { sessionId: snapshot.sessionId, accessToken },
      "text",
    );
    await transcriptDraftWriterRef.current!.enqueue(resumedTurns);
    setTextDraft("");
    setProcessingWarning("途中保存済みの回答から再開しました。参加方法の変更は選考上の不利益に扱いません。");
    setErrorMessage("");
    setConnectionState("ready");
    setConnectionStep("ready");
    setRecordingUploadState("idle");
    setArchiveSyncState("idle");
    setCompletionSavePending(false);
    interviewFinalizationStoredRef.current = false;
    voiceTranscriptSealedRef.current = false;
    setContinuity(null);
    setStage("interview");
    if (last?.speaker === "candidate" && answered >= TEXT_INTERVIEW_QUESTIONS.length) {
      window.setTimeout(() => void completeInterview("text_interview_completed"), 0);
    }
  }

  async function resumeSavedInterview() {
    if (!continuity || sessionStarting || !networkAvailable) return;
    setSessionStarting(true);
    setErrorMessage("");
    try {
      let next = continuity;
      if (continuity.snapshot.action === "replace_with_text") {
        const response = await fetch("/api/interviews/resume", {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        const data = await response.json().catch(() => null) as {
          resumed?: boolean;
          accessToken?: string;
          snapshot?: InterviewContinuitySnapshot;
          error?: string;
        } | null;
        if (!response.ok || data?.resumed !== true || !data.accessToken || !data.snapshot) {
          throw new Error(data?.error || "保存済みの面接を文字入力へ切り替えられませんでした。");
        }
        next = { accessToken: data.accessToken, snapshot: data.snapshot };
      }
      if (next.snapshot.action !== "resume_text") {
        throw new Error("この面接は自動再開できません。受付番号を採用担当者へお伝えください。");
      }
      await openTextContinuity(next);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "途中保存した面接を再開できませんでした。");
    } finally {
      setSessionStarting(false);
    }
  }

  function startInternalTest() {
    stopRealtime();
    const id = `TD-TEST-${Date.now().toString(36).toUpperCase()}`;
    sessionIdRef.current = id;
    resetRealtimeTranscriptIntegrity();
    updateCompletionHold("none");
    const firstTurn: TranscriptTurn = {
      id: "internal-test-question-1",
      speaker: "interviewer",
      text: `この接続確認は選考対象外です。外部サービスには接続せず、入力内容も採用評価には使用しません。${INTERNAL_TEST_QUESTIONS[0]}`,
      createdAt: new Date().toISOString(),
    };
    setSessionId(id);
    modeRef.current = "internal-test";
    setMode("internal-test");
    startInterviewClock();
    setErrorMessage("");
    setProcessingWarning("");
    setArchiveSyncState("idle");
    setCompletionSavePending(false);
    interviewFinalizationStoredRef.current = false;
    voiceTranscriptSealedRef.current = false;
    transcriptRef.current = [firstTurn];
    setTranscript([firstTurn]);
    setConnectionState("ready");
    setConnectionStep("ready");
    setStage("interview");
  }

  function stopRealtime(options: { keepLocalStream?: boolean; keepRecorder?: boolean } = {}) {
    assistantAudioExpectedRef.current = false;
    assistantAudioExpectedUntilRef.current = 0;
    clearResponseWatchdog();
    clearCandidateResponseDelay();
    clearTimedActionTimer();
    timedResponseRef.current = null;
    recordedFallbackQuietSinceRef.current = null;
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
      streamRef.current?.getAudioTracks().forEach(unbindLocalMicrophoneTrack);
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
        // Only completeInterview sets endingRef before requesting stop. A
        // browser/OS track interruption can otherwise emit a clean onstop with
        // only the early part of the interview; never receipt that as complete.
        recordingFinalStopRequestedRef.current = endingRef.current;
        activeRecorder.stop();
      } catch {
        recordingFinalStopRequestedRef.current = false;
        recordingCompleteRef.current = false;
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
      streamRef.current?.getAudioTracks().forEach(unbindLocalMicrophoneTrack);
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
    const transcript = finalizationTranscript();
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
        transcript,
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

  function recordedAnswerIndexes() {
    // A capture is expected as soon as its split promises are installed. The
    // final MediaRecorder stop may still be producing its Blob, so using the
    // Blob map here would reintroduce a race before the registration promise.
    const answerIndexes = [...recordedAnswerRegistrationPromisesRef.current.keys()]
      .sort((left, right) => left - right);
    if (
      answerIndexes.length < 1 ||
      answerIndexes.length > RECORDED_FALLBACK_QUESTIONS.length ||
      answerIndexes.some((answerIndex, index) => answerIndex !== index + 1)
    ) {
      throw new Error("回答音声を保存できていません。面接記録の保存を再試行してください。");
    }
    return answerIndexes;
  }

  async function ensureRecordedAnswerRegistrations(retryMissing: boolean) {
    const answerIndexes = recordedAnswerIndexes();
    const registrations = answerIndexes.map((answerIndex) => {
      if (recordedAnswerRegisteredRef.current.has(answerIndex)) return Promise.resolve();
      const existing = recordedAnswerRegistrationPromisesRef.current.get(answerIndex);
      if (!retryMissing) {
        if (!existing) throw new Error("RECORDED_ANSWER_REGISTRATION_MISSING");
        return existing;
      }
      // This path is reached only from a visible retry action. If the first
      // request never received an exact D1/R2 receipt, replay the retained blob;
      // the server accepts only an identical SHA for the same answer index.
      return existing
        ? existing.catch(() => resendRecordedAnswerRegistration(answerIndex).registration)
        : resendRecordedAnswerRegistration(answerIndex).registration;
    });
    await Promise.all(registrations);
    if (answerIndexes.some((answerIndex) => !recordedAnswerRegisteredRef.current.has(answerIndex))) {
      throw new Error("RECORDED_ANSWER_REGISTRATION_MISSING");
    }
    return answerIndexes;
  }

  function exactRecordedAnswerCredentials(answerIndexes: number[]) {
    const first = recordedAnswerCredentialsRef.current.get(answerIndexes[0]);
    if (
      !first ||
      first.sessionId !== sessionIdRef.current ||
      first.accessToken !== accessTokenRef.current ||
      answerIndexes.some((answerIndex, offset) => {
        const credentials = recordedAnswerCredentialsRef.current.get(answerIndex);
        return answerIndex !== offset + 1 ||
          !credentials ||
          credentials.sessionId !== first.sessionId ||
          credentials.accessToken !== first.accessToken;
      })
    ) {
      throw new Error("RECORDED_ANSWER_CREDENTIALS_MISMATCH");
    }
    return first;
  }

  async function verifyConcurrentRecordedFallbackCompletion(answerIndexes: number[]) {
    // The local index collection is the one sealed earlier in this interview.
    // Recheck contiguous 1..N indexes and a single credential snapshot before
    // asking the completion endpoint for an idempotent receipt.
    const credentials = exactRecordedAnswerCredentials(answerIndexes);
    const response = await fetch("/api/interviews/recorded/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.accessToken}`,
      },
      body: JSON.stringify({
        sessionId: credentials.sessionId,
        questionCount: answerIndexes.length,
      }),
    });
    const data = await response.json().catch(() => null) as unknown;
    if (!isExactRecordedCompletionReplay(response.status, data)) {
      throw new Error("RECORDED_ANSWER_COMPLETION_REPLAY_UNVERIFIED");
    }
    for (const answerIndex of answerIndexes) {
      const current = recordedAnswerCredentialsRef.current.get(answerIndex);
      if (
        current?.sessionId !== credentials.sessionId ||
        current.accessToken !== credentials.accessToken
      ) {
        throw new Error("RECORDED_ANSWER_CREDENTIALS_MISMATCH");
      }
      recordedAnswerTranscribedRef.current.add(answerIndex);
    }
  }

  async function awaitRecordedAnswerTranscriptions(retryIncomplete: boolean) {
    const answerIndexes = await ensureRecordedAnswerRegistrations(retryIncomplete);
    const completions = answerIndexes.map((answerIndex) => {
      if (recordedAnswerTranscribedRef.current.has(answerIndex)) return Promise.resolve();
      const existing = recordedAnswerCompletionPromisesRef.current.get(answerIndex);
      if (!retryIncomplete) {
        if (!existing) throw new Error("RECORDED_ANSWER_TRANSCRIPTION_MISSING");
        return existing;
      }
      // Once registration is receipted, retries must be bodyless. R2 is the
      // durable source and resending candidate bytes would only increase risk.
      return existing
        ? existing.catch(() => restartRecordedAnswerTranscription(answerIndex))
        : restartRecordedAnswerTranscription(answerIndex);
    });
    const settled = await Promise.allSettled(completions);
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      const staffCompletionConflict = failures.some((failure) =>
        failure.reason instanceof Error &&
        failure.reason.message === "RECORDED_ANSWER_SESSION_STATE_CONFLICT"
      );
      if (!staffCompletionConflict) throw failures[0].reason;
      // A 409 on an individual answer remains failure unless this separate,
      // authenticated replay proves the exact session/count is already complete.
      await verifyConcurrentRecordedFallbackCompletion(answerIndexes);
      return { answerIndexes, completionAlreadyStored: true };
    }
    if (answerIndexes.some((answerIndex) => !recordedAnswerTranscribedRef.current.has(answerIndex))) {
      throw new Error("RECORDED_ANSWER_TRANSCRIPTION_MISSING");
    }
    return { answerIndexes, completionAlreadyStored: false };
  }

  async function completeRecordedFallback(retryIncomplete = false) {
    const { answerIndexes, completionAlreadyStored } = await awaitRecordedAnswerTranscriptions(retryIncomplete);
    if (completionAlreadyStored) return;
    const questionCount = answerIndexes.length;
    const response = await fetch("/api/interviews/recorded/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessTokenRef.current}`,
      },
      body: JSON.stringify({
        sessionId,
        questionCount,
      }),
    });
    const data = (await response.json().catch(() => null)) as {
      stored?: boolean;
      humanReviewRequired?: boolean;
      error?: string;
    } | null;
    if (response.status !== 200 || data?.stored !== true || data.humanReviewRequired !== true) {
      throw new Error(data?.error || "録画式面接の受付を完了できませんでした。");
    }
  }

  async function sealRecordedFallbackCompletion(retryMissingRegistration = false) {
    const answerIndexes = await ensureRecordedAnswerRegistrations(retryMissingRegistration);
    const expectedAnswerCount = answerIndexes.length;
    const response = await fetch("/api/interviews/recorded/seal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessTokenRef.current}`,
      },
      body: JSON.stringify({ sessionId, expectedAnswerCount }),
    });
    const data = (await response.json().catch(() => null)) as { sealed?: boolean; error?: string } | null;
    if (!response.ok || data?.sealed !== true) {
      throw new Error(data?.error || "回答数の完了情報を保存できませんでした。");
    }
  }

  async function sealVoiceTranscriptCompletion() {
    if (voiceTranscriptSealedRef.current) return;
    if (voiceTranscriptCompletionBlocker()) {
      throw new Error("回答音声の文字起こしに未完了の箇所があるため、面接記録の保存は完了していません。");
    }
    const transcript = finalizationTranscript();
    if (!transcript.some((turn) =>
      turn.speaker === "candidate" && turn.text.trim().length > 0
    )) {
      throw new Error("確定できる回答の文字起こしがありません。");
    }
    // Flush every completed turn and require the exact durable draft seal
    // before the legacy voice-completion seal can expose it to evaluation.
    await sealDurableTranscriptDraft("voice");
    const response = await fetch("/api/interviews/voice/transcript/seal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessTokenRef.current}`,
      },
      body: JSON.stringify({
        sessionId,
        transcript,
        transcriptionComplete: true,
      }),
    });
    const data = (await response.json().catch(() => null)) as { sealed?: boolean; error?: string } | null;
    if (!response.ok || data?.sealed !== true) {
      throw new Error(data?.error || "回答の文字起こしを確定できませんでした。");
    }
    voiceTranscriptSealedRef.current = true;
  }

  async function syncInterviewArchive(attempt = 0): Promise<void> {
    if (mode !== "text" && !recordingCompleteRef.current) {
      setArchiveSyncState("error");
      throw new Error("完全な録画を確認できないため、社内Drive格納を完了できません。");
    }
    if (attempt >= 120) {
      setArchiveSyncState("error");
      throw new Error("社内Driveへの格納確認が時間内に完了しませんでした。保存を再試行してください。");
    }
    setArchiveSyncState("syncing");
    try {
      const response = await fetch("/api/interviews/archive", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessTokenRef.current}`,
        },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await response.json().catch(() => null)) as {
        stored?: boolean;
        recordingIncluded?: boolean;
        transcriptAvailable?: boolean;
        transcriptKind?: string;
        pending?: boolean;
        retryAfterMs?: number;
        error?: string;
      } | null;
      if (response.ok && data?.pending === true) {
        const retryAfterMs = Math.max(100, Math.min(5_000, Number(data.retryAfterMs) || 250));
        await new Promise((resolve) => window.setTimeout(resolve, retryAfterMs));
        return await syncInterviewArchive(attempt + 1);
      }
      const needsRecording = mode !== "text";
      if (
        !response.ok ||
        !data?.stored ||
        data.transcriptAvailable !== true ||
        data.transcriptKind !== "actual_transcript" ||
        (needsRecording && data.recordingIncluded !== true)
      ) {
        throw new Error(data?.error || "面接記録の社内格納を完了できませんでした。");
      }
      setArchiveSyncState("stored");
    } catch (error) {
      setArchiveSyncState("error");
      throw error;
    }
  }

  async function uploadRecording(blob: Blob) {
    if (!recordingCompleteRef.current) {
      throw new Error("途中までの録画は送信できません。");
    }
    setRecordingUploadState("uploading");
    const audioCoverage = recordingHasBothAudioRef.current === true
      ? "both"
      : recordingHasBothAudioRef.current === false
        ? "candidate-only"
        : "unverified";
    const liveUploader = recordingLiveUploaderRef.current;
    if (liveUploader) {
      await liveUploader.finalize(audioCoverage);
      setRecordingUploadState("stored");
      return;
    }
    // Version 2 remains only for a page that was already open across the v3
    // rollout and still owns its finalized full Blob. New recordings always use
    // the live uploader above.
    setRecordingUploadProgress(0);
    await uploadRecordingResumably({
      blob,
      sessionId,
      accessToken: accessTokenRef.current,
      audioCoverage,
      onProgress: setRecordingUploadProgress,
    });
    setRecordingUploadState("stored");
  }

  async function storeInterviewFinalization() {
    if (interviewFinalizationStoredRef.current) return;
    if (mode === "voice" && voiceTranscriptCompletionBlocker()) {
      throw new Error("回答音声の文字起こしに未完了の箇所があるため、面接記録の保存は完了していません。");
    }
    if (!finalizationTranscript().some((turn) => turn.speaker === "candidate" && turn.text.trim().length > 0)) {
      throw new Error("評価に必要な回答記録がありません。オンライン一次面接を最初からお試しください。");
    }
    if (mode === "voice") await sealVoiceTranscriptCompletion();
    if (mode === "recorded-fallback") {
      await completeRecordedFallback(retryRecordedAnswersOnFinalizationRef.current);
    } else {
      if (mode === "text") await sealDurableTranscriptDraft("text");
      await requestEvaluation();
    }
    interviewFinalizationStoredRef.current = true;
  }

  function setArchiveCompletionMessage() {
    setProcessingWarning(
      mode === "recorded-fallback"
        ? "回答音声の自動文字起こしを根拠に評価補助を作成しました。採用担当者が録画と文字起こしを照合して最終判断し、録画・音声の品質は不利益に使用しません。"
        : "",
    );
  }

  async function retryRecordingUpload() {
    if (completionHoldRef.current !== "none") return;
    const blob = recordingBlobRef.current;
    if (!blob || recordingUploadState === "uploading") return;
    if (!recordingCompleteRef.current) {
      setProcessingWarning("録画が途中で終了したため、この録画を完了データとして送信できません。採用担当者へ受付番号をお知らせください。");
      setStage("review");
      return;
    }
    setStage("evaluating");
    try {
      if (mode === "voice") await sealVoiceTranscriptCompletion();
      if (mode === "recorded-fallback") await sealRecordedFallbackCompletion(true);
      await uploadRecording(blob);
    } catch {
      setRecordingUploadState("error");
      setProcessingWarning("録画の送信を完了できませんでした。下のボタンから再試行してください。");
      reportCandidateEvent("recording_unavailable", "UPLOAD_FAILED");
      setStage("review");
      return;
    }
    try {
      retryRecordedAnswersOnFinalizationRef.current = true;
      await storeInterviewFinalization();
      await syncInterviewArchive();
      setArchiveCompletionMessage();
      setCompletionSavePending(false);
    } catch {
      // The recording is already durable at this point. An evaluation or Drive
      // failure must not falsely return the recording itself to the error state.
      setProcessingWarning("面接記録の最終保存を完了できませんでした。下のボタンから再試行してください。");
    } finally {
      retryRecordedAnswersOnFinalizationRef.current = false;
      setStage("review");
    }
  }

  async function retryInterviewFinalization() {
    if (completionHoldRef.current !== "none") return;
    if (archiveSyncState === "syncing") return;
    if (mode !== "text" && !recordingCompleteRef.current) {
      setArchiveSyncState("error");
      setProcessingWarning("完全な録画を確認できないため、面接記録の最終保存は完了していません。採用担当者へ受付番号をお知らせください。");
      setStage("review");
      return;
    }
    setStage("evaluating");
    try {
      if (mode === "voice") await sealVoiceTranscriptCompletion();
      if (mode === "recorded-fallback") await sealRecordedFallbackCompletion(true);
      retryRecordedAnswersOnFinalizationRef.current = true;
      await storeInterviewFinalization();
      await syncInterviewArchive();
      setArchiveCompletionMessage();
      setCompletionSavePending(false);
    } catch {
      setProcessingWarning("面接記録の最終保存を完了できませんでした。下のボタンから再試行してください。");
    } finally {
      retryRecordedAnswersOnFinalizationRef.current = false;
      setStage("review");
    }
  }

  function runPendingCompletion() {
    const reason = pendingCompletionReasonRef.current;
    if (!reason) return;
    if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
    pendingCompletionTimerRef.current = null;
    pendingCompletionReasonRef.current = null;
    void completeInterview(reason);
  }

  function rearmPendingCompletionWhenVoiceSettled(delay: number) {
    if (!pendingCompletionReasonRef.current || modeRef.current !== "voice") return;
    if (!realtimeTranscriptIntegrityReady(realtimeTranscriptIntegrityRef.current)) return;
    if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
    pendingCompletionTimerRef.current = window.setTimeout(runPendingCompletion, delay);
  }

  function scheduleInterviewCompletion(reason: string, delay = 8_000) {
    if (endingRef.current || pendingCompletionReasonRef.current) return;
    pendingCompletionReasonRef.current = reason;
    pendingCompletionTimerRef.current = window.setTimeout(runPendingCompletion, delay);
  }

  function activateInterviewHold(hold: Exclude<CompletionHold, "none">) {
    if (endingRef.current || completionHoldRef.current !== "none") return false;
    // This local fence must be the first side effect. Candidate-event delivery
    // can hang after the server commits, while an already armed AI/time-limit
    // completion callback fires in the same tab.
    endingRef.current = true;
    updateCompletionHold(hold);
    if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
    pendingCompletionTimerRef.current = null;
    pendingCompletionReasonRef.current = null;
    clearResponseWatchdog();
    clearCandidateResponseDelay();
    clearTimedActionTimer();
    timedActionRef.current = null;
    timedResponseRef.current = null;
    setCompletionSavePending(true);
    setStage("evaluating");
    setConnectionState("idle");
    if (modeRef.current === "recorded-fallback") stopCurrentRecordedAnswerForTechnicalHold();
    stopRealtime();
    return true;
  }

  async function holdInterviewForStaffReview(
    hold: Exclude<CompletionHold, "none">,
    eventReceipt?: CandidateEventReceiptState,
  ) {
    let interruptedRecordingStored = modeRef.current === "text";
    try {
      if (modeRef.current !== "text") {
        await (recordingPromiseRef.current ?? Promise.resolve(recordingBlobRef.current));
        const liveUploader = recordingLiveUploaderRef.current;
        if (liveUploader) {
          const audioCoverage = recordingHasBothAudioRef.current === true
            ? "both"
            : recordingHasBothAudioRef.current === false
              ? "candidate-only"
              : "unverified";
          // Stopping for technical review is not interview completion, but the
          // exact bytes captured through that stop still need a durable receipt.
          // Finalizing only the recording keeps transcript/evaluation/Drive
          // blocked while preventing the last partial chunk from dying with the
          // browser tab.
          await liveUploader.finalize(audioCoverage);
          interruptedRecordingStored = true;
          setRecordingUploadState("stored");
        }
      }
    } finally {
      recordingCompleteRef.current = false;
      interviewFinalizationStoredRef.current = false;
      voiceTranscriptSealedRef.current = false;
      if (modeRef.current !== "text" && !interruptedRecordingStored) setRecordingUploadState("error");
      setArchiveSyncState("error");
      setCompletionSavePending(false);
      const recordingStatus = modeRef.current === "text"
        ? "入力済みの途中回答"
        : interruptedRecordingStored
          ? "中断時点までの録画"
          : "受領済みの途中録画パート";
      const common = `${recordingStatus}は技術確認用に保持しますが、面接完了・自動評価・社内Drive格納・受付完了には進めません。採用担当者へ受付番号をお知らせください。`;
      if (hold === "candidate_requested_stop") {
        setProcessingWarning(eventReceipt === "stored"
          ? `応募者による中止をサーバーに記録しました。${common}`
          : `応募者による中止を検知しましたが、サーバー記録の受領確認が取れませんでした。重複を避けるため自動再送は行いません。${common}`);
      } else if (hold === "safety_escalation") {
        setProcessingWarning(eventReceipt === "stored"
          ? `安全上の理由による中断をサーバーに記録しました。${common}`
          : `安全上の理由による中断を検知しましたが、サーバー記録の受領確認が取れませんでした。重複を避けるため自動再送は行いません。${common}`);
      } else if (hold === "completion_reason_invalid") {
        setProcessingWarning(`終了理由を安全に確認できないため技術保留にしました。${common}`);
      } else {
        setProcessingWarning(`回答音声の最終文字起こしを確認できないため技術保留にしました。${common}`);
      }
      setStage("review");
    }
  }

  async function enterInterviewHold(
    hold: Exclude<CompletionHold, "none">,
    event?: {
      type: "candidate_requested_stop" | "safety_escalation" | "completion_reason_invalid";
      code: string;
    },
  ) {
    await runStickyInterviewCompletionHold({
      activate: () => activateInterviewHold(hold),
      report: event ? () => reportCandidateEvent(event.type, event.code) : undefined,
      finalize: (receipt) => holdInterviewForStaffReview(hold, receipt),
    });
  }

  async function completeInterview(reason: string) {
    if (reason === "candidate_requested_stop") {
      await enterInterviewHold("candidate_requested_stop", {
        type: "candidate_requested_stop",
        code: "USER_ACTION",
      });
      return;
    }
    if (reason === "safety_escalation") {
      await enterInterviewHold("safety_escalation", {
        type: "safety_escalation",
        code: "MODEL_SAFETY_ESCALATION",
      });
      return;
    }
    if (endingRef.current || completionHoldRef.current !== "none") return;
    if (mode === "internal-test") {
      upsertTurn({
        id: `internal-test-complete-${Date.now()}`,
        speaker: "interviewer",
        text: "接続確認は以上です。この内容は選考や採用評価には使用しません。",
        createdAt: new Date().toISOString(),
      });
      setConnectionState("idle");
      setCompletionSavePending(false);
      setStage("review");
      void reason;
      return;
    }
    if (!SUCCESSFUL_COMPLETION_REASONS.has(reason)) {
      await enterInterviewHold("completion_reason_invalid", {
        type: "completion_reason_invalid",
        code: "UNKNOWN_COMPLETION_REASON",
      });
      return;
    }
    if (mode === "voice" && voiceTranscriptCompletionBlocker()) {
      await enterInterviewHold("transcript_incomplete");
      return;
    }
    if (pendingCompletionTimerRef.current) window.clearTimeout(pendingCompletionTimerRef.current);
    pendingCompletionTimerRef.current = null;
    pendingCompletionReasonRef.current = null;
    if (mode === "voice") verifyRecordingRemoteCoverageAtCompletion();
    endingRef.current = true;
    // From this point until the verified Drive receipt, leaving the page can
    // abandon bytes or finalization requests that no server has received yet.
    setCompletionSavePending(true);
    setStage("evaluating");
    setConnectionState("idle");
    if (mode === "recorded-fallback" && recordedAnswerRecorderRef.current) {
      const answerNumber = recordedQuestionIndex + 1;
      finishRecordedAnswerCapture(answerNumber);
      upsertTurn({
        id: `recorded-fallback-answer-${answerNumber}`,
        speaker: "candidate",
        text: `回答${answerNumber}の発言内容は録画音声に記録されています。自動文字起こし完了後、採用担当者が録画と照合します。`,
        createdAt: new Date().toISOString(),
      });
    }
    stopRealtime();
    // MediaRecorder.stop() finalizes its container asynchronously. Do not race it
    // against a short timer: a large iPhone MP4 can legitimately need more than six
    // seconds, and discarding that late blob permanently loses an otherwise valid
    // interview recording.
    const recordingBlob = await (
      recordingPromiseRef.current ?? Promise.resolve(recordingBlobRef.current)
    );
    const recordingComplete = mode === "text" || recordingCompleteRef.current;
    if (mode !== "text" && (!recordingBlob || !recordingComplete)) reportCandidateEvent("recording_unavailable", "NO_RECORDING_AT_COMPLETION");
    if (mode !== "text" && recordingBlob && recordingComplete && recordingHasBothAudioRef.current !== true) {
      reportCandidateEvent("recording_unavailable", "REMOTE_AUDIO_UNVERIFIED");
    }
    if (mode !== "text" && (!recordingBlob || !recordingComplete)) {
      setRecordingUploadState("error");
      setProcessingWarning("完全な録画データを端末で生成できなかったため、面接記録の保存は完了していません。採用担当者へ受付番号をお知らせください。");
      setStage("review");
      endingRef.current = false;
      return;
    }
    if (mode === "recorded-fallback") {
      try {
        // Seal the candidate's intended answer count before the large recording
        // upload. Staff recovery may only complete exactly this many answers.
        await sealRecordedFallbackCompletion();
      } catch {
        setRecordingUploadState("error");
        setProcessingWarning("回答数の完了情報を保存できませんでした。下のボタンから再試行してください。");
        setStage("review");
        endingRef.current = false;
        return;
      }
    } else if (mode === "voice") {
      try {
        // Persist the actual transcript before the large recording upload. If
        // the browser closes after the final part, staff recovery can now prove
        // that this was a cleanly completed voice interview before receipting it.
        await sealVoiceTranscriptCompletion();
      } catch {
        setRecordingUploadState("error");
        setProcessingWarning("回答の文字起こしを確定できませんでした。下のボタンから再試行してください。");
        setStage("review");
        endingRef.current = false;
        return;
      }
    }
    // Do not let evaluation completion start the Drive archive before the
    // recording artifact is durable. Both operations were awaited eventually,
    // but running them concurrently allowed a permanent video-less archive.
    let completionPhase: "recording" | "evaluation" | "archive" = "recording";
    let recordingStored = mode === "text";
    try {
      if (mode !== "text" && recordingBlob) {
        await uploadRecording(recordingBlob);
        recordingStored = true;
      }
      completionPhase = "evaluation";
      await storeInterviewFinalization();
      completionPhase = "archive";
      await syncInterviewArchive();
      setArchiveCompletionMessage();
      setCompletionSavePending(false);
      setStage("review");
    } catch (error) {
      if (completionPhase === "recording" && !recordingStored && mode !== "text") {
        setRecordingUploadState("error");
        reportCandidateEvent("recording_unavailable", "UPLOAD_FAILED");
      }
      setProcessingWarning(
        completionPhase === "recording"
          ? "録画の送信を完了できませんでした。下のボタンから再試行してください。"
          : completionPhase === "evaluation"
            ? "回答記録の整理を完了できませんでした。下のボタンから再試行してください。"
            : "社内Driveへの最終格納を完了できませんでした。下のボタンから再試行してください。",
      );
      setStage("review");
      void error;
    } finally {
      endingRef.current = false;
      void reason;
    }
  }

  function handleRealtimeEvent(event: RealtimeEvent) {
    const type = event.type ?? "";
    if (type === "input_audio_buffer.committed") {
      applyRealtimeTranscriptIntegrity(event);
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      applyRealtimeTranscriptIntegrity(event);
      assistantAudioExpectedRef.current = false;
      assistantAudioExpectedUntilRef.current = 0;
      applyTurnTaking("candidate_speech_started");
      setConnectionState("candidate-speaking");
      setCandidateAudioState("detected");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      applyRealtimeTranscriptIntegrity(event);
      const timedActionPending = Boolean(timedActionRef.current || timedResponseRef.current);
      const { state } = applyTurnTaking("candidate_speech_stopped", {
        suppressNextQuestion: timedActionPending,
      });
      setCandidateAudioState("ready");
      if (timedActionPending) scheduleTimedVoiceResponse();
      // When a response was still in flight the next question is scheduled by
      // response.done instead, so the candidate is never left waiting silently.
      if (state.candidateTurnPending) setConnectionState("ai-speaking");
      return;
    }
    if (type === "response.created") {
      applyRealtimeTranscriptIntegrity(event);
      currentAssistantAudioItemRef.current = "";
      assistantAudioStartedAtRef.current = null;
      applyTurnTaking("response_created");
      setConnectionState(isCandidateSpeaking() ? "candidate-speaking" : "ai-speaking");
      setNetworkAudioState("connected");
      return;
    }
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      markAssistantRecordingAudioExpected(true);
      if (event.item_id && !currentAssistantAudioItemRef.current) {
        currentAssistantAudioItemRef.current = event.item_id;
      }
      if (assistantAudioStartedAtRef.current === null) assistantAudioStartedAtRef.current = Date.now();
      if (!isCandidateSpeaking()) void resumeRemoteAudio(false);
      return;
    }
    if (type === "response.done") {
      applyRealtimeTranscriptIntegrity(event);
      markAssistantRecordingAudioExpected(false);
      const timedResponse = timedResponseRef.current;
      const completionPending = Boolean(pendingCompletionReasonRef.current);
      const { scheduledNextQuestion } = applyTurnTaking("response_done", {
        suppressNextQuestion: completionPending || Boolean(timedResponse) || Boolean(timedActionRef.current),
      });
      if (timedResponse) {
        finishTimedVoiceResponse(timedResponse);
        setNetworkAudioState("connected");
        return;
      }
      if (completionPending) {
        rearmPendingCompletionWhenVoiceSettled(1_200);
        return;
      }
      if (!scheduledNextQuestion) {
        setConnectionState(isCandidateSpeaking() ? "candidate-speaking" : "ready");
      }
      setNetworkAudioState("connected");
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      applyRealtimeTranscriptIntegrity(event);
      const text = event.transcript?.trim();
      const itemId = event.item_id?.trim();
      if (!text || !itemId) {
        voiceTranscriptionFailureRef.current = true;
        setCandidateAudioState("ready");
        void reportCandidateEvent("transcription_failed", text ? "TRANSCRIPTION_ID_MISSING" : "TRANSCRIPTION_EMPTY");
        setAudioNotice("回答音声の最終文字起こしを確認できませんでした。面接を完了扱いにせず、受領済み記録を技術確認に回します。");
        return;
      }
      recordCompletedTurn({
        id: itemId,
        speaker: "candidate",
        text,
        createdAt: new Date().toISOString(),
      });
      rearmPendingCompletionWhenVoiceSettled(250);
      return;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      applyRealtimeTranscriptIntegrity(event);
      voiceTranscriptionFailureRef.current = true;
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
      if (isAssistantDelta) markAssistantRecordingAudioExpected(true);
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
        const turn = { id, speaker: "interviewer" as const, text, createdAt: new Date().toISOString() };
        if (isAssistantDone) recordCompletedTurn(turn);
        else upsertTurn(turn);
      }
      return;
    }

    if (isCompleteInterviewEvent(event)) {
      const callId = event.call_id || event.item?.call_id;
      if (!callId || processedCompletionCallsRef.current.has(callId)) return;
      processedCompletionCallsRef.current.add(callId);
      const completionArguments = parseCompletionArguments(event);
      const completion = validateCompletionArguments(completionArguments);
      const completionReason = completionArguments.completion_reason;
      const modelAssertedCandidateStop = completionReason === "candidate_requested_stop";
      if (callId && channelRef.current?.readyState === "open") {
        channelRef.current.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({
              accepted: completion.accepted && !modelAssertedCandidateStop,
              missing_topic_ids: completion.missingTopicIds,
            }),
          },
        }));
      }
      if (!completionReason || ![
        "all_topics_covered",
        "candidate_requested_stop",
        "safety_escalation",
      ].includes(completionReason)) {
        void completeInterview("completion_reason_invalid");
        return;
      }
      // Compatibility fence for a page that was already open when the tool
      // schema changed. A model function call can never prove a candidate UI
      // action, so continue the interview and require the visible stop button.
      if (modelAssertedCandidateStop) {
        channelRef.current?.send(JSON.stringify({
          type: "response.create",
          response: {
            instructions: "応募者本人が画面の「面接を中止」ボタンを押していないため、面接を中止しないでください。終了案内はせず、直前の回答を踏まえて次の未確認テーマを一つだけ質問してください。",
          },
        }));
        armResponseWatchdog(true);
        return;
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
      if (completionReason === "safety_escalation") {
        void completeInterview("safety_escalation");
      } else if (completionReason === "all_topics_covered") {
        scheduleInterviewCompletion("ai_completed");
      } else {
        scheduleInterviewCompletion("completion_reason_invalid");
      }
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
        const timedResponse = timedResponseRef.current;
        applyTurnTaking("response_cancel_rejected", {
          suppressNextQuestion: Boolean(timedResponse) || Boolean(timedActionRef.current),
        });
        if (timedResponse) finishTimedVoiceResponse(timedResponse);
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
    if (completionHoldRef.current !== "none") return;
    const activeSessionId = credentials?.sessionId ?? sessionId;
    // Reconnecting to the same interview session must not discard the transcript and
    // recording already captured before the disconnect (TD-CONN-* recovery paths reuse
    // the same session id). Only a genuinely new session starts from a blank record.
    const isNewInterviewSession = isNewInterviewRecord(recordedInterviewSessionRef.current, activeSessionId);
    modeRef.current = selectedMode;
    setMode(selectedMode);
    setErrorMessage("");
    setAudioNotice("");
    setConnectionState("connecting");
    setNetworkAudioState("connecting");
    setRemoteAudioState(selectedMode === "voice" ? "waiting" : "idle");
    setConnectionStep("voice");
    setStage("interview");
    if (isNewInterviewSession) {
      recordingCompleteRef.current = false;
      resetRealtimeTranscriptIntegrity();
      updateCompletionHold("none");
      startInterviewClock();
      setArchiveSyncState("idle");
      setCompletionSavePending(false);
      interviewFinalizationStoredRef.current = false;
      voiceTranscriptSealedRef.current = false;
      transcriptRef.current = [];
      setTranscript([]);
      completedTranscriptRef.current = [];
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
            instructions: `「TOKYO DOGSのオンライン一次面接です。オンライン採用担当者の茂木です。この面接は音声システムで進行します」と音声で開始してください。自分の名前には敬称を付けず、茂木または私と表現してください。15〜25分の面接であることと、回答が採用選考の重要な判断資料になることを短く説明してください。案内の直後は、追加の前置きや複数の確認を入れず「${LIGHT_OPENING_QUESTION}」だけを質問してください。実在する人間がライブで参加しているとは説明しないでください。`,
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
    const candidateTurn: TranscriptTurn = {
      id,
      speaker: "candidate",
      text,
      createdAt: new Date().toISOString(),
    };

    if (mode === "internal-test") {
      upsertTurn(candidateTurn);
      setTextDraft("");
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

    if (mode === "text") {
      // Receipt the submitted answer immediately; the following question is a
      // second append-only snapshot. This closes the mobile-kill window during
      // the short UI transition between the two completed turns.
      recordCompletedTurn(candidateTurn);
      setTextDraft("");
      if (timedMaximumRequestedRef.current || elapsed >= INTERVIEW_MAX_SECONDS) {
        window.setTimeout(() => void completeInterview("text_max_duration_reached"), 450);
        return;
      }
      const answered = transcriptRef.current.filter((turn) => turn.speaker === "candidate").length;
      const nextQuestion = TEXT_INTERVIEW_QUESTIONS[answered];
      setConnectionState("ai-speaking");
      window.setTimeout(() => {
        if (nextQuestion) {
          recordCompletedTurn({
            id: `text-interview-question-${answered + 1}`,
            speaker: "interviewer",
            text: nextQuestion,
            createdAt: new Date().toISOString(),
          });
          setConnectionState("ready");
        } else {
          void completeInterview("text_interview_completed");
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
    try {
      channel.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      }));
      // Only a candidate message accepted by the open data channel becomes a
      // completed durable turn. A failed send remains in the input box.
      recordCompletedTurn(candidateTurn);
      setTextDraft("");
      channel.send(JSON.stringify({ type: "response.create" }));
    } catch {
      setConnectionState("error");
      setNetworkAudioState("error");
      setErrorMessage("TD-CONN-DATA: 回答を送信できませんでした。接続をやり直してください。");
      return;
    }
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
    discardRecordedAnswerCapture();
    stopRealtime();
    resetTimedInterviewControl();
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
    completedTranscriptRef.current = [];
    transcriptDraftWriterRef.current = null;
    processedCompletionCallsRef.current.clear();
    attemptedCandidateEventsRef.current.clear();
    reportedCandidateEventsRef.current.clear();
    turnStateRef.current = initialTurnTakingState();
    pendingCancelEventsRef.current.clear();
    recordedInterviewSessionRef.current = null;
    setProcessingWarning("");
    setErrorMessage("");
    recordingBlobRef.current = null;
    recordingLiveUploaderRef.current = null;
    recordingPromiseRef.current = null;
    recordingResolveRef.current = null;
    recordingBytesRef.current = 0;
    recordingSizeCappedRef.current = false;
    recordingCompleteRef.current = false;
    recordingFinalStopRequestedRef.current = false;
    recordingLocalContinuityValidRef.current = true;
    resetRealtimeTranscriptIntegrity();
    updateCompletionHold("none");
    recordingGenerationRef.current += 1;
    setRecordingUploadState("idle");
    setRecordingUploadProgress(0);
    setArchiveSyncState("idle");
    setCompletionSavePending(false);
    interviewFinalizationStoredRef.current = false;
    voiceTranscriptSealedRef.current = false;
    setRecordingCaptureState("idle");
    updateRecordingAudioCoverage(null);
    setScreenCaptureState("idle");
    setSetupPhase("idle");
    setMicrophoneLevel(0);
    microphoneCheckPassedRef.current = false;
    microphoneVerificationRef.current = initialMicrophoneVerification();
    setMicrophoneCheckPassed(false);
    localMediaHealthRef.current = initialLocalMediaHealth();
    localMediaRecoveryAttemptedRef.current = false;
    setLocalMediaRecoveryRequired(false);
    setCandidateAudioState("idle");
    setRemoteAudioState("idle");
    setNetworkAudioState("idle");
    setAudioNotice("");
    setIsMuted(false);
  }

  function restartConnection() {
    discardRecordedAnswerCapture();
    stopRealtime();
    resetTimedInterviewControl();
    accessTokenRef.current = "";
    setSessionId("TD-PENDING");
    sessionIdRef.current = "TD-PENDING";
    setConnectionState("idle");
    setConnectionStep("idle");
    setElapsed(0);
    transcriptRef.current = [];
    setTranscript([]);
    completedTranscriptRef.current = [];
    transcriptDraftWriterRef.current = null;
    processedCompletionCallsRef.current.clear();
    attemptedCandidateEventsRef.current.clear();
    reportedCandidateEventsRef.current.clear();
    turnStateRef.current = initialTurnTakingState();
    pendingCancelEventsRef.current.clear();
    // A restart issues a brand new interview id, so the next connection must not
    // resume the abandoned transcript and recording chunks.
    recordedInterviewSessionRef.current = null;
    chunksRef.current = [];
    recordingBytesRef.current = 0;
    recordingSizeCappedRef.current = false;
    recordingCompleteRef.current = false;
    recordingFinalStopRequestedRef.current = false;
    recordingLocalContinuityValidRef.current = true;
    resetRealtimeTranscriptIntegrity();
    updateCompletionHold("none");
    recordingGenerationRef.current += 1;
    recordingBlobRef.current = null;
    recordingLiveUploaderRef.current = null;
    recordingPromiseRef.current = null;
    recordingResolveRef.current = null;
    setTextDraft("");
    setRecordingUploadState("idle");
    setRecordingUploadProgress(0);
    setArchiveSyncState("idle");
    setCompletionSavePending(false);
    interviewFinalizationStoredRef.current = false;
    voiceTranscriptSealedRef.current = false;
    setRecordingCaptureState("idle");
    setScreenCaptureState("idle");
    setSetupPhase("idle");
    setMicrophoneLevel(0);
    microphoneCheckPassedRef.current = false;
    microphoneVerificationRef.current = initialMicrophoneVerification();
    setMicrophoneCheckPassed(false);
    localMediaHealthRef.current = initialLocalMediaHealth();
    localMediaRecoveryAttemptedRef.current = false;
    setLocalMediaRecoveryRequired(false);
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

      {!networkAvailable && (
        <div className="network-continuity-banner" role="status">
          <strong>通信が切れています</strong>
          <span>この画面は閉じずにお待ちください。通信が戻ると、保存済みの受付番号で途中保存を再確認します。</span>
        </div>
      )}

      {stage === "intro" && (
        <section className="intro-layout">
          <div className="intro-copy">
            <p className="eyebrow">共に歩む仲間達へ</p>
            <h1>あなたのことを、<br />あなたらしく話してください。</h1>
            <p className="lead">
              TOKYO DOGSの採用選考におけるオンライン一次面接です。これまでの経験、仕事選びの考え方、働き方の希望について、オンライン採用担当者の茂木が順番にお伺いします。カメラ・音声または文字入力で参加できます。
            </p>
            <div className="intro-interviewer">
              <img src="/interviewer-mogi.jpg" alt="TOKYO DOGS オンライン採用担当者 茂木" />
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
            {continuityChecking && <p className="continuity-checking" role="status">この端末の途中保存を確認しています…</p>}
            {continuity && (
              <div className={`continuity-card ${continuity.snapshot.action}`} role="status">
                <strong>
                  {continuity.snapshot.action === "completed"
                    ? "この端末の面接は受付済みです"
                    : continuity.snapshot.action === "processing"
                      ? "面接記録をサーバーで整理中です"
                      : continuity.snapshot.action === "held"
                        ? "採用担当者による確認が必要です"
                        : "途中保存した面接があります"}
                </strong>
                <span>受付番号 {continuity.snapshot.sessionId}</span>
                <p>
                  {continuity.snapshot.action === "resume_text"
                    ? "保存済みの質問・回答から、文字入力でそのまま再開できます。"
                    : continuity.snapshot.action === "replace_with_text"
                      ? "音声・録画の保存済み部分は上書きせず保全し、文字入力へ安全に切り替えて続けられます。"
                      : continuity.snapshot.action === "processing"
                        ? "新しい面接を作らず、この受付番号の処理完了をお待ちください。"
                        : continuity.snapshot.action === "completed"
                          ? "新しい面接を重複作成する必要はありません。"
                          : "自動で上書きせず停止しています。受付番号を採用担当者へお伝えください。"}
                </p>
                {(continuity.snapshot.action === "resume_text" || continuity.snapshot.action === "replace_with_text") && (
                  <button type="button" disabled={sessionStarting || !networkAvailable} onClick={() => void resumeSavedInterview()}>
                    {sessionStarting ? "途中保存を確認中…" : !networkAvailable ? "通信の復帰を待っています" : "保存済みの面接を再開"}
                  </button>
                )}
              </div>
            )}
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
            <span className="field-label" id="interview-format-label">参加方法</span>
            <div className="interview-format-control" role="group" aria-labelledby="interview-format-label">
              <button type="button" className={interviewFormat === "camera" ? "active" : ""} aria-pressed={interviewFormat === "camera"} onClick={() => { setInterviewFormat("camera"); setConsent(false); }}><strong>カメラ・音声</strong><span>茂木と自然な音声で進行</span></button>
              <button type="button" className={interviewFormat === "text" ? "active" : ""} aria-pressed={interviewFormat === "text"} onClick={() => { setInterviewFormat("text"); setConsent(false); }}><strong>文字入力</strong><span>カメラ・マイク不要</span></button>
            </div>
            {interviewFormat === "text" && <p className="accommodation-note">配慮が必要な理由の入力は不要です。質問内容と採用担当者による確認方法は共通で、入力方法の違いを不利益に扱いません。</p>}
            <label className={`consent-line ${consent ? "checked" : ""}`} htmlFor="selection-consent">
              <input id="selection-consent" type="checkbox" checked={consent} aria-describedby="consent-summary consent-detail-summary" onChange={(event) => setConsent(event.target.checked)} />
              <span className="consent-copy">
                <strong>{interviewFormat === "camera" ? "録画・文字起こし・選考利用に同意する" : "回答内容・選考利用に同意する"}</strong>
                <span id="consent-summary">{interviewFormat === "camera" ? "通常音声方式は映像・双方の音声・回答内容を記録します。予備の録画式は映像・応募者音声と質問文を記録します。" : "文字で入力した回答内容を、採用選考と記録の照合に使用します。カメラ・マイク・録画は使用しません。"}</span>
                <small>評価は権限を付与された採用担当者だけが確認し、求職者には表示されません。</small>
              </span>
            </label>
            <details className="consent-details"><summary id="consent-detail-summary">記録とデータの詳しい取り扱い</summary><div><p><strong>利用目的</strong><br />入力した氏名は採用記録の照合と保存管理に使用します。{interviewFormat === "camera" ? "通常音声方式の録画はカメラ映像と応募者・茂木の双方の音声を含みます。音声回線の予備方式へ切り替わった場合は、カメラ映像と応募者の音声を録画し、質問は画面の文面として別に保存します。端末で読み上げる質問音声は予備方式の録画には含まれません。これらを接客ロールプレイなどの職務関連行動、文字起こしの照合、通信トラブル時の記録確認に使用します。" : "文字入力方式では、入力した回答を職務関連の確認と記録作成に使用し、映像・音声は取得しません。"}</p><p><strong>処理と閲覧</strong><br />{interviewFormat === "camera" ? "音声と回答" : "回答"}は外部の文字処理サービスで処理されます。氏名、{interviewFormat === "camera" ? "録画、文字起こし、" : "回答記録、"}評価補助は権限を付与された採用担当者が確認します。自動処理だけで合否を決定しません。</p><p><strong>保管</strong><br />氏名、{interviewFormat === "camera" ? "録画、文字起こし、" : "回答記録、"}評価補助は、面接実施日から原則1年間を保存見直し期限として管理します。選考継続、法令対応、採用後の労務管理など継続利用が必要な場合を除き、期限後は採用責任者が削除対象を確認します。削除や開示等のご相談は、応募時に利用した連絡経路で採用担当者へご連絡ください。</p><p><strong>公平性とご相談</strong><br />笑顔の有無、顔立ち・容姿、服装、背景、カメラ・音声品質、声質、障害・健康状態の推測は評価しません。参加方法や技術不具合は不利益に扱わず、情報不足として採用担当者が確認します。面接中も中止できます。</p></div></details>
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
            {interviewFormat === "camera" && <div className={`speaker-test ${speakerTestState}`}>
              <div><strong>端末の音声を確認</strong><span>{speakerTestState === "playing" ? "音声を再生しています" : speakerTestState === "played" ? "聞こえた場合は、下の確認ボタンを押してください" : speakerTestState === "passed" ? "確認音が聞こえたことを確認済みです" : speakerTestState === "error" ? "端末の音量設定をご確認ください" : "開始前に茂木の確認音声を聞けます"}</span></div>
              <button type="button" onClick={playSpeakerTest}>{speakerTestState === "idle" ? "音声を確認" : "もう一度聞く"}</button>
              {speakerTestState === "played" && <button type="button" onClick={confirmSpeakerHeard}>音が聞こえました</button>}
            </div>}
            <ol className="connection-guide">
              <li><strong>1. 同意欄をチェック</strong><span>{interviewFormat === "camera" ? "録画・文字起こし・選考利用" : "回答内容・選考利用"}を確認して、同意欄を押します。</span></li>
              <li><strong>2. 開始ボタンを押す</strong><span>{interviewFormat === "camera" ? "表示される確認画面で、カメラとマイクの「許可」を選びます。" : "カメラやマイクの許可画面は表示されません。"}</span></li>
              <li><strong>3. オンライン一次面接を開始</strong><span>{interviewFormat === "camera" ? "映像とマイク入力を自動確認し、そのまま面接へ接続します。" : "画面の質問を読み、回答欄へ文字で入力します。"}</span></li>
            </ol>
            {inviteGate !== "checking" && inviteGate !== "ok" && (
              <div className="invite-required-notice" role="alert">
                <strong>{inviteGate === "missing" ? "専用リンクからお進みください" : "この専用リンクではお進みいただけません"}</strong>
                <span>{INTERVIEW_ACCESS_MESSAGES[inviteGate]}</span>
                <small>カメラ・マイクの許可は必要ありません。下の「接続確認（選考対象外）」は、この状態でもお使いいただけます。</small>
              </div>
            )}
            {errorMessage && <div className="inline-error" role="alert">{errorMessage}</div>}
            <button className="primary-action" aria-label={interviewFormat === "camera" ? "カメラ・マイクを確認して開始" : "文字入力で開始"} disabled={!networkAvailable || inviteGate !== "ok" || !candidateName.trim() || !normalizePreferredLocation(location) || !consent || sessionStarting || (interviewFormat === "camera" && embeddedBrowser)} onClick={() => void (interviewFormat === "camera" ? prepareInterview() : startTextInterview())}>
              {inviteGate === "checking" ? "専用リンクを確認中…" : sessionStarting ? "オンライン一次面接を準備中…" : interviewFormat === "camera" && embeddedBrowser ? "SafariまたはChromeで開いてください" : interviewFormat === "camera" ? "カメラ・マイクを確認して開始" : "文字入力でオンライン一次面接を開始"} <span>→</span>
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
            <div className="microphone-meter" role="meter" aria-label="マイク入力レベル" aria-valuemin={0} aria-valuemax={100} aria-valuenow={microphoneLevel}>
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
            {localMediaRecoveryRequired && (
              <div className="recorded-fallback-card" role="alert" aria-live="assertive">
                <strong>マイク接続が変化したため、面接を停止しました</strong>
                <span>自動で別のマイクへ切り替えたり、質問を進めたりしません。下のボタンを押してマイクを再取得し、声でメーターが動くことを確認してください。</span>
                <button type="button" disabled={sessionStarting} onClick={() => void reacquireLocalMedia()}>{sessionStarting ? "マイクを再取得中…" : "マイクを再取得"}</button>
              </div>
            )}
            {setupPhase === "error" && !localMediaRecoveryRequired && accessTokenRef.current && (
              <div className="recorded-fallback-card" role="status">
                <strong>録画式のオンライン一次面接で続けます</strong>
                <span>質問を画面と端末音声で案内します。録画にはカメラ映像とあなたの回答音声を保存し、端末で読む質問音声は含めず質問文を別に記録します。話し終えたら次へ進んでください。</span>
                <button type="button" disabled={sessionStarting} onClick={() => void startRecordedFallback()}>{sessionStarting ? "予備方式を準備中…" : "録画式のオンライン一次面接へ進む"}</button>
              </div>
            )}
            <div className="setup-recovery-actions">
              <button type="button" onClick={playSpeakerTest}>確認音を再生</button>
              {speakerTestState === "played" && <button type="button" onClick={confirmSpeakerHeard}>音が聞こえました</button>}
              {screenShareSupported && <button type="button" onClick={() => void enableScreenCapture()}>{screenCaptureState === "ready" ? "画面共有を追加済み" : "画面共有を追加（任意）"}</button>}
            </div>
            {!cameraReadiness.ready && !localMediaRecoveryRequired && <div className="inline-error" role="status" aria-live="polite">{cameraReadiness.message}</div>}
            <button className="primary-action setup-connect-button" disabled={!stream || sessionStarting || !cameraReadiness.ready} onClick={() => void (localMediaHealthRef.current.revision > 0 ? resumeAfterLocalMediaRecovery() : setupPhase === "error" ? startRecordedFallback() : connectPreparedInterview())}>
              {sessionStarting ? "オンライン一次面接へ接続中…" : setupPhase === "error" ? "録画式のオンライン一次面接へ進む" : localMediaHealthRef.current.revision > 0 ? "オンライン一次面接へ再接続" : "オンライン一次面接へ接続"} <span>→</span>
            </button>
            <p className="setup-footnote">カメラ映像と音声の確認後に録画を開始します。画面共有はPCのみ任意で追加できます。</p>
          </div>
        </section>
      )}

      {stage === "interview" && (
        <section className="interview-page">
          {mode === "internal-test" && <div className="internal-test-banner"><strong>接続確認</strong><span>選考対象外・録画・採用評価なし</span></div>}
          {mode === "recorded-fallback" && <div className="recorded-fallback-banner"><strong>オンライン一次面接・予備方式</strong><span>録画はカメラ映像・応募者音声／質問は文面で別記録</span></div>}
          {mode === "text" && <div className="recorded-fallback-banner"><strong>オンライン一次面接・文字入力方式</strong><span>選考対象・カメラとマイクは使用しません</span></div>}
          <div className="interview-topline">
            <div className={`live-state ${connectionState}`}><i />{connectionCopy}</div>
            <div className="interview-time">{formatTime(elapsed)} {mode !== "internal-test" && <span>/ 目安 15–25分</span>}</div>
          </div>
          {timeControlNotice && mode !== "internal-test" && (
            <div className={`interview-time-notice ${elapsed >= INTERVIEW_MAX_SECONDS ? "closing" : "warning"}`} role="status" aria-live="polite">
              <strong>{elapsed >= INTERVIEW_MAX_SECONDS ? "回答後に終了します" : "残り時間のお知らせ"}</strong>
              <span>{timeControlNotice}</span>
            </div>
          )}
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
              {recordingUploadState === "error" && stage === "interview" && <div className="privacy-box recording-state error" role="alert"><strong>録画送信を一時停止</strong><p>受領済み部分は保存されています。未送信部分はこの画面に保持しているため、閉じずに面接終了時の再送をお待ちください。</p></div>}
            </aside>

            <div className="conversation-area">
              <div className="conversation-heading">
                <div className={`interviewer-profile ${connectionState}`}>
                  <div className="interviewer-avatar"><img src="/interviewer-mogi.jpg" alt="TOKYO DOGS オンライン採用担当者 茂木" /></div>
                  <div><span>ONLINE RECRUITER</span><h2>オンライン採用担当者 茂木</h2></div>
                </div>
                <span>{candidateTurns} 回答</span>
              </div>
              {mode !== "internal-test" && (
                <InterviewerStage speaking={connectionState === "ai-speaking"} />
              )}
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
                  <div className="waiting-message"><div className={`waiting-avatar ${connectionState}`}><img src="/interviewer-mogi.jpg" alt="" /></div><div className="wave"><i /><i /><i /><i /></div><strong>{connectionState === "error" ? "接続できませんでした" : "オンライン一次面接を準備しています"}</strong><p>{connectionState === "error" ? errorMessage : connectionStepCopy || "まもなく茂木から最初の質問が始まります。"}</p></div>
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
                  <textarea value={textDraft} onChange={(event) => setTextDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendTextAnswer(); }} placeholder={mode === "voice" ? "聞き取りにくい時は、ここに入力できます" : "回答を入力してください"} rows={mode === "text" ? 6 : 2} maxLength={5000} />
                  <button onClick={sendTextAnswer} disabled={!textDraft.trim() || connectionState === "idle" || connectionState === "connecting" || connectionState === "error"}>送信</button>
                </div>
              )}
              <div className="interview-controls">
                {(mode === "voice" || mode === "recorded-fallback") && <button className={isMuted ? "control danger" : "control"} onClick={toggleMute}>{isMuted ? "マイクを再開" : "マイクをミュート"}</button>}
                {connectionState === "error" && <button className="control" onClick={restartConnection}>最初から接続をやり直す</button>}
                {connectionState === "error" && <button className="control" onClick={startInternalTest}>選考対象外の接続確認へ切り替える</button>}
                <button className="finish-button" onClick={() => { if (window.confirm("オンライン一次面接を中止しますか？受領済みの途中記録は技術確認用に保持しますが、面接完了・自動評価・受付完了にはなりません。")) { void completeInterview("candidate_requested_stop"); } }}>面接を中止</button>
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
          <p>{recordingUploadState === "uploading" ? `録画を分割保存しています（${recordingUploadProgress}%）。この画面を閉じずにお待ちください。` : archiveSyncState === "syncing" ? mode === "recorded-fallback" ? "録画と回答文字起こしを社内Driveへ格納しています。この画面を閉じずにお待ちください。" : mode === "text" ? "回答記録と評価資料を社内Driveへ格納しています。この画面を閉じずにお待ちください。" : "録画・文字起こし・評価資料を社内Driveへ格納しています。この画面を閉じずにお待ちください。" : "発言根拠を照合し、採用担当者向けの確認資料を作成しています。"}</p>
          <div className="evaluation-steps"><span className="done">{mode === "text" ? "回答記録" : "文字起こし"}</span><span className="active">根拠を照合</span><span>評価を作成</span></div>
        </section>
      )}

      {stage === "review" && (
        <section className="review-page">
          <div className="review-heading">
            <div><p className="eyebrow">{mode === "internal-test" ? "PORTAL CHECK COMPLETE" : archiveSyncState === "stored" ? "ONLINE FIRST INTERVIEW RECEIVED" : "INTERVIEW SAVE NOT YET VERIFIED"}</p><h1>{mode === "internal-test" ? "接続確認が完了しました。" : archiveSyncState === "stored" ? "オンライン一次面接を受け付けました。" : "面接記録の保存はまだ完了していません。"}</h1><p>{mode === "internal-test" ? "録画・音声接続・採用評価は行っていません。この内容は採用判断には使用しません。" : archiveSyncState === "stored" ? "ご回答ありがとうございました。面接記録は権限を付与された採用担当者が確認し、採用選考の判断資料として使用します。" : "この画面を閉じずに、下の保存状態と案内をご確認ください。"}</p></div>
            <div className="recommendation human_review"><span>受付番号</span><strong>{mode === "internal-test" ? "TEST COMPLETE" : sessionId}</strong><small>{mode === "internal-test" ? "採用判断には使用しません" : "採用担当者のみ閲覧可能"}</small></div>
          </div>
          <div className="summary-card">
            <span>{mode === "internal-test" ? "接続確認の取り扱い" : "評価結果の取り扱い"}</span>
            <p>{mode === "internal-test"
              ? "入力内容は端末内の画面確認だけに使用し、外部送信・保存・録画・文字起こし・採用評価を行っていません。"
              : mode === "recorded-fallback"
                ? "録画、回答文字起こし、文字起こしを根拠に作成した評価補助はこの応募者画面には表示しません。認証された採用担当者が録画と文字起こしを照合して最終判断し、技術品質を不利益に使用しません。"
                : "採点結果、評価本文、文字起こし、録画はこの応募者画面には表示されません。認証された採用担当者だけが社内の確認画面で閲覧します。"}</p>
          </div>
          {completionHold !== "none" && <div className="validation-box" role="alert"><strong>{completionHold === "candidate_requested_stop" ? "面接は中止され、受付完了にはなっていません" : completionHold === "safety_escalation" ? "安全上の理由で中断し、受付完了にはなっていません" : completionHold === "completion_reason_invalid" ? "終了理由を確認できず、受付完了にはなっていません" : "最終文字起こしが未確定のため、受付完了にはなっていません"}</strong><p>受領済みの途中記録は採用担当者の技術確認用にだけ保持し、自動評価や合否判断には使用しません。</p></div>}
          {processingWarning && <div className="validation-box"><strong>記録状態を採用担当者が確認します</strong><p>{processingWarning}</p></div>}
          {recordingUploadState === "stored" && recordingCompleteRef.current && <div className="validation-box"><strong>録画の一次保存が完了しました</strong><p>録画は面接IDで保管し、採用担当者以外には開示しません。社内Driveへの最終格納が確認できるまで受付完了にはなりません。</p></div>}
          {archiveSyncState === "stored" && <div className="validation-box"><strong>社内Driveへの格納まで完了しました</strong><p>{mode === "recorded-fallback" ? "録画と回答文字起こしの格納結果をサーバーで再確認済みです。採用担当者が両者を照合します。" : mode === "text" ? "回答記録と評価資料の格納結果をサーバーで再確認済みです。" : "録画・文字起こし・評価資料の格納結果をサーバーで再確認済みです。"}</p></div>}
          {archiveSyncState === "syncing" && <div className="validation-box"><strong>社内Driveへの格納を確認中です</strong><p>録画を含む全資料の実読取が終わるまで、この画面を閉じずにお待ちください。</p></div>}
          {completionHold === "none" && archiveSyncState !== "stored" && archiveSyncState !== "syncing" && (mode === "text" || (recordingUploadState === "stored" && recordingCompleteRef.current)) && <div className="validation-box"><strong>最終保存を再試行できます</strong><p>完了済みの処理は重複させず、未完了の整理または社内Drive格納から再開します。</p><button type="button" className="secondary-action" onClick={() => void retryInterviewFinalization()}>面接記録の保存を再試行</button></div>}
          {mode === "text" && archiveSyncState === "stored" && <div className="validation-box"><strong>文字入力によるオンライン一次面接を受け付けました</strong><p>カメラ・マイク・録画は使用していません。回答内容は採用担当者が確認します。</p></div>}
          {completionHold === "none" && recordingUploadState === "error" && recordingBlobRef.current && recordingCompleteRef.current && <div className="validation-box"><strong>録画の送信を再開できます</strong><p>受信済みの部分は再送せず、未送信部分から再開します。この画面を閉じずに再試行してください。</p><button type="button" className="secondary-action" onClick={() => void retryRecordingUpload()}>録画送信を再試行</button></div>}
          {completionHold === "none" && recordingUploadState === "error" && (!recordingBlobRef.current || !recordingCompleteRef.current) && <div className="validation-box"><strong>この端末から完全な録画を再送できません</strong><p>録画データが生成されていないか、途中で終了したため、採用担当者へ上の受付番号をお知らせください。</p></div>}
          <div className="review-actions"><div><span>{mode === "internal-test" ? "確認時間" : "面接時間"}</span><strong>{formatTime(elapsed)}</strong></div>{mode === "internal-test" && <button className="secondary-action" onClick={resetInterview}>最初から確認</button>}</div>
        </section>
      )}

      <footer className="site-footer"><span>TOKYO DOGS / OFFICIAL RECRUITMENT</span><span>CANDIDATE SELECTION PORTAL</span></footer>
    </main>
  );
}
