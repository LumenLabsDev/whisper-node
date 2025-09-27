/**
 * Default Whisper model name used when no model is provided by the caller.
 * Matches a filename in `lib/whisper.cpp/models` via the model map.
 */
export const DEFAULT_MODEL = "base.en";
/**
 * Path to the bundled Whisper models directory inside this package.
 * Used by the CLI downloader to locate the official download scripts.
 */
export const NODE_MODULES_MODELS_PATH =
  "node_modules/whisper-node/lib/whisper.cpp/models";


