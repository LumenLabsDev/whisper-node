// todo: remove all imports from file
import { existsSync } from "fs";
import path from "path";
import { DEFAULT_MODEL, MODELS_PATH } from "../config/constants";

/**
 * Build the whisper.cpp executable command to run transcription for a given file.
 * Handles model path/name resolution and safe quoting for paths with spaces.
 *
 * @param params.filePath Absolute or relative path to the audio file
 * @param params.modelName Named model to use (bundled), mutually exclusive with modelPath
 * @param params.modelPath Custom path to a model .bin file, mutually exclusive with modelName
 * @param params.options Optional whisper.cpp flags
 * @returns Full command string to be executed in the whisper.cpp directory
 */
export const createCppCommand = ({
  filePath,
  modelName = null,
  modelPath = null,
  options = null,
}: CppCommandTypes) =>
  `./main${getFlags(options)} -m ${quotePathIfNeeded(modelPathOrName(modelName, modelPath))} -f ${quotePathIfNeeded(filePath)}`;

/**
 * Resolve a valid model file path given a model name or a custom model path.
 * Validates existence of the model file under the whisper.cpp models directory.
 */
const modelPathOrName = (mn: string, mp: string) => {
  if (mn && mp) throw "Submit a modelName OR a modelPath. NOT BOTH!";
  else if (!mn && !mp) {
    console.log(
      "[whisper-node] No 'modelName' or 'modelPath' provided. Trying default model:",
      DEFAULT_MODEL,
      "\n",
    );

    // verify default model exists under packaged models directory (absolute)
    const absoluteModelPath = path.join(
      MODELS_PATH,
      MODELS_LIST[DEFAULT_MODEL],
    );

    if (!existsSync(absoluteModelPath)) {
      throw `'${DEFAULT_MODEL}' not downloaded at ${absoluteModelPath}. Run 'npx @lumen-labs-dev/whisper-node download' or set 'modelPath' to a valid .bin file.`;
    }

    return absoluteModelPath;
  }
  // modelpath
  else if (mp) return mp;
  // modelname
  else if (MODELS_LIST[mn]) {
    // verify named model exists under packaged models directory (absolute)
    const absoluteModelPath = path.join(MODELS_PATH, MODELS_LIST[mn]);

    if (!existsSync(absoluteModelPath)) {
      throw `'${mn}' not downloaded at ${absoluteModelPath}. Run 'npx @lumen-labs-dev/whisper-node download' or set 'modelPath' to a valid .bin file.`;
    }

    return absoluteModelPath;
  } else if (mn)
    throw `modelName "${mn}" not found in list of models. Check your spelling OR use a custom modelPath.`;
  else
    throw `modelName OR modelPath required! You submitted modelName: '${mn}', modelPath: '${mp}'`;
};

/**
 * Convert typed options into whisper.cpp CLI flags.
 * Rejects invalid combinations and quotes output paths.
 *
 * Option flags list:
 * https://github.com/ggerganov/whisper.cpp/blob/master/README.md?plain=1#L91
 */
const getFlags = (flags?: IFlagTypes | null): string => {
  if (!flags) return "";

  let s = "";

  // output files
  if (flags.output_file_path)
    s += " -of " + quotePathIfNeeded(flags.output_file_path);
  if (flags.gen_file_txt) s += " -otxt";
  if (flags.gen_file_subtitle) s += " -osrt";
  if (flags.gen_file_vtt) s += " -ovtt";
  // timestamps
  if (flags.timestamp_size && flags.word_timestamps)
    throw "Invalid option pair. Use 'timestamp_size' OR 'word_timestamps'. NOT BOTH!";
  if (flags.word_timestamps) s += " -ml 1"; // shorthand for timestamp_size:1
  if (typeof flags.timestamp_size === "number")
    s += " -ml " + String(flags.timestamp_size);
  // input language
  if (flags.language) s += " -l " + flags.language;
  if (flags.no_timestamps) s += " -nt true";
  return s;
};

/**
 * Quote a path argument when it contains whitespace, preserving existing quotes.
 */
const quotePathIfNeeded = (p: string) => {
  if (!p) return p;
  const unquoted = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  return /\s/.test(unquoted) ? `"${unquoted}"` : unquoted;
};

/**
 * Map of supported model names to their ggml filenames from whisper.cpp.
 * Reference: https://github.com/ggerganov/whisper.cpp/#more-audio-samples
 */
export const MODELS_LIST = {
  tiny: "ggml-tiny.bin",
  "tiny.en": "ggml-tiny.en.bin",
  base: "ggml-base.bin",
  "base.en": "ggml-base.en.bin",
  small: "ggml-small.bin",
  "small.en": "ggml-small.en.bin",
  medium: "ggml-medium.bin",
  "medium.en": "ggml-medium.en.bin",
  "large-v1": "ggml-large-v1.bin",
  large: "ggml-large.bin",
};

type CppCommandTypes = {
  filePath: string;
  modelName?: string;
  modelPath?: string;
  options?: IFlagTypes;
};

/**
 * Recognized whisper.cpp command options supported by this wrapper.
 */
export type IFlagTypes = {
  gen_file_txt?: boolean;
  gen_file_subtitle?: boolean;
  gen_file_vtt?: boolean;
  timestamp_size?: number;
  word_timestamps?: boolean;
  language?: string;
  no_timestamps?: boolean;
  output_file_path?: string;
};


