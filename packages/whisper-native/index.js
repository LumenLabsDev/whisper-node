'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runProcess } = require('../process');
const { downloadFile } = require('../download');
const release = require('./release.json');
const RECEIPT = '.whisper-native.json';

function within(base, relative) {
  const target = path.resolve(base, relative);
  const difference = path.relative(path.resolve(base), target);
  if (!difference || path.isAbsolute(difference) || difference === '..' || difference.startsWith('..' + path.sep)) {
    throw new Error('Native asset path must stay inside its target directory');
  }
  return target;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyArchive(file, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(file) !== expected) {
    throw new Error('SHA-256 mismatch for ' + path.basename(file));
  }
}

function fileHashes(directory) {
  const hashes = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Native artifacts cannot contain symbolic links');
      if (entry.isDirectory()) visit(file);
      else if (entry.name !== RECEIPT) hashes[file.split(path.sep).join('/')] = sha256(path.join(directory, file));
    }
  }
  visit('');
  return hashes;
}

function writeReceipt(directory, artifact, pinned = release) {
  const receipt = {
    version: pinned.version, commit: pinned.commit, binaryTag: pinned.binaryTag,
    asset: artifact.name, archiveSha256: artifact.sha256, files: fileHashes(directory),
  };
  fs.writeFileSync(path.join(directory, RECEIPT), JSON.stringify(receipt, null, 2) + '\n');
}

/**
 * Microsoft Visual C++ runtime DLLs imported by the official whisper.cpp Windows builds
 * (vcomp140 is the OpenMP runtime used by ggml-cpu). x86 builds do not import vcruntime140_1.
 */
function vcRuntimeFiles(arch) {
  return ['vcruntime140.dll', 'msvcp140.dll', 'vcomp140.dll', ...(arch === 'x64' ? ['vcruntime140_1.dll'] : [])];
}
const VC_RUNTIME = new Set(vcRuntimeFiles('x64'));

function isCurrentInstall(directory, artifact, pinned = release) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, RECEIPT), 'utf8'));
    if (receipt.version !== pinned.version || receipt.commit !== pinned.commit || receipt.binaryTag !== pinned.binaryTag ||
        receipt.asset !== artifact.name || receipt.archiveSha256 !== artifact.sha256 ||
        !receipt.files?.['whisper-cli.exe']) return false;
    const actual = fileHashes(directory);
    // App-local runtime DLLs are added after installation and are not part of the pinned archive.
    for (const name of Object.keys(actual)) {
      if (VC_RUNTIME.has(name.toLowerCase()) && !(name in receipt.files)) delete actual[name];
    }
    return Object.keys(actual).length === Object.keys(receipt.files).length &&
      Object.entries(receipt.files).every(([name, hash]) => actual[name] === hash);
  } catch {
    return false;
  }
}

function verifyArchitecture(executable, arch) {
  const bytes = fs.readFileSync(executable);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid Windows executable');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x00004550) throw new Error('Invalid PE header');
  const expected = { ia32: 0x14c, x64: 0x8664 }[arch];
  if (!expected || bytes.readUInt16LE(offset + 4) !== expected) throw new Error('Unexpected native binary architecture: ' + arch);
}

function findReleaseRoot(directory) {
  if (fs.existsSync(path.join(directory, 'whisper-cli.exe'))) return directory;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findReleaseRoot(path.join(directory, entry.name));
      if (found) return found;
    }
  }
  return null;
}

/** Stage and verify every changed variant before replacing any installed files. */
async function installWindows(baseDir, options = {}) {
  const pinned = options.release || release;
  const download = options.downloadFile || downloadFile;
  const extract = options.extractArchive || ((archive, destination) => runProcess('tar', ['-xf', archive, '-C', destination]));
  const log = options.log || (() => {});
  fs.mkdirSync(baseDir, { recursive: true });
  const pending = pinned.windows.filter(artifact => !isCurrentInstall(within(baseDir, artifact.directory), artifact, pinned));
  if (!pending.length) { log('Native binaries already match ' + pinned.sourceTag + ' (' + pinned.binaryTag + ').'); return; }
  const staging = fs.mkdtempSync(within(baseDir, '.whisper-native-'));
  const prepared = [];
  const installed = [];
  let canCleanup = true;
  try {
    for (const artifact of pending) {
      log('Downloading and verifying ' + artifact.name + ' (' + pinned.binaryTag + ') ...');
      const archive = within(staging, artifact.name);
      await download(pinned.repository + '/releases/download/' + pinned.binaryTag + '/' + artifact.name, archive);
      verifyArchive(archive, artifact.sha256);
      const extracted = within(staging, artifact.directory + '-new');
      fs.mkdirSync(extracted);
      await extract(archive, extracted);
      const directory = findReleaseRoot(extracted);
      if (!directory) throw new Error('Archive has no whisper-cli.exe: ' + artifact.name);
      verifyArchitecture(path.join(directory, 'whisper-cli.exe'), artifact.arch);
      const required = ['whisper.dll', 'ggml.dll', 'ggml-base.dll'];
      if (artifact.flavor === 'blas') required.push('ggml-blas.dll', 'libopenblas.dll');
      for (const dll of required) {
        if (!fs.statSync(path.join(directory, dll)).isFile()) throw new Error('Missing ' + dll);
      }
      if (!fs.readdirSync(directory).some(name => /^ggml-cpu(?:-[a-z0-9_-]+)?\.dll$/i.test(name))) {
        throw new Error('Missing CPU backend in ' + artifact.name);
      }
      if (options.smoke !== false && process.platform === 'win32') {
        await runProcess(path.join(directory, 'whisper-cli.exe'), ['--help'], { cwd: directory });
      }
      writeReceipt(directory, artifact, pinned);
      prepared.push({ artifact, directory });
    }
    for (const { artifact, directory } of prepared) {
      const target = within(baseDir, artifact.directory);
      const backup = within(staging, artifact.directory + '-previous');
      const item = { target, backup, existed: fs.existsSync(target), backedUp: false, activated: false };
      installed.push(item);
      if (item.existed) { fs.renameSync(target, backup); item.backedUp = true; }
      fs.renameSync(directory, target);
      item.activated = true;
      log('Installed ' + artifact.directory + ': ' + pinned.sourceTag + ' (' + pinned.binaryTag + ').');
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of installed.reverse()) {
      try {
        within(baseDir, path.relative(baseDir, item.target));
        if (item.activated) fs.rmSync(item.target, { recursive: true, force: true });
        if (item.backedUp) fs.renameSync(item.backup, item.target);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) {
      canCleanup = false;
      throw new AggregateError([error, ...rollbackErrors], 'Native rollback incomplete; previous files retained in ' + staging);
    }
    throw error;
  } finally {
    // The staging directory is a direct child created by mkdtemp inside baseDir.
    const relative = path.relative(path.resolve(baseDir), path.resolve(staging));
    if (!relative.startsWith('.whisper-native-') || relative.includes(path.sep)) throw new Error('Invalid native staging path');
    within(baseDir, relative);
    if (canCleanup) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function resolveWindowsBinDir(baseDir, options = {}) {
  const directory = (options.directory ?? process.env.WHISPER_WIN_BIN_DIR ?? '').trim();
  if (directory) return within(baseDir, directory);
  const arch = options.arch || process.arch;
  const flavor = (options.flavor ?? process.env.WHISPER_WIN_FLAVOR ?? 'cpu').toLowerCase();
  const artifact = release.windows.find(item => item.arch === arch && item.flavor === flavor);
  if (artifact) return within(baseDir, artifact.directory);
  if (arch === 'x64' && ['cublas-11.8', 'cublas-12.4'].includes(flavor)) {
    return within(baseDir, flavor === 'cublas-11.8' ? 'CublasWin64-11.8' : 'CublasWin64-12.4');
  }
  throw new Error('No bundled Whisper binary for Windows ' + arch + ' / ' + flavor + '. Set WHISPER_WIN_BIN_DIR to a compatible custom build.');
}

/** Default runtime source: the Windows system directory holding DLLs of the requested architecture. */
function systemRuntimeDir(arch) {
  const windows = process.env.SystemRoot || 'C:\\Windows';
  if (process.arch === 'ia32') return path.join(windows, arch === 'x64' ? 'Sysnative' : 'System32');
  return path.join(windows, arch === 'x64' ? 'System32' : 'SysWOW64');
}

/** Find `name` for `arch` in `source` or up to two folder levels below (Visual Studio Redist layout). */
function findRuntimeDll(source, name, arch, depth = 2) {
  let entries;
  try { entries = fs.readdirSync(source, { withFileTypes: true }); } catch { return null; }
  const file = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === name);
  if (file) {
    const candidate = path.join(source, file.name);
    try { verifyArchitecture(candidate, arch); return candidate; } catch {}
  }
  if (depth > 0) {
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const found = findRuntimeDll(path.join(source, entry.name), name, arch, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Copy the Visual C++ runtime DLLs next to the native executables (app-local deployment), so the
 * binaries start on machines without the Visual C++ Redistributable. Nothing is downloaded.
 * `source` is a folder such as Visual Studio's `VC\Redist\MSVC\<version>\x64`, or 'system'.
 */
function installVcRuntime(directory, arch, source = 'system', options = {}) {
  const log = options.log || (() => {});
  const from = source === 'system' ? systemRuntimeDir(arch) : path.resolve(source);
  const copied = [];
  for (const name of vcRuntimeFiles(arch)) {
    const found = findRuntimeDll(from, name, arch);
    if (!found) throw new Error('No ' + arch + ' ' + name + ' found in ' + from);
    const target = within(directory, name);
    if (fs.existsSync(target) && sha256(target) === sha256(found)) continue;
    fs.copyFileSync(found, target);
    verifyArchitecture(target, arch);
    copied.push(name);
  }
  log((copied.length ? 'Copied ' + copied.join(', ') : 'Visual C++ runtime already present') + ' in ' + path.basename(directory) + '.');
  return copied;
}

/** Runtime DLLs of `arch` that are not next to the executables in `directory`. */
function missingVcRuntime(directory, arch) {
  return vcRuntimeFiles(arch).filter(name => !fs.existsSync(path.join(directory, name)));
}

module.exports = {
  release, installWindows, isCurrentInstall, writeReceipt, verifyArchive, verifyArchitecture, resolveWindowsBinDir,
  vcRuntimeFiles, installVcRuntime, missingVcRuntime,
};
