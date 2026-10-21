import path from "node:path";
import { isWav16kMono, convertToWav16kMono } from "../../packages/audio";

/** Return a compliant input as-is, or create a sibling 16 kHz mono WAV. */
export async function ensureWav16kMono(inputPath: string): Promise<string> {
  const normalized = path.normalize(inputPath);
  if (isWav16kMono(normalized)) return normalized;
  const { dir, name } = path.parse(normalized);
  const outputPath = path.join(dir, `${name}.wav16k.wav`);
  await convertToWav16kMono(normalized, outputPath);
  return outputPath;
}

export default ensureWav16kMono;
