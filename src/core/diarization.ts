import ffmpeg from "fluent-ffmpeg";
import { kmeans } from "ml-kmeans";
import fs from "fs";
import path from "path";
import os from "os";
import { ITranscriptLine } from "../utils/transcription";
import { DIARIZATION_CONSTANTS, AUDIO_CONSTANTS } from "../config/constants";
import { createLogger } from "../utils/logger";

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
  const stats = fs.statSync(audioPath);
  const fileSizeMB = stats.size / (1024 * 1024);
  logger.debug('Audio file size', { fileSizeMB: fileSizeMB.toFixed(2) });
  
  // Warn for large files that might cause memory issues
  if (fileSizeMB > 100) {
    logger.warn('Large audio file detected, processing may use significant memory', { fileSizeMB });
  }
  
  const frameMs = options.frameMs ?? DIARIZATION_CONSTANTS.DEFAULT_FRAME_MS;

  const pcm = await extractPCM16(audioPath);
  logger.debug('Extracted PCM data', { sampleCount: pcm.length, memorySizeMB: (pcm.length * 4 / (1024 * 1024)).toFixed(2) });
  const sr = AUDIO_CONSTANTS.SAMPLE_RATE;
  const hop = Math.floor((sr * frameMs) / 1000);
  const frames: { start: number; end: number; energy: number }[] = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < hop; j++) {
      const s = pcm[i + j];
      sum += s * s;
    }
    const energy = Math.log10(DIARIZATION_CONSTANTS.MIN_ENERGY_OFFSET + sum / hop);
    const t0 = i / sr;
    frames.push({ start: t0, end: t0 + frameMs / 1000, energy });
  }

  if (frames.length === 0) {
    logger.warn('No frames extracted from audio');
    return { segments: [] };
  }

  // Optimize array operations - combine map and filter for better performance
  const energies = new Array(frames.length);
  const voiced: Array<{ start: number; end: number; energy: number; idx: number }> = [];
  
  for (let i = 0; i < frames.length; i++) {
    energies[i] = frames[i].energy;
  }
  
  const med = median(energies);
  const thr = options.vadThreshold ?? med * DIARIZATION_CONSTANTS.DEFAULT_VAD_MULTIPLIER;
  
  // Single pass to filter voiced frames
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].energy >= thr) {
      voiced.push({ ...frames[i], idx: i });
    }
  }

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

async function extractPCM16(inputPath: string): Promise<Float32Array> {
  logger.debug('Extracting PCM16 from audio file', { inputPath });
  
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-"));
  const tmp = path.join(tmpDir, "tmp.wav");
  
  const cleanup = () => {
    try { 
      if (fs.existsSync(tmp)) {
        fs.unlinkSync(tmp); 
      }
    } catch (err) {
      logger.warn('Failed to cleanup temp file', { file: tmp, error: err });
    }
    try { 
      if (fs.existsSync(tmpDir)) {
        fs.rmdirSync(tmpDir); 
      }
    } catch (err) {
      logger.warn('Failed to cleanup temp directory', { directory: tmpDir, error: err });
    }
  };
  
  // Use AbortController for better cleanup management
  const abortController = new AbortController();
  const cleanupHandlers = [
    () => process.removeListener('exit', cleanup),
    () => process.removeListener('SIGINT', cleanup),
    () => process.removeListener('SIGTERM', cleanup)
  ];
  
  process.once('exit', cleanup);
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(inputPath)
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(AUDIO_CONSTANTS.SAMPLE_RATE)
        .format("wav")
        .on("error", (err) => reject(err))
        .on("end", () => resolve())
        .save(tmp);
    });

    // Check file size before loading into memory
    const tmpStats = fs.statSync(tmp);
    const tmpSizeMB = tmpStats.size / (1024 * 1024);
    logger.debug('Temporary WAV file size', { sizeMB: tmpSizeMB.toFixed(2) });
    
    if (tmpSizeMB > 500) { // 500MB limit for in-memory processing
      throw new Error(`Audio file too large for in-memory processing: ${tmpSizeMB.toFixed(2)}MB. Consider using smaller audio segments.`);
    }
    
    const buf = fs.readFileSync(tmp);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const samples = (buf.byteLength - AUDIO_CONSTANTS.WAV_HEADER_SIZE) / 2;
    const out = new Float32Array(samples);
    
    // Optimize the conversion loop
    const headerOffset = AUDIO_CONSTANTS.WAV_HEADER_SIZE;
    const scaleFactor = AUDIO_CONSTANTS.PCM_SCALE_FACTOR;
    for (let i = 0; i < samples; i++) {
      const s = view.getInt16(headerOffset + i * 2, true);
      out[i] = s / scaleFactor;
    }
    
    logger.debug('PCM conversion completed', { samples, outputSizeMB: (samples * 4 / (1024 * 1024)).toFixed(2) });
    return out;
  } finally {
    // Ensure cleanup happens regardless of success or failure
    cleanupHandlers.forEach(handler => handler());
    cleanup();
  }
}

function median(xs: number[]): number {
  const a = xs.slice().sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
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


