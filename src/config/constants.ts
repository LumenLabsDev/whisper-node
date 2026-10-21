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
 * Spectral (MFCC) diarization backend constants
 */
export const SPECTRAL_CONSTANTS = {
  FFT_SIZE: 512,
  WINDOW_MS: 25,
  MEL_FILTERS: 26,
  COEFFICIENTS: 12,
  DEFAULT_SEGMENT_MS: 1000,
  MIN_VOICED_FRAMES: 5,
} as const;

/**
 * Streaming transcription constants
 */
export const STREAM_CONSTANTS = {
  DEFAULT_CHUNK_SECONDS: 30,
  MIN_CHUNK_SECONDS: 2,
  MAX_CHUNK_SECONDS: 600,
  /** Fraction at the end of each chunk searched for a quiet split point. */
  SPLIT_SEARCH_FRACTION: 0.2,
} as const;

/**
 * Download and network constants
 */
export const NETWORK_CONSTANTS = {
  MAX_REDIRECTS: 5,
  DOWNLOAD_TIMEOUT_MS: 60000, // abort after 1 minute without received bytes
} as const;

/**
 * Audio processing constants
 */
export const AUDIO_CONSTANTS = {
  SAMPLE_RATE: 16000,
  WAV_HEADER_SIZE: 44,
  PCM_SCALE_FACTOR: 32768,
} as const;


