import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { AUDIO_CONSTANTS } from "../config/constants";

ffmpeg.setFfmpegPath((ffmpegStatic as unknown as string) || "ffmpeg");
ffmpeg.setFfprobePath((ffprobeStatic.path as unknown as string) || "ffprobe");

/**
 * Ensure an input audio file is a 16 kHz mono WAV. If it isn't, convert it.
 * - Returns the original path if already compliant
 * - Otherwise, writes a sibling file with suffix .wav16k.wav and returns that path
 */
export async function ensureWav16kMono(inputPath: string): Promise<string> {
  const normalized = path.normalize(inputPath);

  const isCompliant = await isWav16kMono(normalized);
  if (isCompliant) return normalized;

  const { dir, name } = path.parse(normalized);
  const outPath = path.join(dir, `${name}.wav16k.wav`);

  await convertToWav16kMono(normalized, outPath);
  return outPath;
}

async function isWav16kMono(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      ffmpeg.ffprobe(p, (err, data) => {
        if (err || !data) return resolve(false);
        const stream = (data.streams || []).find((s) => s.codec_type === "audio");
        if (!stream) return resolve(false);
        const codec = (stream.codec_name || "").toLowerCase();
        const sampleRate = Number(stream.sample_rate || 0);
        const channels = Number(stream.channels || 0);

        const isWav = codec === "pcm_s16le" || codec === "pcm_s24le" || codec === "pcm_s32le";
        const ok = isWav && sampleRate === AUDIO_CONSTANTS.SAMPLE_RATE && channels === 1;
        resolve(ok);
      });
    } catch {
      resolve(false);
    }
  });
}

async function convertToWav16kMono(inputPath: string, outputPath: string): Promise<void> {
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(inputPath)
      .audioCodec("pcm_s16le")
      .audioChannels(1)
      .audioFrequency(AUDIO_CONSTANTS.SAMPLE_RATE)
      .format("wav")
      .on("error", (err) => reject(err))
      .on("end", () => resolve())
      .save(outputPath);
  });
}

export default ensureWav16kMono;


