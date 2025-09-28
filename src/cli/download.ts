#! /usr/bin/env node

/**
 * CLI entry for downloading Whisper models using whisper.cpp helper scripts.
 *
 * Usage:
 *   npx whisper-node download
 */

import shell from "shelljs";
import path from "path";
import https from "https";
import fs from "fs";

import readlineSync from "readline-sync";

import { DEFAULT_MODEL, MODELS_PATH, SCRIPTS_PATH, NETWORK_CONSTANTS, MODEL_SCRIPT_FILENAMES } from "../config/constants";
import { MODELS_LIST as MODEL_MAP } from "../core/whisper";
import loadConfig from "../config/config";
import { createLogger } from "../utils/logger";

const logger = createLogger('download');

/**
 * Allowed model names supported by whisper.cpp download scripts.
 */
const MODELS_LIST = Object.keys(MODEL_MAP);

/**
 * Prompt the user to choose a model, validating input and allowing cancel.
 * Returns the chosen model name.
 */
const askModel = async () => {
  const answer = await readlineSync.question(
    `\n[whisper-node] Enter model name (e.g. 'base.en') or 'cancel' to exit\n(ENTER for base.en): `,
  );

  if (answer === "cancel") {
    logger.info("User cancelled model download Run again with: 'npx whisper-node download'");
    process.exit(0);
  }
  else if (answer === "") {
    logger.info("Using default model", { model: DEFAULT_MODEL });
    return DEFAULT_MODEL;
  } else if (!MODELS_LIST.includes(answer)) {
    logger.warn("Invalid model name provided", { answer, availableModels: MODELS_LIST });

    return await askModel();
  }

  return answer;
};

/**
 * Executes the interactive model downloader and triggers a build via `make`.
 * Ensures scripts exist, handles platform-specific script names, and exits
 * with useful messages on failure.
 */
export default async function downloadModel() {
  try {
    // Ensure models directory exists
    const modelsPath = MODELS_PATH;
    if (!shell.test("-d", modelsPath)) shell.mkdir("-p", modelsPath);

    logger.info(`
| Model     | Disk   | RAM     |
|-----------|--------|---------|
| tiny      |  75 MB | ~273 MB |
| tiny.en   |  75 MB | ~273 MB |
| base      | 142 MB | ~388 MB |
| base.en   | 142 MB | ~388 MB |
| small     | 466 MB | ~852 MB |
| small.en  | 466 MB | ~852 MB |
| medium    | 1.5 GB | ~2.1 GB |
| medium.en | 1.5 GB | ~2.1 GB |
| large-v1  | 2.9 GB | ~3.9 GB |
| large     | 2.9 GB | ~3.9 GB |
`);

    const cfg = loadConfig();
    const preselected = cfg.modelName;
    const modelName = preselected && MODELS_LIST.includes(preselected)
      ? preselected
      : await askModel();

    // Use bundled whisper.cpp scripts (now included in package via prepack)
    const scriptsDir = SCRIPTS_PATH;
    const posixScript = path.join(scriptsDir, MODEL_SCRIPT_FILENAMES.posix);
    const winCmdScript = path.join(scriptsDir, MODEL_SCRIPT_FILENAMES.windowsCmd);

    let usedScript = false;
    if (process.platform === 'win32') {
      logger.info('Using bundled Windows model downloader script', { script: winCmdScript, modelName });
      const r = shell.exec(`"${winCmdScript}" ${modelName} "${modelsPath}"`, { silent: false });
      if (r.code === 0) usedScript = true; else logger.warn('Model script failed, will fallback to HTTPS', { code: r.code });
    } else {
      logger.info('Using bundled POSIX model downloader script', { script: posixScript, modelName });
      shell.chmod('+x', posixScript);
      const r = shell.exec(`${posixScript} ${modelName} "${modelsPath}"`, { silent: false });
      if (r.code === 0) usedScript = true; else logger.warn('Model script failed, will fallback to HTTPS', { code: r.code });
    }

    if (!usedScript) {
      const fileName = MODEL_MAP[modelName as keyof typeof MODEL_MAP];
      if (!fileName) {
        logger.error("Unknown model specified", { modelName });
        process.exit(1);
      }
      const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName}`;
      const outPath = path.join(modelsPath, fileName);

      logger.info("Starting model download (direct)", { modelName, url, outPath });
      await downloadFile(url, outPath);
      logger.info("Model download completed", { modelName, outPath });
    } else {
      logger.info('Model download completed via whisper.cpp script');
    }

    // Windows: no build needed; Non-Windows: leave build to first runtime if missing
    if (process.platform === "win32") {
      logger.info("Windows platform detected, using precompiled binary");
    } else {
      logger.info("Non-Windows platform, binary will be built on first use if needed");
    }

    process.exit(0);
  } catch (error) {
    logger.error("Download model failed", { error });
    return error;
  }
}

downloadModel();

async function downloadFile(url: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const dir = path.dirname(dest);
    if (!shell.test("-d", dir)) shell.mkdir("-p", dir);

    const out = fs.createWriteStream(dest);
    let redirectCount = 0;
    const maxRedirects = NETWORK_CONSTANTS.MAX_REDIRECTS;
    
    const get = (href: string) => {
      https.get(href, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          out.close();
          try { fs.unlinkSync(dest); } catch {}
          
          if (redirectCount >= maxRedirects) {
            return reject(new Error(`Too many redirects (${maxRedirects}) for ${href}`));
          }
          redirectCount++;
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          out.close();
          try { fs.unlinkSync(dest); } catch {}
          return reject(new Error(`HTTP ${res.statusCode} for ${href}`));
        }
        res.pipe(out);
        out.on("finish", () => {
          out.close();
          resolve();
        });
      }).on("error", (err) => {
        try { out.close(); fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    };
    get(url);
  });
}


