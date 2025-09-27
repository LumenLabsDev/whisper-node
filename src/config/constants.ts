/**
 * Default Whisper model name used when no model is provided by the caller.
 * Matches a filename in `lib/whisper.cpp/models` via the model map.
 */
export const DEFAULT_MODEL = "base.en";
/**
 * Absolute path to the bundled Whisper models directory inside this package.
 * Resolved relative to the compiled JS output directory to work from npm installs.
 */
import path from "path";
export const MODELS_PATH = path.join(
  __dirname,
  "..",
  "..",
  "lib",
  "whisper.cpp",
  "models",
);


