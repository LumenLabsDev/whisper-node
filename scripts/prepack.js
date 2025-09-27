#!/usr/bin/env node

// Cross-platform prepack script to bundle ggml-org/whisper.cpp into lib/
// - Uses only Node built-ins (fs, path, child_process)
// - Pins to tag v1.7.6
// - Safe to run multiple times; re-clones when directory is missing
// - If git is unavailable or clone fails, logs a warning and proceeds; runtime will auto-clone

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'lib');
const DST = path.join(LIB_DIR, 'whisper.cpp');
const REPO = 'https://github.com/ggml-org/whisper.cpp';
const TAG = 'v1.7.6';

function log(msg) {
  // Keep messages concise for npm output
  console.log(`[whisper-node prepack] ${msg}`);
}

function hasGit() {
  const res = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return res.status === 0;
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function isWhisperCppDir(p) {
  // Heuristic: presence of these files indicates a valid checkout
  try {
    return (
      fs.existsSync(path.join(p, 'README.md')) &&
      (fs.existsSync(path.join(p, 'Makefile')) || fs.existsSync(path.join(p, 'CMakeLists.txt')))
    );
  } catch {
    return false;
  }
}

function cloneRepo() {
  log(`Cloning ${REPO} (${TAG}) into ${path.relative(ROOT, DST)} ...`);
  const args = ['clone', '--branch', TAG, '--depth', '1', REPO, DST];
  const res = spawnSync('git', args, { stdio: 'inherit' });
  if (res.status !== 0) {
    log('Warning: failed to clone whisper.cpp. The package will still publish; runtime will fetch it on-demand.');
  } else {
    log('Clone completed.');
  }
}

function main() {
  try {
    ensureDir(LIB_DIR);
    if (isWhisperCppDir(DST)) {
      log('whisper.cpp already present. Skipping clone.');
      return;
    }

    if (!hasGit()) {
      log("Warning: 'git' not available. Skipping bundling whisper.cpp (runtime will auto-clone).");
      return;
    }

    // If a non-empty wrong directory exists, remove it and re-clone
    if (exists(DST)) {
      try {
        fs.rmSync(DST, { recursive: true, force: true });
      } catch (e) {
        log(`Warning: could not clean existing directory: ${e?.message || e}`);
      }
    }

    cloneRepo();
  } catch (e) {
    log(`Warning: prepack encountered an error: ${e?.message || e}`);
  }
}

main();


