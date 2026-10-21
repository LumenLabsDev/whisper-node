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
