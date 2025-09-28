import { existsSync } from "fs";
import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_MODEL, MODELS_PATH } from "../config/constants";
import { ValidationError, SecurityError, FileNotFoundError, ModelNotFoundError } from "../utils/errors";
import { createLogger } from "../utils/logger";

const logger = createLogger('whisper');

/**
 * Validates and sanitizes a file path to prevent directory traversal attacks.
 * @param filePath The file path to validate
 * @returns Sanitized absolute path
 * @throws Error if path is invalid or potentially malicious
 */
async function validateFilePath(filePath: string): Promise<string> {
  logger.debug('Validating file path', { filePath });
  
  if (!filePath || typeof filePath !== 'string') {
    throw new ValidationError('File path must be a non-empty string');
  }

  const normalized = path.normalize(filePath);
  
  // Check for directory traversal attempts
  if (normalized.includes('..')) {
    logger.error('Path traversal attempt detected', { filePath, normalized });
    throw new SecurityError('Path traversal detected in file path');
  }

  // Convert to absolute path for consistency
  const absolutePath = path.resolve(normalized);
  
  // Use async file access to avoid race conditions
  try {
    await fs.access(absolutePath);
    
    // Get file stats for additional validation
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      logger.error('Path is not a file', { absolutePath });
      throw new FileNotFoundError(absolutePath);
    }
    
    logger.debug('File path validated successfully', { 
      absolutePath, 
      fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2) 
    });
    return absolutePath;
  } catch (error) {
    logger.error('File access failed', { absolutePath, error });
    throw new FileNotFoundError(absolutePath);
  }
}

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
export const createCppCommand = async ({
  filePath,
  modelName = null,
  modelPath = null,
  options = null,
}: CppCommandTypes): Promise<string> => {
  logger.info('Creating whisper command', { filePath, modelName, modelPath, options });
  
  // Validate input file path for security (now async)
  const validatedFilePath = await validateFilePath(filePath);
  
  const binaryPath = process.platform === "win32" ? "whisper-cli.exe" : "./main";
  const resolvedModelPath = modelPathOrName(modelName, modelPath);
  
  const command = `${binaryPath}${getFlags(options)} -m ${quoteArg(resolvedModelPath)} -f ${quoteArg(validatedFilePath)}`;
  logger.debug('Generated whisper command', { command });
  
  return command;
};

/**
 * Resolve a valid model file path given a model name or a custom model path.
 * Validates existence of the model file under the whisper.cpp models directory.
 */
const modelPathOrName = (mn: string | null | undefined, mp: string | null | undefined): string => {
  logger.debug('Resolving model path', { modelName: mn, modelPath: mp });
  
  if (mn && mp) throw new ValidationError("Submit a modelName OR a modelPath. NOT BOTH!");
  else if (!mn && !mp) {
    logger.info('No model specified, using default', { defaultModel: DEFAULT_MODEL });

    // verify default model exists under packaged models directory (absolute)
    const absoluteModelPath = path.join(
      MODELS_PATH,
      MODELS_LIST[DEFAULT_MODEL],
    );

    if (!existsSync(absoluteModelPath)) {
      logger.error('Default model not found', { modelPath: absoluteModelPath });
      throw new ModelNotFoundError(DEFAULT_MODEL);
    }

    logger.debug('Using default model', { modelPath: absoluteModelPath });
    return absoluteModelPath;
  }
  // modelpath
  else if (mp) {
    logger.debug('Using custom model path', { modelPath: mp });
    return mp;
  }
  // modelname
  else if (mn) {
    const rawAlias = String(mn).trim();
    const normalizedAlias = rawAlias.replace(/[\s_-]+/g, ".").toLowerCase();

    // Build a case-insensitive lookup from MODELS_LIST
    const fileByAlias: Record<string, string> = Object.keys(MODELS_LIST).reduce(
      (acc, key) => {
        acc[key.toLowerCase()] = MODELS_LIST[key as keyof typeof MODELS_LIST];
        return acc;
      },
      {} as Record<string, string>,
    );

    // 1) Direct map hit
    const mappedFile = fileByAlias[normalizedAlias];
    if (mappedFile) {
      const absoluteModelPath = path.join(MODELS_PATH, mappedFile);
      if (!existsSync(absoluteModelPath)) {
        throw new ModelNotFoundError(rawAlias);
      }
      return absoluteModelPath;
    }

    // 2) User might have provided the filename itself; check under models folder
    if (normalizedAlias.endsWith(".bin")) {
      const absoluteModelPath = path.join(MODELS_PATH, rawAlias);
      if (existsSync(absoluteModelPath)) return absoluteModelPath;
    }

    // 3) Fallback to ggml-<alias>.bin pattern used by whisper.cpp
    const guessedFile = `ggml-${normalizedAlias}.bin`;
    const guessedPath = path.join(MODELS_PATH, guessedFile);
    if (existsSync(guessedPath)) return guessedPath;

    throw new ModelNotFoundError(`${rawAlias}. Available: ${Object.keys(MODELS_LIST).join(", ")}`);
  } else {
    throw new ValidationError(`modelName OR modelPath required! You submitted modelName: '${mn}', modelPath: '${mp}'`);
  }
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
    throw new ValidationError("Invalid option pair. Use 'timestamp_size' OR 'word_timestamps'. NOT BOTH!");
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
 * Always quote a CLI argument to be safe on Windows cmd and *nix shells.
 */
const quoteArg = (value: string) => {
  if (!value) return value;
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed
    : `"${trimmed}"`;
};

/**
 * Map of supported model names to their ggml filenames from whisper.cpp.
 * Reference: https://github.com/ggerganov/whisper.cpp/#more-audio-samples
 */
export const MODELS_LIST = {
  tiny: "ggml-tiny.bin",
  "tiny-q5_1": "ggml-tiny-q5_1.bin",
  "tiny-q8_0": "ggml-tiny-q8_0.bin",
  "tiny.en": "ggml-tiny.en.bin",
  "tiny.en-q5_1": "ggml-tiny.en-q5_1.bin",
  "tiny.en-q8_0": "ggml-tiny.en-q8_0.bin",

  base: "ggml-base.bin",
  "base-q5_1": "ggml-base-q5_1.bin",
  "base-q8_0": "ggml-base-q8_0.bin",
  "base.en": "ggml-base.en.bin",
  "base.en-q5_1": "ggml-base.en-q5_1.bin",
  "base.en-q8_0": "ggml-base.en-q8_0.bin",

  small: "ggml-small.bin",
  "small-q5_1": "ggml-small-q5_1.bin",
  "small-q8_0": "ggml-small-q8_0.bin",
  "small.en": "ggml-small.en.bin",
  "small.en-q5_1": "ggml-small.en-q5_1.bin",
  "small.en-q8_0": "ggml-small.en-q8_0.bin",
  "small.en-tdrz": "ggml-small.en-tdrz.bin",

  medium: "ggml-medium.bin",
  "medium-q5_0": "ggml-medium-q5_0.bin",
  "medium-q8_0": "ggml-medium-q8_0.bin",
  "medium.en": "ggml-medium.en.bin",
  "medium.en-q5_0": "ggml-medium.en-q5_0.bin",
  "medium.en-q8_0": "ggml-medium.en-q8_0.bin",
  
  large: "ggml-large.bin",
  "large-v1": "ggml-large-v1.bin",
  "large-v2": "ggml-large-v2.bin",
  "large-v2-q5_0": "ggml-large-v2-q5_0.bin",
  "large-v2-q8_0": "ggml-large-v2-q8_0.bin",
  "large-v3": "ggml-large-v3.bin",
  "large-v3-q5_0": "ggml-large-v3-q5_0.bin",
  "large-v3-turbo": "ggml-large-v3-turbo.bin",
  "large-v3-turbo-q5_0": "ggml-large-v3-turbo-q5_0.bin",
  "large-v3-turbo-q8_0": "ggml-large-v3-turbo-q8_0.bin",
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


