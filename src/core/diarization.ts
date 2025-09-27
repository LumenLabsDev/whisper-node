import ffmpeg from "fluent-ffmpeg";
const kmeans = require("ml-kmeans");
import fs from "fs";
import path from "path";
import os from "os";
import { ITranscriptLine } from "../utils/tsToArray";

export type DiarizationOptions = {
  enabled?: boolean;
  numSpeakers?: number | null;
  frameMs?: number; // default 20
  vadThreshold?: number; // energy threshold, naive VAD
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
  const frameMs = options.frameMs ?? 20;

  const pcm = await extractPCM16(audioPath);
  const sr = 16000;
  const hop = Math.floor((sr * frameMs) / 1000);
  const frames: { start: number; end: number; energy: number }[] = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < hop; j++) {
      const s = pcm[i + j];
      sum += s * s;
    }
    const energy = Math.log10(1e-9 + sum / hop);
    const t0 = i / sr;
    frames.push({ start: t0, end: t0 + frameMs / 1000, energy });
  }

  if (frames.length === 0) return { segments: [] };

  const energies = frames.map((f) => f.energy);
  const med = median(energies);
  const thr = options.vadThreshold ?? med * 1.5;
  const voiced = frames
    .map((f, idx) => ({ ...f, idx }))
    .filter((f) => f.energy >= thr);

  if (voiced.length === 0) return { segments: [] };

  const features: number[][] = voiced.map((f, i) => [
    f.energy,
    i > 0 ? f.energy - voiced[i - 1].energy : 0,
  ]);

  const K = Math.max(1, Math.min(6, options.numSpeakers ?? 2));
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

  return { segments: merged };
}

async function extractPCM16(inputPath: string): Promise<Float32Array> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-"));
  const tmp = path.join(tmpDir, "tmp.wav");
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(inputPath)
      .audioCodec("pcm_s16le")
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("error", (err) => reject(err))
      .on("end", () => resolve())
      .save(tmp);
  });

  const buf = fs.readFileSync(tmp);
  // WAV header at byte 44; little-endian 16-bit signed
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const samples = (buf.byteLength - 44) / 2;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(44 + i * 2, true);
    out[i] = s / 32768;
  }
  try { fs.unlinkSync(tmp); } catch {}
  try { fs.rmdirSync(tmpDir); } catch {}
  return out;
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


