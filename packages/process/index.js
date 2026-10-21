'use strict';

const { spawn } = require('node:child_process');

/** Execute a program with literal arguments, never through a command shell. */
function runProcess(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let failure;
    const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
    const collect = (chunk, isError) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBuffer) {
        failure ??= new Error(`Process output exceeded ${maxBuffer} bytes`);
        child.kill();
        return;
      }
      if (isError) stderr += chunk;
      else stdout += chunk;
      if (options.silent === false) (isError ? process.stderr : process.stdout).write(chunk);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => collect(chunk, false));
    child.stderr.on('data', chunk => collect(chunk, true));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (failure) return reject(failure);
      if (code !== 0) {
        const error = new Error(stderr.trim() || stdout.trim() || `${file} exited with ${code ?? signal}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

module.exports = { runProcess };
