import { kmeans } from "../../packages/clustering";
import { ITranscriptLine } from "../utils/transcription";
import { DIARIZATION_CONSTANTS, AUDIO_CONSTANTS, SPECTRAL_CONSTANTS } from "../config/constants";
import { createLogger } from "../utils/logger";
import { ValidationError } from "../utils/errors";
import { extractPCM16, computeFrameEnergies, computeVadThreshold, filterVoicedFrames } from "./vad";
import { computeMfcc } from "./features";

const logger = createLogger('diarization');

/** Built-in diarization backends. */
export type DiarizationBackendName = "energy" | "spectral" | "tinydiarize";

/**
 * Custom diarization backend, such as a wrapper around an external model or service.
 * Receives the prepared 16 kHz mono WAV path and returns speaker segments in seconds.
 */
export interface DiarizationBackend {
  name: string;
  diarize(audioPath: string, options: DiarizationOptions): Promise<DiarizationResult>;
}

export type DiarizationOptions = {
  enabled?: boolean;
  /** `energy` (default), `spectral`, `tinydiarize`, or a custom backend object. */
  backend?: DiarizationBackendName | DiarizationBackend;
  numSpeakers?: number | null;
  frameMs?: number;
  vadThreshold?: number;
  /** Spectral backend: duration of each speaker embedding window in milliseconds. */
  segmentMs?: number;
};

export type DiarizationResult = {
  segments: { start: number; end: number; speaker: string }[];
};

type Segment = DiarizationResult["segments"][number];

const BACKEND_NAMES: readonly DiarizationBackendName[] = ["energy", "spectral", "tinydiarize"];

/** Diarization backend selected by the options; `tinydiarize` runs inside whisper.cpp instead. */
export function resolveDiarizationBackend(options: DiarizationOptions = {}): DiarizationBackendName | DiarizationBackend {
  const backend = options.backend ?? "energy";
  if (typeof backend === "string") {
    if (!BACKEND_NAMES.includes(backend)) {
      throw new ValidationError(`Unknown diarization backend '${backend}'. Use ${BACKEND_NAMES.join(", ")} or a custom backend object.`);
    }
    return backend;
  }
  if (!backend || typeof backend.diarize !== "function") {
    throw new ValidationError("A custom diarization backend must provide a diarize(audioPath, options) function");
  }
  return backend;
}

function validateCommonOptions(options: DiarizationOptions): void {
  if (options.numSpeakers != null && (!Number.isInteger(options.numSpeakers) || options.numSpeakers < 1)) {
    throw new Error("numSpeakers must be a positive integer");
  }
}

function speakerCount(options: DiarizationOptions): number {
  return Math.max(
    DIARIZATION_CONSTANTS.MIN_SPEAKERS,
    Math.min(DIARIZATION_CONSTANTS.MAX_SPEAKERS, options.numSpeakers ?? 2),
  );
}

/** Validate, copy and sort segments returned by a custom backend. */
function normalizeSegments(result: DiarizationResult, backend: string): DiarizationResult {
  if (!result || !Array.isArray(result.segments)) {
    throw new Error(`Diarization backend '${backend}' must return { segments: [...] }`);
  }
  const segments = result.segments.map((segment, index) => {
    const { start, end, speaker } = segment ?? ({} as Segment);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || typeof speaker !== "string" || !speaker) {
      throw new Error(`Diarization backend '${backend}' returned an invalid segment at index ${index}`);
    }
    return { start, end, speaker };
  });
  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  return { segments };
}

/**
 * Run the selected diarization backend on a prepared audio file.
 * The `tinydiarize` backend is applied during transcription and cannot run standalone.
 */
export async function runDiarization(
  audioPath: string,
  options: DiarizationOptions = {},
): Promise<DiarizationResult> {
  const backend = resolveDiarizationBackend(options);
  validateCommonOptions(options);
  if (backend === "energy") return runEnergyDiarization(audioPath, options);
  if (backend === "spectral") return runSpectralDiarization(audioPath, options);
  if (backend === "tinydiarize") {
    throw new ValidationError("The tinydiarize backend runs inside whisper.cpp; use it through whisper() or transcribe()");
  }
  logger.info('Running custom diarization backend', { backend: backend.name });
  return normalizeSegments(await backend.diarize(audioPath, options), backend.name || "custom");
}

/**
 * Naive, dependency-light diarization:
 * - Extract per-frame log-energy using ffmpeg (mono 16k PCM)
 * - Simple VAD by energy threshold (median * 1.5)
 * - For voiced frames, compute delta-energy feature and cluster with k-means
 * - Merge frames per speaker into contiguous segments
 */
async function runEnergyDiarization(
  audioPath: string,
  options: DiarizationOptions,
): Promise<DiarizationResult> {
  logger.info('Starting diarization', { audioPath, options });

  // Validate file size before processing
  try {
    const stats = require('fs').statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    logger.debug('Audio file size', { fileSizeMB: fileSizeMB.toFixed(2) });
    if (fileSizeMB > 100) logger.warn('Large audio file detected, processing may use significant memory', { fileSizeMB });
  } catch {}

  const frameMs = options.frameMs ?? DIARIZATION_CONSTANTS.DEFAULT_FRAME_MS;

  const pcm = await extractPCM16(audioPath);
  logger.debug('Extracted PCM data', { sampleCount: pcm.length, memorySizeMB: (pcm.length * 4 / (1024 * 1024)).toFixed(2) });
  const sr = AUDIO_CONSTANTS.SAMPLE_RATE;
  const frames = computeFrameEnergies(pcm, sr, frameMs);

  if (frames.length === 0) {
    logger.warn('No frames extracted from audio');
    return { segments: [] };
  }

  const thr = options.vadThreshold ?? computeVadThreshold(frames, DIARIZATION_CONSTANTS.DEFAULT_VAD_MULTIPLIER);
  const voiced = filterVoicedFrames(frames, thr);

  logger.debug('Voice activity detection', {
    totalFrames: frames.length,
    voicedFrames: voiced.length,
    threshold: thr
  });

  if (voiced.length === 0) {
    logger.warn('No voiced frames detected');
    return { segments: [] };
  }

  // Optimize feature extraction with pre-allocated array
  const features = new Array(voiced.length);
  for (let i = 0; i < voiced.length; i++) {
    features[i] = [
      voiced[i].energy,
      i > 0 ? voiced[i].energy - voiced[i - 1].energy : 0,
    ];
  }

  const K = speakerCount(options);
  logger.debug('Running k-means clustering', { numSpeakers: K, featureCount: features.length });
  const { clusters } = kmeans(features, K);

  const labels = clusters as number[];
  const merged: Segment[] = [];
  for (let i = 0; i < voiced.length; i++) {
    const s = voiced[i].start;
    const e = voiced[i].end;
    const spk = `S${labels[i]}`;
    if (merged.length === 0) merged.push({ start: s, end: e, speaker: spk });
    else {
      const last = merged[merged.length - 1];
      if (last.speaker === spk && Math.abs(s - last.end) <= frameMs / 1000) {
        last.end = e;
      } else merged.push({ start: s, end: e, speaker: spk });
    }
  }

  logger.info('Diarization completed', { segmentCount: merged.length });
  return { segments: merged };
}

/**
 * Spectral diarization:
 * - Energy VAD selects voiced frames
 * - MFCC mean/standard deviation over fixed windows form speaker embeddings
 * - Standardized embeddings are clustered with k-means
 * - Labels are numbered by first appearance and smoothed before merging
 */
async function runSpectralDiarization(
  audioPath: string,
  options: DiarizationOptions,
): Promise<DiarizationResult> {
  logger.info('Starting spectral diarization', { audioPath, options });
  const frameMs = options.frameMs ?? DIARIZATION_CONSTANTS.DEFAULT_FRAME_MS;
  const segmentMs = options.segmentMs ?? SPECTRAL_CONSTANTS.DEFAULT_SEGMENT_MS;
  if (!Number.isFinite(segmentMs) || segmentMs < frameMs) {
    throw new Error("segmentMs must be a number no smaller than frameMs");
  }
  const sr = AUDIO_CONSTANTS.SAMPLE_RATE;
  const pcm = await extractPCM16(audioPath);
  const frames = computeFrameEnergies(pcm, sr, frameMs);
  if (frames.length === 0) return { segments: [] };
  const thr = options.vadThreshold ?? computeVadThreshold(frames, DIARIZATION_CONSTANTS.DEFAULT_VAD_MULTIPLIER);
  const mfcc = computeMfcc(pcm, sr, frameMs);

  // Group voiced frames into fixed windows and summarize each as mean + std of MFCCs.
  const framesPerWindow = Math.max(1, Math.round(segmentMs / frameMs));
  const minimumVoiced = Math.min(SPECTRAL_CONSTANTS.MIN_VOICED_FRAMES, framesPerWindow);
  const dims = SPECTRAL_CONSTANTS.COEFFICIENTS;
  const windows: { start: number; end: number; embedding: number[] }[] = [];
  for (let first = 0; first < frames.length; first += framesPerWindow) {
    const last = Math.min(frames.length, first + framesPerWindow);
    const sum = new Float64Array(dims);
    const squares = new Float64Array(dims);
    let count = 0;
    let start = Infinity;
    let end = -Infinity;
    for (let i = first; i < last; i++) {
      if (frames[i].energy < thr) continue;
      count++;
      start = Math.min(start, frames[i].start);
      end = Math.max(end, frames[i].end);
      for (let d = 0; d < dims; d++) {
        sum[d] += mfcc[i][d];
        squares[d] += mfcc[i][d] * mfcc[i][d];
      }
    }
    if (count < minimumVoiced) continue;
    const embedding: number[] = [];
    for (let d = 0; d < dims; d++) embedding.push(sum[d] / count);
    for (let d = 0; d < dims; d++) embedding.push(Math.sqrt(Math.max(0, squares[d] / count - (sum[d] / count) ** 2)));
    windows.push({ start, end, embedding });
  }
  logger.debug('Spectral embeddings', { totalFrames: frames.length, windows: windows.length, threshold: thr });
  if (windows.length === 0) {
    logger.warn('No voiced windows detected');
    return { segments: [] };
  }

  // Standardize every dimension so no coefficient dominates the distance.
  const width = windows[0].embedding.length;
  for (let d = 0; d < width; d++) {
    let mean = 0;
    for (const w of windows) mean += w.embedding[d];
    mean /= windows.length;
    let variance = 0;
    for (const w of windows) variance += (w.embedding[d] - mean) ** 2;
    const deviation = Math.sqrt(variance / windows.length) || 1;
    for (const w of windows) w.embedding[d] = (w.embedding[d] - mean) / deviation;
  }

  const { clusters } = kmeans(windows.map(w => w.embedding), speakerCount(options));
  const labels = relabelByFirstAppearance(smoothLabels(clusters as number[]));

  const merged: Segment[] = [];
  const maxGap = (framesPerWindow * frameMs) / 1000;
  for (let i = 0; i < windows.length; i++) {
    const speaker = `S${labels[i]}`;
    const last = merged[merged.length - 1];
    if (last && last.speaker === speaker && windows[i].start - last.end <= maxGap) last.end = windows[i].end;
    else merged.push({ start: windows[i].start, end: windows[i].end, speaker });
  }
  logger.info('Spectral diarization completed', { segmentCount: merged.length });
  return { segments: merged };
}

/** Replace isolated single-window labels that disagree with both equal neighbors. */
function smoothLabels(labels: number[]): number[] {
  const out = labels.slice();
  for (let i = 1; i + 1 < labels.length; i++) {
    if (labels[i - 1] === labels[i + 1] && labels[i] !== labels[i - 1]) out[i] = labels[i - 1];
  }
  return out;
}

function relabelByFirstAppearance(labels: number[]): number[] {
  const mapping = new Map<number, number>();
  return labels.map(label => {
    if (!mapping.has(label)) mapping.set(label, mapping.size);
    return mapping.get(label)!;
  });
}

/** Marker whisper.cpp appends to a segment when tinydiarize predicts a speaker change after it. */
export const SPEAKER_TURN_MARKER = "[SPEAKER_TURN]";

/**
 * Label transcript lines from tinydiarize speaker-turn markers and strip the markers.
 * tinydiarize detects turns, not identities: labels rotate through `numSpeakers` (default 2).
 */
export function applySpeakerTurns(
  transcript: ITranscriptLine[],
  options: DiarizationOptions = {},
  state: { current: number } = { current: 0 },
): ITranscriptLine[] {
  validateCommonOptions(options);
  const speakers = speakerCount(options);
  return transcript.map(line => {
    let speech = line.speech.trimEnd();
    let turn = false;
    while (speech.endsWith(SPEAKER_TURN_MARKER)) {
      speech = speech.slice(0, -SPEAKER_TURN_MARKER.length).trimEnd();
      turn = true;
    }
    const labeled = { ...line, speech, speaker: `S${state.current % speakers}` };
    if (turn) state.current = (state.current + 1) % speakers;
    return labeled;
  });
}

export function assignSpeakersToTranscript(
  transcript: ITranscriptLine[],
  dia: DiarizationResult,
): ITranscriptLine[] {
  const toSeconds = (ts: string) => {
    const [hh, mm, rest] = ts.split(":");
    const [ss, ms] = rest.split(".");
    const seconds =
      Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms || 0) / 1000;
    return seconds;
  };

  if (!transcript.length) return [];
  const segments = dia.segments;
  // Diarization emits ordered, non-overlapping segments. Custom overlapping
  // or unordered segments keep the original first-match behavior.
  const ordered = segments.every((segment, index) =>
    Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end >= segment.start &&
    (index === 0 || segment.start >= segments[index - 1].end),
  );

  return transcript.map((line) => {
    const s = toSeconds(line.start);
    const e = toSeconds(line.end);
    let match: DiarizationResult["segments"][number] | undefined;
    if (!ordered || !Number.isFinite(s) || !Number.isFinite(e)) {
      match = segments.find(segment => !(e <= segment.start || s >= segment.end));
    } else {
      let low = 0;
      let high = segments.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (segments[middle].end <= s) low = middle + 1;
        else high = middle;
      }
      const candidate = segments[low];
      if (candidate && e > candidate.start) match = candidate;
    }
    return { ...line, speaker: match?.speaker };
  });
}
