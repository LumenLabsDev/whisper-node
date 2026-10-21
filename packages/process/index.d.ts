export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  silent?: boolean;
  signal?: AbortSignal;
  maxBuffer?: number;
  /** Receives each decoded output chunk as it arrives. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}
export function runProcess(file: string, args?: string[], options?: ProcessOptions): Promise<{ stdout: string; stderr: string }>;
