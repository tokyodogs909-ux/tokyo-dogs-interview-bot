#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DIARIZATION_MODEL = "gpt-4o-transcribe-diarize";
export const MAX_API_FILE_BYTES = 25_000_000;
export const SAFE_AUDIO_CHUNK_BYTES = 24_000_000;
export const MAX_INPUT_BYTES = 512 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 24 * 60;
export const AUDIO_SEGMENT_SECONDS = 4 * 60;
const MAX_AUDIO_CHUNKS = 6;
export const REQUEST_TIMEOUT_MS = 240 * 1000;
const MAX_TRANSCRIPT_CHARS = 300_000;
const FFPROBE_PACKET_TIMEOUT_MS = 45 * 1000;
const FFPROBE_PACKET_OUTPUT_BYTES = 128 * 1024 * 1024;
const FFPROBE_PACKET_LINE_CHARS = 2_048;
const MAX_PRIVATE_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SESSION_ID_PATTERN = /^TD-[A-Z0-9]{8}-[A-Z0-9]{7}$/;

export function approvedLegacySessionIds() {
  const raw = process.env.INTERVIEW_MANUAL_REPAIR_SESSION_IDS?.trim() ?? "";
  const values = raw ? raw.split(",").map((value) => value.trim()) : [];
  const unique = new Set(values);
  if (
    values.length !== 3 || unique.size !== 3 ||
    values.some((value) => !SESSION_ID_PATTERN.test(value))
  ) throw new Error("MANUAL_REPAIR_SESSION_ALLOWLIST_INVALID");
  return unique;
}

function usage() {
  return `Usage:
  npm run manual:transcript-draft -- --dry-run --session-id TD-XXXXXXXX-XXXXXXX --input /secure/video.webm --output /secure/draft.json
  npm run manual:transcript-draft -- --yes-paid-api --session-id TD-XXXXXXXX-XXXXXXX --input /secure/video.webm --output /secure/draft.json
  npm run manual:transcript-draft -- --yes-paid-api --resume-confirmed --session-id TD-XXXXXXXX-XXXXXXX --input /secure/video.webm --output /secure/draft.json
  npm run manual:transcript-draft -- --readback /secure/draft.json

This command creates a local, human-review-required draft only. It never writes D1,
Google Drive, or interview evaluations. It refuses to overwrite an existing file.`;
}

export function parseArguments(argv) {
  const options = {
    dryRun: false,
    yesPaidApi: false,
    resumeConfirmed: false,
    sessionId: "",
    input: "",
    output: "",
    readback: "",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--yes-paid-api") options.yesPaidApi = true;
    else if (argument === "--resume-confirmed") options.resumeConfirmed = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (["--session-id", "--input", "--output", "--readback"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("ARGUMENT_VALUE_MISSING");
      index += 1;
      if (argument === "--session-id") options.sessionId = value;
      else if (argument === "--input") options.input = value;
      else if (argument === "--output") options.output = value;
      else if (argument === "--readback") options.readback = value;
    } else {
      throw new Error("ARGUMENT_UNKNOWN");
    }
  }
  if (options.help) return options;
  if (options.readback) {
    if (
      options.dryRun || options.yesPaidApi || options.resumeConfirmed ||
      options.sessionId || options.input || options.output
    ) {
      throw new Error("READBACK_ARGUMENT_CONFLICT");
    }
    return options;
  }
  if (!SESSION_ID_PATTERN.test(options.sessionId)) throw new Error("SESSION_ID_INVALID");
  if (!approvedLegacySessionIds().has(options.sessionId)) {
    throw new Error("SESSION_NOT_APPROVED_FOR_MANUAL_DRAFT");
  }
  if (!options.input || !options.output) throw new Error("INPUT_OUTPUT_REQUIRED");
  if (options.resumeConfirmed && (options.dryRun || !options.yesPaidApi)) {
    throw new Error("RESUME_CONFIRMATION_INVALID");
  }
  if (!options.dryRun && !options.yesPaidApi) throw new Error("PAID_API_CONFIRMATION_REQUIRED");
  return options;
}

function runBinary(command, args, captureOutput = false) {
  const result = spawnSync(command, args, {
    encoding: captureOutput ? "utf8" : undefined,
    stdio: captureOutput ? ["ignore", "pipe", "ignore"] : "ignore",
  });
  if (result.error || result.status !== 0) throw new Error(`${command.toUpperCase()}_FAILED`);
  return captureOutput ? String(result.stdout ?? "").trim() : "";
}

function assertMediaTools() {
  runBinary("ffmpeg", ["-version"]);
  runBinary("ffprobe", ["-version"]);
}

function probeScalarDuration(path, entry) {
  return runBinary("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", entry,
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ], true);
}

function numericDuration(value) {
  const duration = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function numericTimestamp(value) {
  const timestamp = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

export function selectProbedDuration(formatDuration, streamDuration, packetEnd) {
  const duration = numericDuration(formatDuration) ??
    numericDuration(streamDuration) ??
    numericDuration(packetEnd);
  if (!duration || duration > MAX_DURATION_SECONDS) throw new Error("MEDIA_DURATION_INVALID");
  return duration;
}

function probeLastAudioPacketEnd(path) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-read_intervals", `0%+${4 * 60 * 60}`,
      "-show_entries", "packet=pts_time,dts_time,duration_time",
      "-of", "compact=p=0:nk=0",
      path,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let buffer = "";
    let outputBytes = 0;
    let maximumEnd = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolvePromise(result);
    };
    const parseLine = (line) => {
      if (!line || line.length > FFPROBE_PACKET_LINE_CHARS) {
        if (line.length > FFPROBE_PACKET_LINE_CHARS) {
          child.kill("SIGKILL");
          finish(new Error("FFPROBE_PACKET_OUTPUT_INVALID"));
        }
        return;
      }
      const fields = Object.fromEntries(line.split("|").flatMap((field) => {
        const separator = field.indexOf("=");
        return separator > 0 ? [[field.slice(0, separator), field.slice(separator + 1)]] : [];
      }));
      const start = numericTimestamp(fields.pts_time) ?? numericTimestamp(fields.dts_time);
      const duration = numericDuration(fields.duration_time) ?? 0;
      if (start !== null) maximumEnd = Math.max(maximumEnd, start + duration);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("FFPROBE_PACKET_TIMEOUT"));
    }, FFPROBE_PACKET_TIMEOUT_MS);
    child.on("error", () => finish(new Error("FFPROBE_FAILED")));
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > FFPROBE_PACKET_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("FFPROBE_PACKET_OUTPUT_TOO_LARGE"));
        return;
      }
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) parseLine(line);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (buffer) parseLine(buffer);
      if (settled) return;
      if (code !== 0) finish(new Error("FFPROBE_FAILED"));
      else finish(null, maximumEnd || null);
    });
  });
}

export async function mediaDurationSeconds(path) {
  const formatDuration = probeScalarDuration(path, "format=duration");
  const numericFormatDuration = numericDuration(formatDuration);
  if (numericFormatDuration !== null) {
    return selectProbedDuration(numericFormatDuration, null, null);
  }
  const streamDuration = probeScalarDuration(path, "stream=duration");
  const numericStreamDuration = numericDuration(streamDuration);
  if (numericStreamDuration !== null) {
    return selectProbedDuration(null, numericStreamDuration, null);
  }
  return selectProbedDuration(null, null, await probeLastAudioPacketEnd(path));
}

export function planAudioChunkCount(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error("MEDIA_DURATION_INVALID");
  }
  return Math.ceil(durationSeconds / AUDIO_SEGMENT_SECONDS);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function privacySafeIdentifier(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

async function inspectInput(inputPath, outputPath) {
  const sourcePath = await realpath(inputPath).catch(() => {
    throw new Error("INPUT_UNAVAILABLE");
  });
  const metadata = await lstat(sourcePath);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_INPUT_BYTES) {
    throw new Error("INPUT_FILE_INVALID");
  }
  const destination = resolve(outputPath);
  if (sourcePath === destination) throw new Error("INPUT_OUTPUT_CONFLICT");
  const outputParent = await realpath(dirname(destination)).catch(() => {
    throw new Error("OUTPUT_DIRECTORY_UNAVAILABLE");
  });
  if (basename(destination) === "" || basename(destination) === "." || basename(destination) === "..") {
    throw new Error("OUTPUT_PATH_INVALID");
  }
  await lstat(destination).then(() => {
    throw new Error("OUTPUT_ALREADY_EXISTS");
  }).catch((error) => {
    if (error instanceof Error && error.message === "OUTPUT_ALREADY_EXISTS") throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  });
  return {
    sourcePath,
    destination: join(outputParent, basename(destination)),
    byteSize: metadata.size,
    durationSeconds: await mediaDurationSeconds(sourcePath),
    sha256: await sha256File(sourcePath),
  };
}

async function extractAudioChunks(inputPath, workDirectory) {
  const fullAudioPath = join(workDirectory, "audio.mp3");
  runBinary("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
    "-codec:a", "libmp3lame", "-b:a", "32k",
    fullAudioPath,
  ]);
  await chmod(fullAudioPath, 0o600);
  const fullAudio = await lstat(fullAudioPath);
  if (!fullAudio.isFile() || fullAudio.size <= 0) throw new Error("AUDIO_EXTRACTION_EMPTY");
  const expectedChunks = planAudioChunkCount(await mediaDurationSeconds(fullAudioPath));
  if (expectedChunks === 1) {
    if (fullAudio.size > SAFE_AUDIO_CHUNK_BYTES) throw new Error("AUDIO_CHUNK_SIZE_INVALID");
    return [fullAudioPath];
  }

  const chunkPattern = join(workDirectory, "audio-part-%03d.mp3");
  runBinary("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", fullAudioPath,
    "-codec", "copy", "-f", "segment",
    "-segment_time", String(AUDIO_SEGMENT_SECONDS),
    "-reset_timestamps", "1",
    chunkPattern,
  ]);
  const chunkNames = (await readdir(workDirectory))
    .filter((name) => /^audio-part-\d{3}\.mp3$/.test(name))
    .sort();
  if (chunkNames.length !== expectedChunks || chunkNames.length > MAX_AUDIO_CHUNKS) {
    throw new Error("AUDIO_CHUNK_COUNT_INVALID");
  }
  const chunks = chunkNames.map((name) => join(workDirectory, name));
  for (const chunk of chunks) {
    await chmod(chunk, 0o600);
    const metadata = await lstat(chunk);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > SAFE_AUDIO_CHUNK_BYTES) {
      throw new Error("AUDIO_CHUNK_SIZE_INVALID");
    }
  }
  return chunks;
}

function safeApiErrorCode(payload, status) {
  const error = payload && typeof payload === "object" && "error" in payload
    ? payload.error
    : null;
  const value = error && typeof error === "object"
    ? (error.code ?? error.type)
    : null;
  return typeof value === "string" && /^[a-z0-9._-]{1,80}$/i.test(value)
    ? value
    : `http_${status}`;
}

function exactStreamedErrorCode(payload) {
  if (
    !payload || typeof payload !== "object" || Array.isArray(payload) ||
    Object.keys(payload).length !== 1 || !("error" in payload)
  ) return null;
  const error = payload.error;
  if (
    !error || typeof error !== "object" || Array.isArray(error) ||
    Object.keys(error).length !== 1 || !("code" in error)
  ) return null;
  return typeof error.code === "string" && /^[a-z0-9._-]{1,80}$/i.test(error.code)
    ? error.code
    : null;
}

export function validateDiarizedPayload(payload) {
  if (
    !payload || typeof payload !== "object" || Array.isArray(payload) ||
    payload.model !== DIARIZATION_MODEL ||
    !Array.isArray(payload.segments) ||
    Object.keys(payload).some((key) => !["model", "segments"].includes(key))
  ) {
    throw new Error("DIARIZED_RESPONSE_INVALID");
  }
  let transcriptChars = 0;
  const segments = payload.segments.map((segment) => {
    if (
      !segment || typeof segment !== "object" || Array.isArray(segment) ||
      Object.keys(segment).some((key) => !["speaker", "start", "end", "text"].includes(key))
    ) throw new Error("DIARIZED_RESPONSE_INVALID");
    const speaker = typeof segment.speaker === "string" && /^[a-z0-9._-]{1,80}$/i.test(segment.speaker)
      ? segment.speaker
      : null;
    const text = typeof segment.text === "string"
      ? segment.text.replaceAll("\0", "").trim()
      : "";
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!speaker || !text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new Error("DIARIZED_RESPONSE_INVALID");
    }
    transcriptChars += text.length;
    if (text.length > 10_000 || transcriptChars > MAX_TRANSCRIPT_CHARS) {
      throw new Error("DIARIZED_RESPONSE_TOO_LARGE");
    }
    return { speaker, start, end, text };
  });
  if (segments.length === 0) throw new Error("DIARIZED_RESPONSE_EMPTY");
  return segments;
}

export async function requestDraftFromRepairEndpoint(input) {
  const bytes = await readFile(input.path);
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_API_FILE_BYTES) {
    throw new Error("AUDIO_CHUNK_API_LIMIT_EXCEEDED");
  }
  const audioSha256 = createHash("sha256").update(bytes).digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.repairToken}`,
        "Content-Type": "audio/mpeg",
        "Content-Length": String(bytes.byteLength),
        "X-Interview-Session-Id": input.sessionId,
        "X-Interview-Audio-Sha256": audioSha256,
        "X-Interview-Audio-Index": String(input.index),
      },
      body: bytes,
      signal: controller.signal,
    });
  } catch (error) {
    // Any transport failure is ambiguous and may already have incurred a paid
    // transcription. This one-time repair client never retries automatically.
    if (error instanceof Error && error.name === "AbortError") throw new Error("OPENAI_TRANSCRIPTION_TIMEOUT");
    throw new Error("OPENAI_TRANSCRIPTION_TRANSPORT_FAILED");
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => null);
  const streamedErrorCode = exactStreamedErrorCode(payload);
  if (streamedErrorCode) {
    throw new Error(`OPENAI_TRANSCRIPTION_FAILED_${streamedErrorCode.toUpperCase()}`);
  }
  if (response.ok) return validateDiarizedPayload(payload);
  const code = safeApiErrorCode(payload, response.status);
  throw new Error(`OPENAI_TRANSCRIPTION_FAILED_${code.toUpperCase()}`);
}

function repairEndpointConfiguration() {
  const rawEndpoint = process.env.INTERVIEW_MANUAL_DRAFT_ENDPOINT?.trim();
  const repairToken = process.env.INTERVIEW_MANUAL_REPAIR_TOKEN?.trim();
  if (!rawEndpoint || !repairToken) throw new Error("MANUAL_REPAIR_CONFIGURATION_UNAVAILABLE");
  if (repairToken.length < 43 || repairToken.length > 512 || !/^[A-Za-z0-9_-]+$/.test(repairToken)) {
    throw new Error("MANUAL_REPAIR_TOKEN_INVALID");
  }
  let endpoint;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error("MANUAL_DRAFT_ENDPOINT_INVALID");
  }
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
    endpoint.hash || endpoint.origin === "null"
  ) throw new Error("MANUAL_DRAFT_ENDPOINT_INVALID");
  return { endpoint: endpoint.href, repairToken };
}

function productionWriteGuard() {
  return {
    safeToWriteProduction: false,
    d1Written: false,
    googleDriveWritten: false,
    evaluationTriggered: false,
  };
}

function assertProductionWriteGuard(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    value.safeToWriteProduction === false &&
    value.d1Written === false &&
    value.googleDriveWritten === false &&
    value.evaluationTriggered === false
  );
}

export function buildDraftEnvelope(input) {
  return {
    schemaVersion: 1,
    artifactType: "tokyo_dogs_manual_transcript_draft",
    reviewStatus: "human_verification_required",
    generatedAt: input.generatedAt,
    model: DIARIZATION_MODEL,
    source: {
      sessionIdHash: input.sessionIdHash,
      sha256: input.sourceSha256,
      byteSize: input.sourceByteSize,
      durationSeconds: input.sourceDurationSeconds,
    },
    productionWriteGuard: productionWriteGuard(),
    reviewRequirements: [
      "Compare every segment with the original video.",
      "Confirm which speaker is the candidate and which is the interviewer.",
      "Confirm question boundaries, answer boundaries, omissions, and recognition errors.",
      "Do not use this draft for an employment decision or production repair before human sign-off.",
    ],
    speakerLabelsMayResetBetweenChunks: input.chunks.length > 1,
    chunks: input.chunks,
  };
}

export function buildPartialCheckpoint(input) {
  return {
    schemaVersion: 1,
    artifactType: "tokyo_dogs_manual_transcript_checkpoint",
    reviewStatus: "human_verification_required",
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    model: DIARIZATION_MODEL,
    source: {
      sessionIdHash: input.sessionIdHash,
      sha256: input.sourceSha256,
      byteSize: input.sourceByteSize,
      durationSeconds: input.sourceDurationSeconds,
      plannedChunkCount: input.plannedChunkCount,
    },
    productionWriteGuard: productionWriteGuard(),
    chunks: input.chunks,
  };
}

function validateCheckpointChunk(chunk) {
  if (
    !chunk || typeof chunk !== "object" || Array.isArray(chunk) ||
    Object.keys(chunk).some((key) => ![
      "index", "offsetSeconds", "durationSeconds", "audioSha256", "audioByteSize", "segments",
    ].includes(key)) ||
    !Number.isInteger(chunk.index) || chunk.index < 1 || chunk.index > MAX_AUDIO_CHUNKS ||
    typeof chunk.offsetSeconds !== "number" || !Number.isFinite(chunk.offsetSeconds) || chunk.offsetSeconds < 0 ||
    typeof chunk.durationSeconds !== "number" || !Number.isFinite(chunk.durationSeconds) || chunk.durationSeconds <= 0 ||
    typeof chunk.audioSha256 !== "string" || !/^[a-f0-9]{64}$/.test(chunk.audioSha256) ||
    !Number.isInteger(chunk.audioByteSize) || chunk.audioByteSize <= 0 ||
    chunk.audioByteSize > SAFE_AUDIO_CHUNK_BYTES
  ) throw new Error("PARTIAL_CHECKPOINT_INVALID");
  return {
    index: chunk.index,
    offsetSeconds: chunk.offsetSeconds,
    durationSeconds: chunk.durationSeconds,
    audioSha256: chunk.audioSha256,
    audioByteSize: chunk.audioByteSize,
    segments: validateDiarizedPayload({ model: DIARIZATION_MODEL, segments: chunk.segments }),
  };
}

function assertPartialCheckpoint(checkpoint) {
  if (
    !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) ||
    Object.keys(checkpoint).some((key) => ![
      "schemaVersion", "artifactType", "reviewStatus", "createdAt", "updatedAt",
      "model", "source", "productionWriteGuard", "chunks",
    ].includes(key)) ||
    checkpoint.schemaVersion !== 1 ||
    checkpoint.artifactType !== "tokyo_dogs_manual_transcript_checkpoint" ||
    checkpoint.reviewStatus !== "human_verification_required" ||
    checkpoint.model !== DIARIZATION_MODEL ||
    typeof checkpoint.createdAt !== "string" || !Number.isFinite(Date.parse(checkpoint.createdAt)) ||
    typeof checkpoint.updatedAt !== "string" || !Number.isFinite(Date.parse(checkpoint.updatedAt)) ||
    !assertProductionWriteGuard(checkpoint.productionWriteGuard) ||
    !checkpoint.source || typeof checkpoint.source !== "object" || Array.isArray(checkpoint.source) ||
    Object.keys(checkpoint.source).some((key) => ![
      "sessionIdHash", "sha256", "byteSize", "durationSeconds", "plannedChunkCount",
    ].includes(key)) ||
    typeof checkpoint.source.sessionIdHash !== "string" ||
    !/^[a-f0-9]{32}$/.test(checkpoint.source.sessionIdHash) ||
    typeof checkpoint.source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.source.sha256) ||
    !Number.isInteger(checkpoint.source.byteSize) || checkpoint.source.byteSize <= 0 ||
    typeof checkpoint.source.durationSeconds !== "number" ||
    !Number.isFinite(checkpoint.source.durationSeconds) || checkpoint.source.durationSeconds <= 0 ||
    !Number.isInteger(checkpoint.source.plannedChunkCount) ||
    checkpoint.source.plannedChunkCount < 1 || checkpoint.source.plannedChunkCount > MAX_AUDIO_CHUNKS ||
    !Array.isArray(checkpoint.chunks) ||
    checkpoint.chunks.length > checkpoint.source.plannedChunkCount
  ) throw new Error("PARTIAL_CHECKPOINT_INVALID");

  const chunks = checkpoint.chunks.map(validateCheckpointChunk);
  if (chunks.some((chunk, index) => chunk.index !== index + 1)) {
    throw new Error("PARTIAL_CHECKPOINT_INVALID");
  }
  return { ...checkpoint, chunks };
}

function partialCheckpointError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  Object.defineProperty(error, "partialSaved", { value: true, enumerable: false });
  return error;
}

async function pathExists(path) {
  return await lstat(path).then(() => true).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });
}

async function syncParentDirectory(path) {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPrivateCheckpoint(path) {
  const metadata = await lstat(path).catch(() => {
    throw new Error("PARTIAL_CHECKPOINT_UNAVAILABLE");
  });
  if (
    !metadata.isFile() || (metadata.mode & 0o777) !== 0o600 ||
    metadata.size <= 0 || metadata.size > MAX_PRIVATE_ARTIFACT_BYTES
  ) throw new Error("PARTIAL_CHECKPOINT_PERMISSIONS_INVALID");
  try {
    return assertPartialCheckpoint(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message === "PARTIAL_CHECKPOINT_PERMISSIONS_INVALID") throw error;
    throw new Error("PARTIAL_CHECKPOINT_INVALID");
  }
}

async function writeExclusiveCheckpoint(path, checkpoint) {
  const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
  let handle;
  let created = false;
  try {
    assertPartialCheckpoint(checkpoint);
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(path, 0o600);
    const readback = await readPrivateCheckpoint(path);
    const bytes = await readFile(path);
    const expected = createHash("sha256").update(serialized).digest("hex");
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (expected !== actual) throw new Error("PARTIAL_CHECKPOINT_READBACK_MISMATCH");
    await syncParentDirectory(path);
    return readback;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await rm(path, { force: true }).catch(() => {});
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("PARTIAL_CHECKPOINT_ALREADY_EXISTS");
    }
    throw error;
  }
}

async function replaceCheckpointAtomically(path, checkpoint) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await readPrivateCheckpoint(path);
    await writeExclusiveCheckpoint(temporaryPath, checkpoint);
    await rename(temporaryPath, path);
    await syncParentDirectory(path);
    return await readPrivateCheckpoint(path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function checkpointMatchesSource(checkpoint, input) {
  return checkpoint.source.sessionIdHash === input.sessionIdHash &&
    checkpoint.source.sha256 === input.sourceSha256 &&
    checkpoint.source.byteSize === input.sourceByteSize &&
    checkpoint.source.durationSeconds === input.sourceDurationSeconds &&
    checkpoint.source.plannedChunkCount === input.preparedChunks.length;
}

async function acquireCheckpointLock(path) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile("locked\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(path, 0o600);
    const metadata = await lstat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("PARTIAL_CHECKPOINT_LOCK_INVALID");
    }
    await syncParentDirectory(path);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("PARTIAL_CHECKPOINT_BUSY");
    }
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

async function releaseCheckpointLock(path) {
  await rm(path);
  await syncParentDirectory(path);
}

async function processPreparedChunksUnlocked(input) {
  const checkpointPath = `${input.destination}.partial`;
  const checkpointPresent = await pathExists(checkpointPath);
  let checkpoint;
  if (checkpointPresent) {
    if (!input.resumeConfirmed) {
      throw partialCheckpointError("PARTIAL_CHECKPOINT_REQUIRES_EXPLICIT_RESUME");
    }
    try {
      checkpoint = await readPrivateCheckpoint(checkpointPath);
    } catch (error) {
      throw partialCheckpointError(
        error instanceof Error ? error.message : "PARTIAL_CHECKPOINT_INVALID",
        error,
      );
    }
  } else {
    if (input.resumeConfirmed) throw new Error("PARTIAL_CHECKPOINT_UNAVAILABLE");
    const now = new Date().toISOString();
    checkpoint = buildPartialCheckpoint({
      createdAt: now,
      updatedAt: now,
      sessionIdHash: input.sessionIdHash,
      sourceSha256: input.sourceSha256,
      sourceByteSize: input.sourceByteSize,
      sourceDurationSeconds: input.sourceDurationSeconds,
      plannedChunkCount: input.preparedChunks.length,
      chunks: [],
    });
    try {
      checkpoint = await writeExclusiveCheckpoint(checkpointPath, checkpoint);
    } catch (error) {
      if (error instanceof Error && error.message === "PARTIAL_CHECKPOINT_ALREADY_EXISTS") {
        throw partialCheckpointError("PARTIAL_CHECKPOINT_REQUIRES_EXPLICIT_RESUME", error);
      }
      throw error;
    }
  }

  if (!checkpointMatchesSource(checkpoint, input)) {
    throw partialCheckpointError("PARTIAL_CHECKPOINT_SOURCE_MISMATCH");
  }
  for (const saved of checkpoint.chunks) {
    const regenerated = input.preparedChunks[saved.index - 1];
    if (
      !regenerated || saved.index !== regenerated.index ||
      saved.offsetSeconds !== regenerated.offsetSeconds ||
      saved.durationSeconds !== regenerated.durationSeconds ||
      saved.audioSha256 !== regenerated.audioSha256 ||
      saved.audioByteSize !== regenerated.audioByteSize
    ) throw partialCheckpointError("PARTIAL_CHECKPOINT_AUDIO_MISMATCH");
  }

  for (const prepared of input.preparedChunks) {
    if (prepared.index <= checkpoint.chunks.length) continue;
    let segments;
    try {
      segments = await input.requestChunk(prepared);
    } catch (error) {
      throw partialCheckpointError(
        error instanceof Error ? error.message : "MANUAL_TRANSCRIPT_DRAFT_FAILED",
        error,
      );
    }
    const completedChunk = validateCheckpointChunk({
      index: prepared.index,
      offsetSeconds: prepared.offsetSeconds,
      durationSeconds: prepared.durationSeconds,
      audioSha256: prepared.audioSha256,
      audioByteSize: prepared.audioByteSize,
      segments,
    });
    checkpoint = buildPartialCheckpoint({
      createdAt: checkpoint.createdAt,
      updatedAt: new Date().toISOString(),
      sessionIdHash: input.sessionIdHash,
      sourceSha256: input.sourceSha256,
      sourceByteSize: input.sourceByteSize,
      sourceDurationSeconds: input.sourceDurationSeconds,
      plannedChunkCount: input.preparedChunks.length,
      chunks: [...checkpoint.chunks, completedChunk],
    });
    try {
      checkpoint = await replaceCheckpointAtomically(checkpointPath, checkpoint);
    } catch (error) {
      throw partialCheckpointError("PARTIAL_CHECKPOINT_WRITE_FAILED", error);
    }
  }
  return { checkpointPath, chunks: checkpoint.chunks };
}

export async function processPreparedChunks(input) {
  const lockPath = `${input.destination}.partial.lock`;
  await acquireCheckpointLock(lockPath);
  try {
    return await processPreparedChunksUnlocked(input);
  } finally {
    await releaseCheckpointLock(lockPath);
  }
}

function assertDraftEnvelope(draft) {
  if (
    !draft || typeof draft !== "object" ||
    draft.schemaVersion !== 1 ||
    draft.artifactType !== "tokyo_dogs_manual_transcript_draft" ||
    draft.reviewStatus !== "human_verification_required" ||
    draft.model !== DIARIZATION_MODEL ||
    !assertProductionWriteGuard(draft.productionWriteGuard) ||
    !Array.isArray(draft.chunks) || draft.chunks.length < 1
  ) {
    throw new Error("DRAFT_READBACK_INVALID");
  }
}

export async function writePrivateDraft(destination, draft) {
  const serialized = `${JSON.stringify(draft, null, 2)}\n`;
  let handle;
  let created = false;
  try {
    handle = await open(destination, "wx", 0o600);
    created = true;
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle?.close();
    handle = undefined;
    await chmod(destination, 0o600);
    const readback = await readFile(destination);
    const parsed = JSON.parse(readback.toString("utf8"));
    assertDraftEnvelope(parsed);
    const metadata = await lstat(destination);
    if ((metadata.mode & 0o777) !== 0o600) throw new Error("DRAFT_PERMISSIONS_INVALID");
    const expected = createHash("sha256").update(serialized).digest("hex");
    const actual = createHash("sha256").update(readback).digest("hex");
    if (expected !== actual) throw new Error("DRAFT_READBACK_MISMATCH");
    return {
      sha256: actual,
      byteSize: metadata.size,
      mode: "0600",
      chunkCount: parsed.chunks.length,
      segmentCount: parsed.chunks.reduce((sum, chunk) =>
        sum + (Array.isArray(chunk.segments) ? chunk.segments.length : 0), 0),
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await rm(destination, { force: true }).catch(() => {});
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("OUTPUT_ALREADY_EXISTS");
    }
    throw error;
  }
}

export async function readbackPrivateDraft(path) {
  const metadata = await lstat(path).catch(() => {
    throw new Error("DRAFT_UNAVAILABLE");
  });
  if (
    !metadata.isFile() || (metadata.mode & 0o777) !== 0o600 ||
    metadata.size <= 0 || metadata.size > MAX_PRIVATE_ARTIFACT_BYTES
  ) {
    throw new Error("DRAFT_PERMISSIONS_INVALID");
  }
  const bytes = await readFile(path);
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed?.artifactType === "tokyo_dogs_manual_transcript_checkpoint") {
    const checkpoint = assertPartialCheckpoint(parsed);
    return {
      ok: true,
      state: "partial_checkpoint_readback_verified",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: metadata.size,
      mode: "0600",
      plannedChunkCount: checkpoint.source.plannedChunkCount,
      completedChunkCount: checkpoint.chunks.length,
      completedChunkIndexes: checkpoint.chunks.map((chunk) => chunk.index),
      reviewStatus: checkpoint.reviewStatus,
      productionWriteAllowed: false,
    };
  }
  assertDraftEnvelope(parsed);
  return {
    ok: true,
    state: "draft_readback_verified",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: metadata.size,
    mode: "0600",
    chunkCount: parsed.chunks.length,
    segmentCount: parsed.chunks.reduce((sum, chunk) =>
      sum + (Array.isArray(chunk.segments) ? chunk.segments.length : 0), 0),
    reviewStatus: parsed.reviewStatus,
    productionWriteAllowed: false,
  };
}

async function execute(options) {
  assertMediaTools();
  const input = await inspectInput(options.input, options.output);
  const sessionIdHash = privacySafeIdentifier(options.sessionId);
  if (options.dryRun) {
    return {
      ok: true,
      state: "dry_run_verified",
      sessionIdHash,
      sourceSha256: input.sha256,
      sourceByteSize: input.byteSize,
      durationSeconds: input.durationSeconds,
      maximumPlannedApiCalls: planAudioChunkCount(input.durationSeconds),
      paidApiCalled: false,
      outputWritten: false,
      d1Written: false,
      googleDriveWritten: false,
      evaluationTriggered: false,
    };
  }
  const { endpoint, repairToken } = repairEndpointConfiguration();

  const workDirectory = await mkdtemp(join(tmpdir(), "tokyo-dogs-transcript-draft-"));
  await chmod(workDirectory, 0o700);
  try {
    const audioChunks = await extractAudioChunks(input.sourcePath, workDirectory);
    const preparedChunks = [];
    let offsetSeconds = 0;
    for (let index = 0; index < audioChunks.length; index += 1) {
      const path = audioChunks[index];
      const metadata = await lstat(path);
      const durationSeconds = await mediaDurationSeconds(path);
      preparedChunks.push({
        index: index + 1,
        path,
        offsetSeconds,
        durationSeconds,
        audioSha256: await sha256File(path),
        audioByteSize: metadata.size,
      });
      offsetSeconds += durationSeconds;
    }
    const processed = await processPreparedChunks({
      destination: input.destination,
      resumeConfirmed: options.resumeConfirmed,
      sessionIdHash,
      sourceSha256: input.sha256,
      sourceByteSize: input.byteSize,
      sourceDurationSeconds: input.durationSeconds,
      preparedChunks,
      requestChunk: async (prepared) => await requestDraftFromRepairEndpoint({
        path: prepared.path,
        index: prepared.index,
        endpoint,
        repairToken,
        sessionId: options.sessionId,
      }),
    });
    const draft = buildDraftEnvelope({
      generatedAt: new Date().toISOString(),
      sessionIdHash,
      sourceSha256: input.sha256,
      sourceByteSize: input.byteSize,
      sourceDurationSeconds: input.durationSeconds,
      chunks: processed.chunks,
    });
    let readback;
    try {
      readback = await writePrivateDraft(input.destination, draft);
      await rm(processed.checkpointPath);
      await syncParentDirectory(processed.checkpointPath);
    } catch (error) {
      throw partialCheckpointError(
        error instanceof Error ? error.message : "DRAFT_FINALIZATION_FAILED",
        error,
      );
    }
    return {
      ok: true,
      state: "draft_created_and_readback_verified",
      sessionIdHash,
      ...readback,
      reviewStatus: draft.reviewStatus,
      productionWriteAllowed: false,
      d1Written: false,
      googleDriveWritten: false,
      evaluationTriggered: false,
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const result = options.readback
      ? await readbackPrivateDraft(options.readback)
      : await execute(options);
    // Never print the input/output path, API credential, upstream body, audio,
    // transcript text, candidate identity, or speaker text to command logs.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_.-]{1,120}$/.test(error.message)
      ? error.message
      : "MANUAL_TRANSCRIPT_DRAFT_FAILED";
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code,
      ...(error && typeof error === "object" && "partialSaved" in error && error.partialSaved === true
        ? { partialSaved: true }
        : {}),
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
