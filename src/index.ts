import path from "path";
import shell, { IShellOptions } from "./infra/shell";
import { createCppCommand, IFlagTypes } from "./core/whisper";
import transcriptToArray, { ITranscriptLine } from "./utils/tsToArray";
import ensureWav16kMono from "./utils/convert";
import loadConfig from "./config/loadConfig";
import { runDiarization, DiarizationOptions, DiarizationResult, assignSpeakersToTranscript } from "./core/diarization";

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
  try {
    console.log("[whisper-node] Transcribing:", filePath, "\n");

    // 0. Ensure audio is WAV 16kHz mono; auto-convert if needed
    const preparedFilePath = await ensureWav16kMono(filePath);

    // 0.5 Load config and merge with provided options (options override config)
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
    };

    // todo: combine steps 1 & 2 into sepparate function called whisperCpp (createCppCommand + shell)

    // 1. create command string for whisper.cpp
    const command = createCppCommand({
      filePath: path.normalize(preparedFilePath),
      modelName: effectiveOptions.modelName,
      modelPath: effectiveOptions.modelPath
        ? path.normalize(effectiveOptions.modelPath)
        : undefined,
      options: effectiveOptions.whisperOptions,
    });

    // 2. run command in whisper.cpp directory
    // todo: add return for continually updated progress value
    const transcript = await shell(command, effectiveOptions.shellOptions);

    // 3. parse whisper response string into array
    let transcriptArray = transcriptToArray(transcript);

    // 4. Optional diarization and speaker merge
    const diarize = effectiveOptions.diarization;
    if (diarize?.enabled) {
      try {
        const dia: DiarizationResult = await runDiarization(preparedFilePath, diarize);
        transcriptArray = assignSpeakersToTranscript(transcriptArray, dia);
      } catch (e) {
        console.log("[whisper-node] Diarization failed:", e);
      }
    }

    return transcriptArray;
  } catch (error) {
    console.log("[whisper-node] Problem:", error);
    throw error;
  }
};

export default whisper;

// Public types re-exports for consumers
export type { IFlagTypes } from "./core/whisper";
export type { IShellOptions } from "./infra/shell";
export type { ITranscriptLine } from "./utils/tsToArray";
export type { DiarizationOptions, DiarizationResult } from "./core/diarization";
