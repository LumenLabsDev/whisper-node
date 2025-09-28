import path from "path";
import shell, { ExecOptions } from "shelljs";

/**
 * Paths for running and verifying the whisper.cpp binary.
 * docs: https://github.com/ggerganov/whisper.cpp
 */
const WHISPER_CPP_PATH = path.join(__dirname, "..", "..", "lib/whisper.cpp");
const WHISPER_CPP_MAIN_PATH = process.platform === 'win32' ? "./main.exe" : "./main";

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
        const cloneCmd = `git clone --branch v1.7.6 --depth 1 https://github.com/ggml-org/whisper.cpp "${WHISPER_CPP_PATH}"`;
        const cloneRes = shell.exec(cloneCmd);
        if (cloneRes.code !== 0) {
          return reject("[whisper-node] Failed to clone whisper.cpp repository.");
        }
      }

      const originalCwd = shell.pwd().toString();
      shell.pushd("-q", WHISPER_CPP_PATH);

      // ensure command exists in local path (check both main and whisper-cli)
      const MAIN = WHISPER_CPP_MAIN_PATH;
      const CLI = process.platform === 'win32' ? './whisper-cli.exe' : './whisper-cli';
      const hasBinary = shell.test('-f', MAIN) || shell.test('-f', CLI) || shell.which(MAIN) || shell.which(CLI);
      if (!hasBinary) {
        shell.echo(
          "[whisper-node] whisper.cpp not initialized. Attempting to build in lib/whisper.cpp...",
        );
        let buildOk = false;
        if (process.platform !== 'win32' || shell.which('make')) {
          const makeResult = shell.exec(
            "make",
            defaultShellOptions as unknown as ExecOptions & { async: false },
          );
          buildOk = makeResult.code === 0;
        } else if (shell.which('cmake')) {
          const gen = shell.exec(
            "cmake -S . -B build -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF",
            defaultShellOptions as unknown as ExecOptions & { async: false },
          );
          if (gen.code === 0) {
            const b = shell.exec(
              "cmake --build build --config Release -j 4",
              defaultShellOptions as unknown as ExecOptions & { async: false },
            );
            buildOk = b.code === 0;
            if (buildOk) {
              const candidates = [
                "build/bin/Release/whisper-cli.exe",
                "build/bin/Release/main.exe",
                "build/bin/whisper-cli.exe",
                "build/bin/main.exe",
              ];
              let found = '';
              for (const c of candidates) if (shell.test('-f', c)) { found = c; break; }
              if (found) {
                shell.cp('-f', found, './main.exe');
                if (!shell.test('-f', './whisper-cli.exe')) shell.cp('-f', found, './whisper-cli.exe');
              }
            }
          }
        }

        const nowHasBinary = shell.test('-f', MAIN) || shell.test('-f', CLI) || shell.which(MAIN) || shell.which(CLI);
        if (!buildOk || !nowHasBinary) {
          shell.popd("-q");
          return reject(
            "[whisper-node] Build failed. Install 'make' or 'cmake'+MSVC on Windows; build tools on macOS/Linux.",
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
          if (code === 0) {
            resolve(stdout);
          } else {
            const errOut = (stderr || "").trim();
            const out = (stdout || "").trim();
            const combined = errOut || out || `[whisper-node] whisper.cpp exited with code ${code}`;
            reject(combined);
          }
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


