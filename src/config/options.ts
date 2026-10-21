import { IFlagTypes } from "../core/whisper";
import { IShellOptions } from "../infra/shell";
import { DiarizationOptions } from "../core/diarization";
import loadConfig from "./config";
import { createLogger } from "../utils/logger";

const logger = createLogger('options');

/**
 * Options for the top-level `whisper` API.
 */
export interface IOptions {
  modelName?: string; // name of model stored in node_modules/whisper-node/lib/whisper.cpp/models
  modelPath?: string; // custom path for model
  whisperOptions?: IFlagTypes;
  shellOptions?: IShellOptions;
  diarization?: DiarizationOptions; // optional speaker diarization
}

/** Merge configuration file values with call options. API values win. */
export function resolveOptions(options?: IOptions): IOptions {
  const cfg = loadConfig();
  return {
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
}

/** Warn when tinydiarize is requested with a model that was not fine-tuned for it. */
export function warnIfNotTinydiarizeModel(options: IOptions): void {
  const model = `${options.modelName ?? ""} ${options.modelPath ?? ""}`;
  if (!/tdrz/i.test(model)) {
    logger.warn("The tinydiarize backend requires a tdrz model such as 'small.en-tdrz'; speaker turns may be missing", {
      modelName: options.modelName,
      modelPath: options.modelPath,
    });
  }
}
