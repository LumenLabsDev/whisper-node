import os from "os";
import path from "path";
import { configureFfmpeg } from "../../packages/audio";
import { MODELS_PATH, WHISPER_CPP_PATH } from "./constants";
import { ValidationError } from "../utils/errors";

/**
 * Runtime locations, for hosts such as Electron that keep native files outside the package.
 * Every field is optional. Values set with `configure` win over environment variables,
 * which win over the package defaults.
 */
export interface IRuntimeConfig {
  /**
   * Directory with the whisper.cpp binaries. On Windows it can hold the variant folders
   * (`Win64`, `BlasWin64`, ...) or, flat, the contents of one variant (`whisper-cli.exe` and its DLLs).
   * Environment: `WHISPER_NODE_ROOT`. Default: `lib/whisper.cpp` inside this package.
   */
  nativeRoot?: string;
  /**
   * Directory searched for `modelName`. Environment: `WHISPER_NODE_MODELS`.
   * Default: `<nativeRoot>/models` when `nativeRoot` is set, otherwise the package models folder.
   */
  modelsPath?: string;
  /** FFmpeg executable used for non-WAV input. Environment: `FFMPEG_PATH`. Default: optional `ffmpeg-static`, then `ffmpeg` on PATH. */
  ffmpegPath?: string;
  /** Parent directory for temporary audio chunks. Environment: `WHISPER_NODE_TMPDIR`. Default: `os.tmpdir()`. */
  tmpDir?: string;
  /** Windows variant inside `nativeRoot`: `cpu` or `blas`. Environment: `WHISPER_WIN_FLAVOR`. Default: `cpu`. */
  flavor?: string;
}

const KEYS = ["nativeRoot", "modelsPath", "ffmpegPath", "tmpDir", "flavor"] as const;
let current: IRuntimeConfig = {};

function absolute(name: string, value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${name} must be a non-empty string`);
  if (value.includes("\0")) throw new ValidationError(`${name} must not contain NUL characters`);
  if (!path.isAbsolute(value)) {
    throw new ValidationError(`${name} must be an absolute path; relative paths depend on the working directory: ${value}`);
  }
  return path.normalize(value);
}

/**
 * Electron cannot execute files or load DLLs from inside `app.asar`. When this package itself
 * sits in an archive, use the unpacked copy that `asarUnpack` produces next to it.
 */
export function unpackedAsarPath(file: string): string {
  const segments = file.split(/[\\/]/);
  const index = segments.indexOf("app.asar");
  if (index < 0) return file;
  segments[index] = "app.asar.unpacked";
  return segments.join(path.sep);
}

function fromEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? absolute(name, value) : undefined;
}

/**
 * Set runtime locations. Pass `undefined` or `null` for a field to return it to its default.
 * Returns the effective configuration.
 */
export function configure(config: { [K in keyof IRuntimeConfig]?: IRuntimeConfig[K] | null } = {}): Required<Omit<IRuntimeConfig, "ffmpegPath">> & Pick<IRuntimeConfig, "ffmpegPath"> {
  if (!config || typeof config !== "object") throw new ValidationError("configure expects an object");
  const next: IRuntimeConfig = { ...current };
  for (const key of Object.keys(config) as (keyof IRuntimeConfig)[]) {
    if (!(KEYS as readonly string[]).includes(key)) throw new ValidationError(`Unknown runtime option: ${key}`);
    const value = config[key];
    if (value == null) delete next[key];
    else if (key === "flavor") {
      if (typeof value !== "string" || !/^[a-z0-9.-]+$/i.test(value)) throw new ValidationError("flavor must be a variant name such as 'cpu' or 'blas'");
      next.flavor = value.toLowerCase();
    } else next[key] = absolute(key, value);
  }
  current = next;
  configureFfmpeg(current.ffmpegPath);
  return getRuntimeConfig();
}

/** Effective runtime locations after applying `configure`, environment variables and defaults. */
export function getRuntimeConfig() {
  return {
    nativeRoot: nativeRoot(),
    modelsPath: modelsPath(),
    tmpDir: tmpRoot(),
    flavor: current.flavor ?? (process.env.WHISPER_WIN_FLAVOR?.trim().toLowerCase() || "cpu"),
    ...(current.ffmpegPath ? { ffmpegPath: current.ffmpegPath } : {}),
  };
}

/** Root directory of the whisper.cpp binaries. */
export function nativeRoot(): string {
  return current.nativeRoot ?? fromEnv("WHISPER_NODE_ROOT") ?? unpackedAsarPath(WHISPER_CPP_PATH);
}

/** Directory used to resolve `modelName`. */
export function modelsPath(): string {
  const explicit = current.modelsPath ?? fromEnv("WHISPER_NODE_MODELS");
  if (explicit) return explicit;
  const root = current.nativeRoot ?? fromEnv("WHISPER_NODE_ROOT");
  return root ? path.join(root, "models") : unpackedAsarPath(MODELS_PATH);
}

/** Parent directory for temporary audio; created on demand. */
export function tmpRoot(): string {
  return current.tmpDir ?? fromEnv("WHISPER_NODE_TMPDIR") ?? os.tmpdir();
}

/** Test helper: drop every `configure` value. */
export function resetRuntimeConfig(): void {
  current = {};
  configureFfmpeg(undefined);
}
