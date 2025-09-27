#! /usr/bin/env node

/**
 * CLI entry for downloading Whisper models using whisper.cpp helper scripts.
 *
 * Usage:
 *   npx whisper-node download
 */

import shell from "shelljs";

import readlineSync from "readline-sync";

import { DEFAULT_MODEL, NODE_MODULES_MODELS_PATH } from "../config/constants";
import loadConfig from "../config/loadConfig";

/**
 * Allowed model names supported by whisper.cpp download scripts.
 */
const MODELS_LIST = [
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v1",
  "large",
];

/**
 * Prompt the user to choose a model, validating input and allowing cancel.
 * Returns the chosen model name.
 */
const askModel = async () => {
  const answer = await readlineSync.question(
    `\n[whisper-node] Enter model name (e.g. 'base.en') or 'cancel' to exit\n(ENTER for base.en): `,
  );

  if (answer === "cancel") {
    console.log(
      "[whisper-node] Exiting model downloader. Run again with: 'npx whisper-node download'",
    );
    process.exit(0);
  }
  // user presses enter
  else if (answer === "") {
    console.log("[whisper-node] Going with", DEFAULT_MODEL);
    return DEFAULT_MODEL;
  } else if (!MODELS_LIST.includes(answer)) {
    console.log(
      "\n[whisper-node] FAIL: Name not found. Check your spelling OR quit wizard and use custom model.",
    );

    // re-ask question
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
    // shell.exec("echo $PWD");
    shell.cd(NODE_MODULES_MODELS_PATH);

    console.log(`
| Model     | Disk   | RAM     |
|-----------|--------|---------|
| tiny      |  75 MB | ~390 MB |
| tiny.en   |  75 MB | ~390 MB |
| base      | 142 MB | ~500 MB |
| base.en   | 142 MB | ~500 MB |
| small     | 466 MB | ~1.0 GB |
| small.en  | 466 MB | ~1.0 GB |
| medium    | 1.5 GB | ~2.6 GB |
| medium.en | 1.5 GB | ~2.6 GB |
| large-v1  | 2.9 GB | ~4.7 GB |
| large     | 2.9 GB | ~4.7 GB |
`);

    // ensure running in correct path and scripts exist
    const shScript = "./download-ggml-model.sh";
    const cmdScript = "download-ggml-model.cmd";

    if (!shell.test("-f", shScript) && !shell.test("-f", cmdScript)) {
      throw "[whisper-node] Downloader scripts not found. Ensure 'lib/whisper.cpp/models' exists and contains download scripts.";
    }

    const cfg = loadConfig();
    const preselected = cfg.modelName;
    const modelName = preselected && MODELS_LIST.includes(preselected)
      ? preselected
      : await askModel();

    // default is .sh
    let scriptPath = shScript;
    // windows .cmd version
    if (process.platform === "win32") scriptPath = cmdScript;

    const downloadResult = shell.exec(`${scriptPath} ${modelName}`);
    if (downloadResult.code !== 0) {
      console.log(
        "[whisper-node] Download failed. Please check your network and try again.",
      );
      process.exit(1);
    }

    console.log("[whisper-node] Attempting to compile model...");

    // move up directory, run make in whisper.cpp
    shell.cd("../");
    // this has to run in whichever directory the model is located in??
    const makeResult = shell.exec("make");
    if (makeResult.code !== 0) {
      console.log(
        "[whisper-node] 'make' failed. On Windows, ensure you have 'make' installed (see README). On macOS/Linux, ensure build tools are installed.",
      );
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    console.log("ERROR Caught in downloadModel");
    console.log(error);
    return error;
  }
}

// runs after being called in package.json
downloadModel();


