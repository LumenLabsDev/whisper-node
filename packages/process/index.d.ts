export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  silent?: boolean;
  signal?: AbortSignal;
  maxBuffer?: number;
}
export function runProcess(file: string, args?: string[], options?: ProcessOptions): Promise<{ stdout: string; stderr: string }>;
