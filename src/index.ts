import { promises as fs } from "fs";
import shell from "./infra/shell";
import { createCppInvocation } from "./core/whisper";
import transcriptToArray, { ITranscriptLine, mergeWordLevelTranscript, looksLikeWordLevelTranscript } from "./utils/transcription";
import ensureWav16kMono from "./utils/convert";
import { IOptions, resolveOptions, warnIfNotTinydiarizeModel } from "./config/options";
import {
  runDiarization,
  DiarizationResult,
  assignSpeakersToTranscript,
  applySpeakerTurns,
  resolveDiarizationBackend,
} from "./core/diarization";
import { ILanguageInfo, parseLanguageInfo } from "./utils/language";
import { WhisperNodeError, ValidationError, safeAsync, isWhisperNodeError } from "./utils/errors";
import { createLogger } from "./utils/logger";

const logger = createLogger('main');

/**
 * Transcript plus metadata returned by `transcribe`.
 */
export interface ITranscriptionResult {
  transcript: ITranscriptLine[];
  /** Spoken language reported by whisper.cpp; undefined when native output did not include it. */
  language?: ILanguageInfo;
}

/**
 * Wrap unexpected failures in WhisperNodeError with a model hint where relevant.
 */
function rethrow(error: unknown): never {
  if (isWhisperNodeError(error)) {
    logger.error('Whisper-node error occurred', { error: error.message, code: error.code });
    // Re-throw our custom errors as-is
    throw error;
  }

  const msg = String(error || "");
  if (msg.includes("not downloaded") || msg.includes("not found") || msg.includes("modelName")) {
    logger.error('Model issue detected. Run `npx whisper-node download` to fetch models, or configure { modelPath: \'.../ggml-*.bin\' }.', { error: msg });
  } else {
    logger.error('Transcription failed with unknown error', { error });
  }

  // Wrap unknown errors in our error type
  throw new WhisperNodeError(
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * Transcribe an audio file and return the transcript with language metadata.
 *
 * @param filePath Path to the audio file (.wav 16kHz recommended)
 * @param options Optional configuration including model selection and flags
 * @returns `{ transcript, language }`
 */
export const transcribe = async (
  filePath: string,
  options?: IOptions,
): Promise<ITranscriptionResult> => {
  // Input validation
  if (!filePath || typeof filePath !== 'string') {
    throw new ValidationError('File path must be a non-empty string');
  }

  try {
    logger.info('Starting transcription', { filePath, options });

    // Early file size validation
    try {
      const stats = await fs.stat(filePath);
      const fileSizeGB = stats.size / (1024 * 1024 * 1024);
      logger.debug('Input file size', { fileSizeGB: fileSizeGB.toFixed(3) });

      if (fileSizeGB > 2) { // 2GB limit
        logger.warn('Large audio file detected', { fileSizeGB });
        // Don't throw, just warn - let the user decide
      }
    } catch (error) {
      // File doesn't exist or can't be accessed - will be caught by validateFilePath
      logger.debug('Could not get file stats during initial validation', { error });
    }

    const effectiveOptions = resolveOptions(options);
    const diarize = effectiveOptions.diarization;
    // Validate the backend before spending time on transcription.
    const backend = diarize?.enabled ? resolveDiarizationBackend(diarize) : undefined;
    if (backend === "tinydiarize") warnIfNotTinydiarizeModel(effectiveOptions);

    const preparedFilePath = await safeAsync(
      () => ensureWav16kMono(filePath),
      "Failed to prepare audio file"
    );
    logger.debug('Audio file prepared', { preparedFilePath });

    const command = await createCppInvocation({
      filePath: preparedFilePath, // Already normalized by createCppInvocation
      modelName: effectiveOptions.modelName,
      modelPath: effectiveOptions.modelPath,
      options: effectiveOptions.whisperOptions,
      extraArgs: backend === "tinydiarize" ? ["-tdrz"] : [],
    });

    const output = await safeAsync(
      () => shell(command, effectiveOptions.shellOptions),
      "Failed to execute whisper transcription"
    );
    logger.debug('Whisper transcription completed');

    const language = parseLanguageInfo(output.stderr, effectiveOptions.whisperOptions?.language);
    if (language) logger.info('Language identified', language);

    let transcriptArray = transcriptToArray(output.stdout);
    logger.info('Transcript parsed', { lineCount: transcriptArray.length });

    // Speaker turns are attached to native segments, so label them before merging words.
    if (backend === "tinydiarize") transcriptArray = applySpeakerTurns(transcriptArray, diarize);

    if (looksLikeWordLevelTranscript(transcriptArray)) {
      const before = transcriptArray.length;
      transcriptArray = mergeWordLevelTranscript(transcriptArray);
      logger.info('Merged word-level lines into sentences', { before, after: transcriptArray.length });
    }

    if (diarize && backend && backend !== "tinydiarize") {
      try {
        logger.info('Starting diarization', { backend: typeof backend === "string" ? backend : backend.name });
        const dia: DiarizationResult = await runDiarization(preparedFilePath, diarize);
        transcriptArray = assignSpeakersToTranscript(transcriptArray, dia);
        logger.info('Diarization completed successfully');
      } catch (e) {
        logger.warn('Diarization failed', { error: e instanceof Error ? e.message : e });
      }
    }

    logger.info('Transcription completed successfully', {
      lineCount: transcriptArray.length,
      hasSpeakers: transcriptArray.some(line => line.speaker)
    });
    return { transcript: transcriptArray, ...(language ? { language } : {}) };
  } catch (error) {
    rethrow(error);
  }
};

/**
 * Transcribe an audio file using whisper.cpp via this Node wrapper.
 *
 * @param filePath Path to the audio file (.wav 16kHz recommended)
 * @param options Optional configuration including model selection and flags
 * @returns Array of transcript lines: {start, end, speech}
 */
export const whisper = async (
  filePath: string,
  options?: IOptions,
): Promise<ITranscriptLine[]> => (await transcribe(filePath, options)).transcript;

export default whisper;

export { transcribeStream } from "./core/stream";
export { parseLanguageInfo } from "./utils/language";

export type { IOptions } from "./config/options";
export type { IFlagTypes } from "./core/whisper";
export type { IShellOptions } from "./infra/shell";
export type { ITranscriptLine } from "./utils/transcription";
export type { ILanguageInfo } from "./utils/language";
export type {
  DiarizationOptions,
  DiarizationResult,
  DiarizationBackend,
  DiarizationBackendName,
} from "./core/diarization";
export type { IStreamOptions, IStreamSegment, StreamSource } from "./core/stream";
