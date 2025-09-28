import path from "path";
import { promises as fs } from "fs";
import shell, { IShellOptions } from "./infra/shell";
import { createCppCommand, IFlagTypes } from "./core/whisper";
import transcriptToArray, { ITranscriptLine, mergeWordLevelTranscript, looksLikeWordLevelTranscript } from "./utils/transcription";
import ensureWav16kMono from "./utils/convert";
import loadConfig from "./config/config";
import { runDiarization, DiarizationOptions, DiarizationResult, assignSpeakersToTranscript } from "./core/diarization";
import { WhisperNodeError, ValidationError, safeAsync, isWhisperNodeError } from "./utils/errors";
import { createLogger } from "./utils/logger";

const logger = createLogger('main');

/**
 * Options for the top-level `whisper` API.
 */
export interface IOptions {
  modelName?: string; // name of model stored in node_modules/whisper-node/lib/whisper.cpp/models
  modelPath?: string; // custom path for model
  whisperOptions?: IFlagTypes;
  shellOptions?: IShellOptions;
  diarization?: DiarizationOptions; // optional naive diarization
}

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
): Promise<ITranscriptLine[]> => {
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

    const preparedFilePath = await safeAsync(
      () => ensureWav16kMono(filePath),
      "Failed to prepare audio file"
    );
    logger.debug('Audio file prepared', { preparedFilePath });

    const cfg = loadConfig();
    const effectiveOptions: IOptions = {
      modelName: options?.modelName ?? cfg.modelName,
      modelPath: options?.modelPath ?? cfg.modelPath,
      whisperOptions: {
        ...(cfg.whisperOptions || {}),
        ...(options?.whisperOptions || {}),
      },
      shellOptions: {
        ...(cfg.shellOptions || {}),
        ...(options?.shellOptions || {}),
      } as IShellOptions,
      diarization: options?.diarization,
    };

    const command = await createCppCommand({
      filePath: preparedFilePath, // Already normalized by createCppCommand
      modelName: effectiveOptions.modelName,
      modelPath: effectiveOptions.modelPath,
      options: effectiveOptions.whisperOptions,
    });

    const transcript = await safeAsync(
      () => shell(command, effectiveOptions.shellOptions),
      "Failed to execute whisper transcription"
    );
    logger.debug('Whisper transcription completed');

    let transcriptArray = transcriptToArray(transcript);
    logger.info('Transcript parsed', { lineCount: transcriptArray.length });

    if (looksLikeWordLevelTranscript(transcriptArray)) {
      const before = transcriptArray.length;
      transcriptArray = mergeWordLevelTranscript(transcriptArray);
      logger.info('Merged word-level lines into sentences', { before, after: transcriptArray.length });
    }

    const diarize = effectiveOptions.diarization;
    if (diarize?.enabled) {
      try {
        logger.info('Starting diarization');
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
    return transcriptArray;
  } catch (error) {
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
};

export default whisper;

export type { IFlagTypes } from "./core/whisper";
export type { IShellOptions } from "./infra/shell";
export type { ITranscriptLine } from "./utils/transcription";
export type { DiarizationOptions, DiarizationResult } from "./core/diarization";
