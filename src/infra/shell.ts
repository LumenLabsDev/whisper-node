import path from "path";
import shell, { ExecOptions } from "shelljs";

/**
 * Paths for running and verifying the whisper.cpp binary.
 * docs: https://github.com/ggerganov/whisper.cpp
 */
const WHISPER_CPP_PATH = path.join(__dirname, "..", "..", "lib/whisper.cpp");
const WHISPER_CPP_MAIN_PATH = "./main";

/**
 * Options forwarded to shelljs.exec.
 * - silent: true will suppress console output
 * - async: whether to run asynchronously (we use the callback API regardless)
 */
export interface IShellOptions {
  silent: boolean; // true: won't print to console
  async: boolean;
}

/**
 * Default options for shelljs.exec calls.
 */
const defaultShellOptions = {
  silent: true, // true: won't print to console
  async: false,
};

/**
 * Execute a command inside the whisper.cpp directory, ensuring the binary exists.
 * If missing, attempts to build via `make`. Restores the original working directory.
 *
 * @param command Fully constructed whisper.cpp command (from core/whisper)
 * @param options ShellJS execution options
 * @returns Resolves with stdout on success, rejects with stderr or error on failure
 */
export default async function whisperShell(
  command: string,
  options: IShellOptions = defaultShellOptions,
): Promise<any> {
  return new Promise(async (resolve, reject) => {
    try {
      // Ensure whisper.cpp exists (clone on demand if missing)
      if (!shell.test("-d", WHISPER_CPP_PATH)) {
        const libDir = path.join(__dirname, "..", "..", "lib");
        if (!shell.test("-d", libDir)) shell.mkdir("-p", libDir);
        const gitCheck = shell.exec("git --version", { silent: true });
        if (gitCheck.code !== 0) {
          return reject(
            "[whisper-node] whisper.cpp not found and 'git' is unavailable to fetch it. Install git or run the downloader CLI to set up models.",
          );
        }
        const cloneCmd = `git clone --depth 1 https://github.com/ggml-org/whisper.cpp "${WHISPER_CPP_PATH}"`;
        const cloneRes = shell.exec(cloneCmd);
        if (cloneRes.code !== 0) {
          return reject("[whisper-node] Failed to clone whisper.cpp repository.");
        }
      }

      const originalCwd = shell.pwd().toString();
      shell.pushd("-q", WHISPER_CPP_PATH);

      // ensure command exists in local path
      if (!shell.which(WHISPER_CPP_MAIN_PATH)) {
        shell.echo(
          "[whisper-node] whisper.cpp not initialized. Attempting to run 'make' in lib/whisper.cpp...",
        );
        const makeResult = shell.exec(
          "make",
          defaultShellOptions as unknown as ExecOptions & { async: false },
        );
        if (makeResult.code !== 0 || !shell.which(WHISPER_CPP_MAIN_PATH)) {
          shell.popd("-q");
          return reject(
            "[whisper-node] 'make' failed. Ensure build tools are installed (see README).",
          );
        }
      }

      // docs: https://github.com/shelljs/shelljs#execcommand--options--callback
      shell.exec(
        command,
        options,
        (code: number, stdout: string, stderr: string) => {
          shell.popd("-q");
          // restore in case pushd failed silently
          if (shell.pwd().toString() !== originalCwd) {
            try {
              shell.cd(originalCwd);
            } catch {}
          }
          if (code === 0) resolve(stdout);
          else reject(stderr);
        },
      );
    } catch (error) {
      try {
        shell.popd("-q");
      } catch {}
      reject(error);
    }
  });
}


