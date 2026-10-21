import { convertToWav16kMono, readPCM16 } from "../../packages/audio";
import fs from "fs";
import path from "path";
import os from "os";
import { DIARIZATION_CONSTANTS } from "../config/constants";
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

  try {
    await convertToWav16kMono(inputPath, tmp);
    return readPCM16(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("Failed to remove temporary audio", { error });
    }
    try { fs.rmdirSync(tmpDir); } catch (error) {
      logger.warn("Failed to remove temporary directory", { error });
    }
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
  if (!Number.isFinite(sampleRate) || !Number.isFinite(frameMs) || sampleRate <= 0 || hop < 1) {
    throw new Error("sampleRate and frameMs must produce a positive frame size");
  }
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


