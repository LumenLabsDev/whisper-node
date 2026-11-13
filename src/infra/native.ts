import fs from "node:fs";
import path from "node:path";
import { runProcess } from "../../packages/process";
import { resolveWindowsBinDir } from "../../packages/whisper-native";
import { getRuntimeConfig, nativeRoot } from "../config/runtime";
import { WhisperNodeError } from "../utils/errors";
import { createLogger } from "../utils/logger";

const logger = createLogger("native");

/** NTSTATUS STATUS_DLL_NOT_FOUND, reported as the exit code when a DLL import is missing. */
const STATUS_DLL_NOT_FOUND = 0xc0000135;

const CANDIDATES = {
  cli: process.platform === "win32"
    ? ["whisper-cli.exe", "main.exe"]
    : ["main", "whisper-cli", path.join("build", "bin", "whisper-cli")],
  server: process.platform === "win32"
    ? ["whisper-server.exe"]
    : ["whisper-server", "server", path.join("build", "bin", "whisper-server")],
} as const;

export type NativeProgram = keyof typeof CANDIDATES;

/**
 * Directory containing the native executables. On Windows a root that directly contains
 * `whisper-cli.exe` or `whisper-server.exe` is used as-is (flat layout); otherwise the variant
 * folder is selected inside it. `WHISPER_WIN_BIN_DIR` must stay inside the root.
 */
export function resolveBinDir(): string {
  const root = nativeRoot();
  if (!fs.existsSync(root)) {
    throw new WhisperNodeError(
      `[whisper-node] Native directory not found: ${root}. Run 'npm run native:setup', or point configure({ nativeRoot }) / WHISPER_NODE_ROOT at the whisper.cpp binaries.`,
      "NATIVE_NOT_FOUND",
    );
  }
  if (process.platform !== "win32") return root;
  const flat = !process.env.WHISPER_WIN_BIN_DIR?.trim() &&
    [...CANDIDATES.cli, ...CANDIDATES.server].some(name => fs.existsSync(path.join(root, name)));
  return flat ? root : resolveWindowsBinDir(root, { flavor: getRuntimeConfig().flavor });
}

/** Locate a native program, building whisper.cpp from source on macOS/Linux when it is missing. */
export async function findNativeProgram(program: NativeProgram, options: { silent?: boolean } = {}): Promise<{ binary: string; cwd: string }> {
  const cwd = resolveBinDir();
  const find = () => CANDIDATES[program].map(name => path.join(cwd, name)).find(file => fs.existsSync(file));
  let binary = find();
  if (!binary && process.platform !== "win32") {
    logger.info("Building whisper.cpp binaries", { cwd });
    await runProcess("cmake", ["-B", "build"], { cwd, silent: options.silent ?? true });
    await runProcess("cmake", ["--build", "build", "--config", "Release"], { cwd, silent: options.silent ?? true });
    binary = find();
  }
  if (!binary) {
    throw new WhisperNodeError(
      `[whisper-node] ${CANDIDATES[program][0]} not found in ${cwd}. Run 'npm run native:setup' or copy the whisper.cpp release files there.`,
      "NATIVE_NOT_FOUND",
    );
  }
  return { binary, cwd };
}

/** True when a native exit code means a DLL (usually the Visual C++ runtime) is missing. */
export function isMissingDllExit(code: unknown): boolean {
  return typeof code === "number" && (code >>> 0) === STATUS_DLL_NOT_FOUND;
}

export function missingRuntimeError(directory: string): WhisperNodeError {
  return new WhisperNodeError(
    "[whisper-node] A native DLL failed to load, usually the Microsoft Visual C++ runtime. " +
      `Place vcruntime140.dll, vcruntime140_1.dll and msvcp140.dll next to the executable in ${directory} ` +
      "(see 'npm run native:setup -- --vcruntime'), or install the Visual C++ 2015-2022 Redistributable.",
    "VC_RUNTIME_MISSING",
  );
}
