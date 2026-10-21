#!/usr/bin/env node

import path from "node:path";
import { question } from "../../packages/prompt";
import { downloadFile } from "../../packages/download";
import { DEFAULT_MODEL, MODELS_PATH, NETWORK_CONSTANTS } from "../config/constants";
import { MODELS_LIST as MODEL_MAP } from "../core/whisper";
import loadConfig from "../config/config";
import { createLogger } from "../utils/logger";

const logger = createLogger("download");
const MODELS_LIST = Object.keys(MODEL_MAP);

async function askModel(): Promise<string | null> {
  while (true) {
    const answer = await question(
      "\n[whisper-node] Enter model name (e.g. 'base.en') or 'cancel' to exit\n(ENTER for base.en): ",
    );
    if (answer.toLowerCase() === "cancel") return null;
    if (!answer) return DEFAULT_MODEL;
    if (MODELS_LIST.includes(answer)) return answer;
    logger.warn("Invalid model name", { answer, availableModels: MODELS_LIST });
  }
}

export default async function downloadModel(): Promise<void> {
  const configured = loadConfig().modelName;
  const modelName = configured && MODELS_LIST.includes(configured) ? configured : await askModel();
  if (!modelName) return;
  const fileName = MODEL_MAP[modelName as keyof typeof MODEL_MAP];
  const outPath = path.join(MODELS_PATH, fileName);
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName}`;
  logger.info("Starting model download", { modelName, outPath });
  await downloadFile(url, outPath, {
    maxRedirects: NETWORK_CONSTANTS.MAX_REDIRECTS,
    timeoutMs: NETWORK_CONSTANTS.DOWNLOAD_TIMEOUT_MS,
  });
  logger.info("Model download completed", { modelName, outPath });
}

if (require.main === module) {
  downloadModel().catch(error => {
    logger.error("Download model failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
