export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}
export function readWavInfo(filePath: string): WavInfo | null;
export function isWav16kMono(filePath: string): boolean;
export function convertToWav16kMono(inputPath: string, outputPath: string): Promise<void>;
export function readPCM16(filePath: string, maxBytes?: number): Float32Array;
export function writeWavPCM16(filePath: string, pcm: Int16Array | Buffer, sampleRate?: number): void;
export function decodeToPCM16(
  input: string | Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  options?: { inputFormat?: string; signal?: AbortSignal },
): AsyncGenerator<Buffer, void, undefined>;
/** In-memory canonical 44-byte-header WAV for 16-bit mono PCM. */
export function encodeWavPCM16(pcm: Int16Array | Buffer, sampleRate?: number): Buffer;
/** Set, or clear with `undefined`, the FFmpeg executable used for non-WAV input. */
export function configureFfmpeg(file: string | undefined): void;
/** FFmpeg executable that will be used: configured path, FFMPEG_PATH, optional ffmpeg-static, then `ffmpeg`. */
export function ffmpegPath(): string;
