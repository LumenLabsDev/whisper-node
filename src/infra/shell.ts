import { runProcess } from "../../packages/process";
import type { CppInvocation } from "../core/whisper";
import { findNativeProgram, isMissingDllExit, missingRuntimeError } from "./native";

/** Process output options. The legacy async flag is accepted; execution always returns a Promise. */
export interface IShellOptions {
  silent?: boolean;
  async?: boolean;
}

export interface IShellOutput {
  stdout: string;
  stderr: string;
}

export interface IShellRunOptions {
  /** Receives native stdout chunks as they arrive, for incremental parsing. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export default async function whisperShell(
  command: CppInvocation,
  options: IShellOptions = {},
  run: IShellRunOptions = {},
): Promise<IShellOutput> {
  const { binary, cwd } = await findNativeProgram("cli", options);
  try {
    return await runProcess(binary, command.args, {
      cwd,
      silent: options.silent ?? true,
      onStdout: run.onStdout,
      onStderr: run.onStderr,
      signal: run.signal,
    });
  } catch (error) {
    if (isMissingDllExit((error as { code?: number }).code)) throw missingRuntimeError(cwd);
    throw error;
  }
}
