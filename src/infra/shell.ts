import path from "path";
import shell from "shelljs";

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
      const originalCwd = shell.pwd().toString();
      shell.pushd("-q", WHISPER_CPP_PATH);

      // ensure command exists in local path
      if (!shell.which(WHISPER_CPP_MAIN_PATH)) {
        shell.echo(
          "[whisper-node] whisper.cpp not initialized. Attempting to run 'make' in lib/whisper.cpp...",
        );
        const makeResult = shell.exec("make", defaultShellOptions);
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


