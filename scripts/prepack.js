#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { release, installWindows } = require('../packages/whisper-native');
const { downloadFile } = require('../packages/download');
const { runProcess } = require('../packages/process');

const ROOT = path.resolve(__dirname, '..');
const DST = path.join(ROOT, 'lib', 'whisper.cpp');
const log = message => console.log('[whisper-node native] ' + message);

async function setupSources() {
  if (fs.existsSync(path.join(DST, 'CMakeLists.txt'))) {
    const version = fs.readFileSync(path.join(DST, 'CMakeLists.txt'), 'utf8');
    const fields = ['MAJOR', 'MINOR', 'PATCH'].map(field =>
      version.match(new RegExp('set\\(WHISPER_VERSION_' + field + '\\s+(\\d+)\\)'))?.[1]);
    if (fields.join('.') !== release.version) {
      throw new Error('Existing whisper.cpp sources are not ' + release.sourceTag + '. Preserve local source changes before replacing them with the pinned upstream commit.');
    }
    return;
  }
  // A temporary clone prevents git metadata and partial downloads entering the npm archive.
  const temporary = fs.mkdtempSync(path.join(ROOT, '.whisper-source-'));
  const source = path.join(temporary, 'source');
  try {
    await runProcess('git', ['clone', '--branch', release.sourceTag, '--depth', '1', release.repository, source]);
    const { stdout } = await runProcess('git', ['-c', 'safe.directory=' + source, 'rev-parse', 'HEAD'], { cwd: source });
    if (stdout.trim() !== release.commit) throw new Error('Unexpected whisper.cpp source commit');
    fs.mkdirSync(DST, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      if (name === '.git') continue;
      fs.cpSync(path.join(source, name), path.join(DST, name), { recursive: true });
    }
    log('Prepared sources at ' + release.sourceTag + '.');
  } finally {
    const relative = path.relative(ROOT, path.resolve(temporary));
    if (!relative.startsWith('.whisper-source-') || relative.includes(path.sep)) throw new Error('Invalid source staging directory');
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function setupSupportFiles() {
  const { verifyArchive } = require('../packages/whisper-native');
  for (const file of release.supportFiles || []) {
    const destination = path.resolve(DST, file.path);
    const relative = path.relative(DST, destination);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
      throw new Error('Invalid support file path');
    }
    try {
      verifyArchive(destination, file.sha256);
      continue;
    } catch {}
    log('Updating ' + file.path + ' ...');
    // downloadFile replaces an existing file only after a completed download.
    const temporary = destination + '.new';
    try {
      await downloadFile(file.url, temporary);
      verifyArchive(temporary, file.sha256);
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

/**
 * Optional app-local Visual C++ runtime: `npm run native:setup -- --vcruntime[=<folder>]`
 * or WHISPER_NODE_VCRUNTIME=<folder>|system. Copies local files only; nothing is downloaded.
 */
function vcRuntimeSource(argv = process.argv.slice(2)) {
  const flag = argv.find(arg => arg === '--vcruntime' || arg.startsWith('--vcruntime='));
  if (flag) return flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) || 'system' : 'system';
  return process.env.WHISPER_NODE_VCRUNTIME?.trim() || null;
}

function setupVcRuntime(source) {
  const { installVcRuntime } = require('../packages/whisper-native');
  for (const artifact of release.windows) {
    const directory = path.join(DST, artifact.directory);
    if (fs.existsSync(directory)) installVcRuntime(directory, artifact.arch, source, { log });
  }
}

async function setupNative() {
  fs.mkdirSync(DST, { recursive: true });
  if (process.platform === 'win32') {
    await installWindows(DST, { log });
    const source = vcRuntimeSource();
    if (source) setupVcRuntime(source);
  } else await setupSources();
  await setupSupportFiles();
  fs.mkdirSync(path.join(DST, 'models'), { recursive: true });
  log('Native assets ready: ' + release.sourceTag + ' (' + release.binaryTag + ').');
}

module.exports = { setupNative, vcRuntimeSource };
if (require.main === module) {
  setupNative().catch(error => {
    console.error('[whisper-node native] ' + error.message);
    process.exitCode = 1;
  });
}
