import { kmeans } from "ml-kmeans";
import { ITranscriptLine } from "../utils/transcription";
import { DIARIZATION_CONSTANTS, AUDIO_CONSTANTS } from "../config/constants";
import { createLogger } from "../utils/logger";
import { extractPCM16, computeFrameEnergies, computeVadThreshold, filterVoicedFrames } from "./vad";

const logger = createLogger('diarization');

export type DiarizationOptions = {
  enabled?: boolean;
  numSpeakers?: number | null;
  frameMs?: number;
  vadThreshold?: number;
};

export type DiarizationResult = {
  segments: { start: number; end: number; speaker: string }[];
};

/**
 * Naive, dependency-light diarization:
 * - Extract per-frame log-energy using ffmpeg (mono 16k PCM)
 * - Simple VAD by energy threshold (median * 1.5)
 * - For voiced frames, compute delta-energy feature and cluster with k-means
 * - Merge frames per speaker into contiguous segments
 */
export async function runDiarization(
  audioPath: string,
  options: DiarizationOptions = {},
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

  const K = Math.max(
    DIARIZATION_CONSTANTS.MIN_SPEAKERS, 
    Math.min(DIARIZATION_CONSTANTS.MAX_SPEAKERS, options.numSpeakers ?? 2)
  );
  
  logger.debug('Running k-means clustering', { numSpeakers: K, featureCount: features.length });
  const { clusters } = kmeans(features, K, { initialization: "kmeans++" });

  const labels = clusters as number[];
  const merged: { start: number; end: number; speaker: string }[] = [];
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

  return transcript.map((line) => {
    const s = toSeconds(line.start);
    const e = toSeconds(line.end);
    const match = dia.segments.find((seg) => !(e <= seg.start || s >= seg.end));
    return { ...line, speaker: match?.speaker } as ITranscriptLine;
  });
}


