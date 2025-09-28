import path from "path";

/**
 * Default Whisper model name used when no model is provided by the caller.
 * Matches a filename in `lib/whisper.cpp/models` via the model map.
 */
export const DEFAULT_MODEL = "base.en";

/**
 * Absolute path to the bundled Whisper models directory inside this package.
 * Resolved relative to the compiled JS output directory to work from npm installs.
 */
export const MODELS_PATH = path.join(
  __dirname,
  "..",
  "..",
  "lib",
  "whisper.cpp",
  "models",
);

/**
 * Absolute path to the bundled Whisper scripts directory inside this package.
 * Resolved relative to the compiled JS output directory to work from npm installs.
 */
export const SCRIPTS_PATH = path.join(
  __dirname,
  "..",
  "..",
  "lib",
  "whisper.cpp",
  "scripts",
);

/**
 * Root path to bundled whisper.cpp directory.
 */
export const WHISPER_CPP_PATH = path.join(
  __dirname,
  "..",
  "..",
  "lib",
  "whisper.cpp",
);

/**
 * Model downloader script filenames used by whisper.cpp
 */
export const MODEL_SCRIPT_FILENAMES = {
  posix: "download-ggml-model.sh",
  windowsCmd: "download-ggml-model.cmd",
} as const;

/**
 * Configuration constants for diarization
 */
export const DIARIZATION_CONSTANTS = {
  DEFAULT_FRAME_MS: 20,
  DEFAULT_VAD_MULTIPLIER: 1.5,
  MIN_ENERGY_OFFSET: 1e-9,
  MAX_SPEAKERS: 6,
  MIN_SPEAKERS: 1,
} as const;

/**
 * Download and network constants
 */
export const NETWORK_CONSTANTS = {
  MAX_REDIRECTS: 5,
  DOWNLOAD_TIMEOUT_MS: 300000, // 5 minutes
} as const;

/**
 * Audio processing constants
 */
export const AUDIO_CONSTANTS = {
  SAMPLE_RATE: 16000,
  WAV_HEADER_SIZE: 44,
  PCM_SCALE_FACTOR: 32768,
} as const;


