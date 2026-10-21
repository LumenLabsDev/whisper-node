'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const {
  installWindows, writeReceipt, isCurrentInstall, verifyArchive, verifyArchitecture, resolveWindowsBinDir,
} = require('../packages/whisper-native');

let temporary;
before(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-native-test-')); });
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function executable(arch) {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(arch === 'ia32' ? 0x14c : 0x8664, 68);
  return bytes;
}
function fixtureRelease() {
  return {
    version: 'fixture-version', sourceTag: 'fixture-tag', binaryTag: 'fixture-build', commit: 'fixture-commit',
    repository: 'https://example.test',
    windows: [
      { name: 'cpu.zip', directory: 'Win32', arch: 'ia32', flavor: 'cpu', sha256: hash('cpu.zip') },
      { name: 'blas.zip', directory: 'BlasWin64', arch: 'x64', flavor: 'blas', sha256: hash('blas.zip') },
    ],
  };
}
function writeBinaries(directory, artifact) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'whisper-cli.exe'), executable(artifact.arch));
  const dlls = ['whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu.dll'];
  if (artifact.flavor === 'blas') dlls.push('ggml-blas.dll', 'libopenblas.dll');
  for (const dll of dlls) fs.writeFileSync(path.join(directory, dll), 'fixture ' + dll);
}
function installer(pinned) {
  let downloads = 0;
  return {
    get downloads() { return downloads; },
    options: {
      release: pinned, smoke: false,
      downloadFile: async (url, destination) => { downloads++; fs.writeFileSync(destination, path.posix.basename(url)); },
      extractArchive: async (archive, destination) => {
        const artifact = pinned.windows.find(item => item.name === path.basename(archive));
        writeBinaries(path.join(destination, 'Release'), artifact);
      },
    },
  };
}

test('native receipts detect old versions, damaged DLLs and missing files', () => {
  const pinned = fixtureRelease();
  const artifact = pinned.windows[0];
  const directory = path.join(temporary, 'receipt');
  writeBinaries(directory, artifact);
  assert.equal(isCurrentInstall(directory, artifact, pinned), false);
  writeReceipt(directory, artifact, pinned);
  assert.equal(isCurrentInstall(directory, artifact, pinned), true);
  assert.equal(isCurrentInstall(directory, artifact, { ...pinned, version: 'new-version' }), false);
  fs.writeFileSync(path.join(directory, 'whisper.dll'), 'changed');
  assert.equal(isCurrentInstall(directory, artifact, pinned), false);
  writeReceipt(directory, artifact, pinned);
  fs.unlinkSync(path.join(directory, 'ggml.dll'));
  assert.equal(isCurrentInstall(directory, artifact, pinned), false);
});

test('archive checksums and Windows executable architectures are verified', () => {
  const archive = path.join(temporary, 'asset.zip');
  fs.writeFileSync(archive, 'archive fixture');
  verifyArchive(archive, hash('archive fixture'));
  assert.throws(() => verifyArchive(archive, hash('different archive')), /SHA-256 mismatch/);
  for (const arch of ['ia32', 'x64']) {
    const file = path.join(temporary, arch + '.exe');
    fs.writeFileSync(file, executable(arch));
    verifyArchitecture(file, arch);
    assert.throws(() => verifyArchitecture(file, arch === 'ia32' ? 'x64' : 'ia32'), /architecture/);
  }
  const bad = path.join(temporary, 'invalid.exe');
  fs.writeFileSync(bad, 'invalid PE');
  assert.throws(() => verifyArchitecture(bad, 'x64'), /Invalid Windows/);
});

test('CPU and BLAS selection matches Node architecture and rejects directory escape', () => {
  const base = path.join(temporary, 'selection');
  assert.equal(resolveWindowsBinDir(base, { arch: 'ia32', flavor: 'cpu', directory: '' }), path.join(base, 'Win32'));
  assert.equal(resolveWindowsBinDir(base, { arch: 'ia32', flavor: 'blas', directory: '' }), path.join(base, 'BlasWin32'));
  assert.equal(resolveWindowsBinDir(base, { arch: 'x64', flavor: 'blas', directory: '' }), path.join(base, 'BlasWin64'));
  assert.throws(() => resolveWindowsBinDir(base, { directory: '../escape' }), /inside/);
  assert.throws(() => resolveWindowsBinDir(base, { arch: 'ia32', flavor: 'cublas-12.4', directory: '' }), /No bundled/);
});

test('native replacement removes stale DLLs, preserves models and reuses verified installs', async () => {
  const base = path.join(temporary, 'install');
  const pinned = fixtureRelease();
  const tool = installer(pinned);
  for (const artifact of pinned.windows) {
    writeBinaries(path.join(base, artifact.directory), artifact);
    fs.writeFileSync(path.join(base, artifact.directory, 'obsolete.dll'), 'old');
  }
  fs.mkdirSync(path.join(base, 'models'));
  fs.writeFileSync(path.join(base, 'models', 'user-model.bin'), 'keep model');
  await installWindows(base, tool.options);
  for (const artifact of pinned.windows) {
    assert.equal(isCurrentInstall(path.join(base, artifact.directory), artifact, pinned), true);
    assert.equal(fs.existsSync(path.join(base, artifact.directory, 'obsolete.dll')), false);
  }
  assert.equal(fs.readFileSync(path.join(base, 'models', 'user-model.bin'), 'utf8'), 'keep model');
  await installWindows(base, tool.options);
  assert.equal(tool.downloads, pinned.windows.length);
  assert.equal(fs.readdirSync(base).some(name => name.startsWith('.whisper-native-')), false);
});

test('a corrupted download leaves every previous variant intact', async () => {
  const base = path.join(temporary, 'bad-download');
  const pinned = fixtureRelease();
  const tool = installer(pinned);
  for (const artifact of pinned.windows) writeBinaries(path.join(base, artifact.directory), artifact);
  const original = pinned.windows.map(artifact => fs.readFileSync(path.join(base, artifact.directory, 'whisper.dll'), 'utf8'));
  let count = 0;
  tool.options.downloadFile = async (url, destination) => {
    fs.writeFileSync(destination, count++ ? 'corrupted second archive' : path.posix.basename(url));
  };
  await assert.rejects(installWindows(base, tool.options), /SHA-256 mismatch/);
  assert.deepEqual(pinned.windows.map(artifact => fs.readFileSync(path.join(base, artifact.directory, 'whisper.dll'), 'utf8')), original);
  assert.equal(fs.readdirSync(base).some(name => name.startsWith('.whisper-native-')), false);
});

test('a replacement failure rolls back variants already switched', async t => {
  const base = path.join(temporary, 'rollback');
  const pinned = fixtureRelease();
  const tool = installer(pinned);
  for (const artifact of pinned.windows) {
    writeBinaries(path.join(base, artifact.directory), artifact);
    fs.writeFileSync(path.join(base, artifact.directory, 'previous.dll'), 'preserve previous');
  }
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === path.join(base, 'BlasWin64') && source.includes('BlasWin64-new')) {
      throw new Error('replacement fixture failure');
    }
    return rename(source, destination);
  });
  await assert.rejects(installWindows(base, tool.options), /replacement fixture/);
  for (const artifact of pinned.windows) {
    assert.equal(fs.readFileSync(path.join(base, artifact.directory, 'previous.dll'), 'utf8'), 'preserve previous');
  }
  assert.equal(fs.readdirSync(base).some(name => name.startsWith('.whisper-native-')), false);
});
