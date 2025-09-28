import path from "path";
import shell, { ExecOptions } from "shelljs";
import { createLogger } from "../utils/logger";

const logger = createLogger('shell');

/**
 * Paths for running and verifying the whisper.cpp binary.
 * docs: https://github.com/ggerganov/whisper.cpp
 */
const WHISPER_CPP_PATH = path.join(__dirname, "..", "..", "lib/whisper.cpp");
const MAIN = process.platform === 'win32' ? "./whisper-cli.exe" : "./main";

/**
 * Resolve the appropriate Windows binary directory based on environment variables.
 * @param baseDir Base whisper.cpp directory
 * @returns Path to the appropriate Windows binary directory
 */
function resolveWindowsBinDir(baseDir: string): string {
  const fromEnv = (process.env.WHISPER_WIN_BIN_DIR || '').trim();
  if (fromEnv) {
    // Validate environment path to prevent directory traversal
    const normalizedPath = path.normalize(fromEnv);
    if (normalizedPath.includes('..') || path.isAbsolute(normalizedPath)) {
      logger.warn('Invalid WHISPER_WIN_BIN_DIR, using default', { providedPath: fromEnv });
      return path.join(baseDir, 'Win64');
    }
    logger.debug('Using custom Windows binary directory', { path: normalizedPath });
    return path.join(baseDir, normalizedPath);
  }
  
  const flavor = (process.env.WHISPER_WIN_FLAVOR || 'cpu').toLowerCase();
  logger.debug('Resolving Windows binary directory', { flavor });
  
  switch (flavor) {
    case 'cpu':
      return path.join(baseDir, 'Win64');
    case 'blas':
      return path.join(baseDir, 'BlasWin64');
    case 'cublas-11.8':
      return path.join(baseDir, 'CublasWin64-11.8');
    case 'cublas-12.4':
      return path.join(baseDir, 'CublasWin64-12.4');
    default:
      logger.warn('Unknown flavor, using default', { flavor });
      return path.join(baseDir, 'Win64');
  }
}

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
const defaultShellOptions: IShellOptions = {
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
): Promise<string> {
  logger.info('Executing whisper shell command', { command, options });
  
  return new Promise(async (resolve, reject) => {
    try {
      if (!shell.test("-d", WHISPER_CPP_PATH)) {
        logger.error('Whisper.cpp directory not found', { path: WHISPER_CPP_PATH });
        return reject(new Error("[whisper-node] whisper.cpp directory not found. Reinstall or run the downloader CLI."));
      }

      const originalCwd = shell.pwd().toString();
      let runDir = WHISPER_CPP_PATH;
      if (process.platform === 'win32') {
        const candidate = resolveWindowsBinDir(WHISPER_CPP_PATH);
        if (shell.test('-d', candidate)) runDir = candidate;
      }
      shell.pushd("-q", runDir);

      if (process.platform === 'win32') {
        if (!shell.test('-f', './whisper-cli.exe') && !shell.test('-f', './main.exe')) {
          shell.popd('-q');
          return reject(new Error('[whisper-node] Windows binary not found. Reinstall the package to fetch precompiled release (see README).'));
        }
      } else {
        const hasBinary = shell.test('-f', MAIN) || shell.test('-f', './whisper-cli') || shell.which('main') || shell.which('whisper-cli');
        if (!hasBinary) {
          logger.info('Building whisper.cpp binary (non-Windows)');
          shell.echo('[whisper-node] Building whisper.cpp (non-Windows)...');
          const makeResult = shell.exec('make', {
            silent: defaultShellOptions.silent,
            async: false
          } as ExecOptions) as shell.ShellString;
          if (makeResult.code !== 0) {
            logger.error('Build failed', { exitCode: makeResult.code, stderr: makeResult.stderr });
            shell.popd('-q');
            return reject(new Error('[whisper-node] Build failed. Install build tools (make/gcc/clang).'));
          }
          logger.info('Build completed successfully');
        }
      }

      shell.exec(
        command,
        options,
        (code: number, stdout: string, stderr: string) => {
          shell.popd("-q");
          if (shell.pwd().toString() !== originalCwd) {
            try {
              shell.cd(originalCwd);
            } catch {}
          }
          if (code === 0) {
            resolve(stdout);
          } else {
            if (process.platform === 'win32' && code === 3221225781) {
              reject(new Error('[whisper-node] Failed to start whisper binary (0xC0000135). Missing Microsoft Visual C++ Redistributable (x64). Install the 2015–2022 package and retry.'));
              return;
            }
            const errOut = (stderr || '').trim();
            const out = (stdout || '').trim();
            const combined = errOut || out || `[whisper-node] whisper.cpp exited with code ${code}`;
            reject(new Error(combined));
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


