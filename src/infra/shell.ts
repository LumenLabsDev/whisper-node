import path from "node:path";
import fs from "node:fs";
import { runProcess } from "../../packages/process";
import { resolveWindowsBinDir } from "../../packages/whisper-native";
import { WHISPER_CPP_PATH } from "../config/constants";
import type { CppInvocation } from "../core/whisper";
import { createLogger } from "../utils/logger";

const logger = createLogger("shell");

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
  if (!fs.existsSync(WHISPER_CPP_PATH)) {
    throw new Error("[whisper-node] whisper.cpp directory not found. Reinstall or run the downloader CLI.");
  }

  const candidate = process.platform === "win32" ? resolveWindowsBinDir(WHISPER_CPP_PATH) : WHISPER_CPP_PATH;
  const runDir = candidate;
  const candidates = process.platform === "win32"
    ? ["whisper-cli.exe", "main.exe"]
    : ["main", "whisper-cli", path.join("build", "bin", "whisper-cli")];
  const findBinary = () => candidates.map(name => path.join(runDir, name)).find(file => fs.existsSync(file));
  let binary = findBinary();
  if (!binary && process.platform !== "win32") {
    logger.info("Building whisper.cpp binary");
    await runProcess("cmake", ["-B", "build"], { cwd: runDir, silent: options.silent ?? true });
    await runProcess("cmake", ["--build", "build", "--config", "Release"], { cwd: runDir, silent: options.silent ?? true });
    binary = findBinary();
  }
  if (!binary) throw new Error("[whisper-node] Whisper binary not found. Reinstall the package to fetch the precompiled release.");

  try {
    return await runProcess(binary, command.args, {
      cwd: runDir,
      silent: options.silent ?? true,
      onStdout: run.onStdout,
      onStderr: run.onStderr,
      signal: run.signal,
    });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (typeof code === "number" && (code >>> 0) === 3221225781) {
      throw new Error("[whisper-node] Missing Microsoft Visual C++ Redistributable (x64). Install the 2015–2022 package and retry.");
    }
    throw error;
  }
}
