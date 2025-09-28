import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import os from "os";
import { AUDIO_CONSTANTS, DIARIZATION_CONSTANTS } from "../config/constants";
import { createLogger } from "../utils/logger";

const logger = createLogger('vad');

export type Frame = { start: number; end: number; energy: number };
export type VoicedFrame = Frame & { idx: number };

/**
 * Extract 16 kHz mono PCM from an input audio file into memory.
 */
export async function extractPCM16(inputPath: string): Promise<Float32Array> {
  logger.debug('Extracting PCM16 from audio file', { inputPath });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-"));
  const tmp = path.join(tmpDir, "tmp.wav");

  const cleanup = () => {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (err) {
      logger.warn('Failed to cleanup temp file', { file: tmp, error: err });
    }
    try { if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir); } catch (err) {
      logger.warn('Failed to cleanup temp directory', { directory: tmpDir, error: err });
    }
  };

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

    const tmpStats = fs.statSync(tmp);
    const tmpSizeMB = tmpStats.size / (1024 * 1024);
    logger.debug('Temporary WAV file size', { sizeMB: tmpSizeMB.toFixed(2) });
    if (tmpSizeMB > 500) {
      throw new Error(`Audio file too large for in-memory processing: ${tmpSizeMB.toFixed(2)}MB. Consider using smaller audio segments.`);
    }

    const buf = fs.readFileSync(tmp);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const samples = (buf.byteLength - AUDIO_CONSTANTS.WAV_HEADER_SIZE) / 2;
    const out = new Float32Array(samples);

    const headerOffset = AUDIO_CONSTANTS.WAV_HEADER_SIZE;
    const scaleFactor = AUDIO_CONSTANTS.PCM_SCALE_FACTOR;
    for (let i = 0; i < samples; i++) {
      const s = view.getInt16(headerOffset + i * 2, true);
      out[i] = s / scaleFactor;
    }
    logger.debug('PCM conversion completed', { samples, outputSizeMB: (samples * 4 / (1024 * 1024)).toFixed(2) });
    return out;
  } finally {
    cleanup();
  }
}

/**
 * Compute per-frame log-energy features.
 */
export function computeFrameEnergies(
  pcm: Float32Array,
  sampleRate: number,
  frameMs: number,
): Frame[] {
  const hop = Math.floor((sampleRate * frameMs) / 1000);
  const frames: Frame[] = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < hop; j++) sum += pcm[i + j] * pcm[i + j];
    const energy = Math.log10(DIARIZATION_CONSTANTS.MIN_ENERGY_OFFSET + sum / hop);
    const t0 = i / sampleRate;
    frames.push({ start: t0, end: t0 + frameMs / 1000, energy });
  }
  return frames;
}

export function median(xs: number[]): number {
  const a = xs.slice().sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/**
 * Compute VAD threshold as median(energy) * multiplier.
 */
export function computeVadThreshold(
  frames: Frame[],
  multiplier: number = DIARIZATION_CONSTANTS.DEFAULT_VAD_MULTIPLIER,
): number {
  if (frames.length === 0) return Number.POSITIVE_INFINITY;
  const energies = new Array(frames.length);
  for (let i = 0; i < frames.length; i++) energies[i] = frames[i].energy;
  return median(energies) * multiplier;
}

/**
 * Filter frames by threshold and attach their original index.
 */
export function filterVoicedFrames(
  frames: Frame[],
  threshold: number,
): VoicedFrame[] {
  const voiced: VoicedFrame[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].energy >= threshold) voiced.push({ ...frames[i], idx: i });
  }
  return voiced;
}


