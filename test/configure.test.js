'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { configure, getRuntimeConfig, cleanupTempFiles, transcribeStream } = require('../dist/index');
const { resetRuntimeConfig, unpackedAsarPath, modelsPath } = require('../dist/config/runtime');
const { resolveBinDir } = require('../dist/infra/native');
const { createCppInvocation } = require('../dist/core/whisper');
const shellModule = require('../dist/infra/shell');
const { makeWav } = require('./support/wav');

let temporary;
const realShell = shellModule.default;
const ENV = ['WHISPER_NODE_ROOT', 'WHISPER_NODE_MODELS', 'WHISPER_NODE_TMPDIR', 'WHISPER_WIN_BIN_DIR', 'WHISPER_WIN_FLAVOR'];
const savedEnv = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
before(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-configure-test-')); });
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });
afterEach(() => {
  resetRuntimeConfig();
  shellModule.default = realShell;
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function dir(...parts) {
  const target = path.join(temporary, ...parts);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

test('configure accepts absolute paths only, rejects unknown keys and resets with null', () => {
  const root = dir('cfg-root');
  assert.throws(() => configure({ nativeRoot: 'relative/bin' }), /absolute path/);
  assert.throws(() => configure({ modelsPath: '' }), /non-empty/);
  assert.throws(() => configure({ nativeRot: root }), /Unknown runtime option/);
  assert.throws(() => configure({ flavor: '../x' }), /variant name/);
  const effective = configure({ nativeRoot: root, flavor: 'BLAS' });
  assert.equal(effective.nativeRoot, root);
  assert.equal(effective.modelsPath, path.join(root, 'models'));
  assert.equal(effective.flavor, 'blas');
  configure({ nativeRoot: null, flavor: null });
  assert.notEqual(getRuntimeConfig().nativeRoot, root);
  assert.equal(getRuntimeConfig().flavor, 'cpu');
});

test('environment variables relocate native files and models; configure wins over them', () => {
  const envRoot = dir('env-root');
  const envModels = dir('env-models');
  process.env.WHISPER_NODE_ROOT = envRoot;
  assert.equal(getRuntimeConfig().nativeRoot, envRoot);
  assert.equal(modelsPath(), path.join(envRoot, 'models'));
  process.env.WHISPER_NODE_MODELS = envModels;
  assert.equal(modelsPath(), envModels);
  const apiRoot = dir('api-root');
  configure({ nativeRoot: apiRoot });
  assert.equal(getRuntimeConfig().nativeRoot, apiRoot);
  assert.equal(modelsPath(), envModels);
  process.env.WHISPER_NODE_MODELS = 'relative-models';
  assert.throws(() => modelsPath(), /absolute path/);
});

test('modelName resolves inside the configured models folder, including quantized names', async () => {
  const models = dir('models-only');
  fs.writeFileSync(path.join(models, 'ggml-base-q5_1.bin'), 'fixture');
  fs.writeFileSync(path.join(models, 'ggml-custom-pt.bin'), 'fixture');
  const input = path.join(temporary, 'input.wav');
  fs.writeFileSync(input, makeWav());
  configure({ modelsPath: models });
  for (const [modelName, file] of [['base-q5_1', 'ggml-base-q5_1.bin'], ['BASE-Q5_1', 'ggml-base-q5_1.bin'], ['custom-pt', 'ggml-custom-pt.bin']]) {
    const command = await createCppInvocation({ filePath: input, modelName });
    assert.equal(command.args[command.args.indexOf('-m') + 1], path.join(models, file));
  }
  await assert.rejects(createCppInvocation({ filePath: input, modelName: '../models-only/ggml-base-q5_1' }), /path separators/);
  await assert.rejects(createCppInvocation({ filePath: input, modelName: 'small-q5_1' }), error => error.code === 'MODEL_NOT_FOUND');
});

test('binary directory follows the configured root and keeps traversal protection', { skip: process.platform !== 'win32' && 'Windows variant layout' }, () => {
  const root = dir('variants');
  dir('variants', 'Win64');
  dir('variants', 'BlasWin32');
  dir('variants', 'Custom');
  configure({ nativeRoot: root });
  assert.equal(resolveBinDir(), path.join(root, process.arch === 'ia32' ? 'Win32' : 'Win64'));
  configure({ flavor: 'blas' });
  assert.equal(resolveBinDir(), path.join(root, process.arch === 'ia32' ? 'BlasWin32' : 'BlasWin64'));
  process.env.WHISPER_WIN_BIN_DIR = 'Custom';
  assert.equal(resolveBinDir(), path.join(root, 'Custom'));
  for (const escape of ['..', '../variants-sibling', path.join('..', '..', 'Windows', 'System32'), 'C:\\Windows\\System32']) {
    process.env.WHISPER_WIN_BIN_DIR = escape;
    assert.throws(() => resolveBinDir(), /inside/, escape);
  }
});

test('a flat native root (one variant copied into it) is used directly', { skip: process.platform !== 'win32' && 'Windows layout' }, () => {
  const flat = dir('flat');
  fs.writeFileSync(path.join(flat, 'whisper-server.exe'), 'fixture');
  configure({ nativeRoot: flat });
  assert.equal(resolveBinDir(), flat);
});

test('missing native root reports how to configure it', async () => {
  configure({ nativeRoot: path.join(temporary, 'does-not-exist') });
  assert.throws(() => resolveBinDir(), error => error.code === 'NATIVE_NOT_FOUND' && /nativeRoot/.test(error.message));
  await assert.rejects(realShell({ file: 'x', args: [] }), error => error.code === 'NATIVE_NOT_FOUND');
});

test('paths inside app.asar are redirected to app.asar.unpacked', () => {
  const packed = path.join('C:', 'App', 'resources', 'app.asar', 'node_modules', 'pkg', 'lib');
  assert.equal(unpackedAsarPath(packed), path.join('C:', 'App', 'resources', 'app.asar.unpacked', 'node_modules', 'pkg', 'lib'));
  const unpacked = path.join('C:', 'App', 'resources', 'app.asar.unpacked', 'x');
  assert.equal(unpackedAsarPath(unpacked), unpacked);
});

test('streaming chunks go to the configured tmpDir, in a directory tagged with the process id, and are removed', async () => {
  const tmpDir = path.join(temporary, 'app-tmp');
  configure({ tmpDir });
  const seen = [];
  shellModule.default = async (command, _options, run = {}) => {
    const file = command.args[command.args.indexOf('-f') + 1];
    seen.push({ file, exists: fs.existsSync(file) });
    const stdout = '\n[00:00:00.000 --> 00:00:01.000]   ok\n';
    run.onStdout?.(stdout);
    return { stdout, stderr: '' };
  };
  const pcm = Buffer.alloc(16000 * 2 * 3);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 3) * 8000), i * 2);
  const lines = [];
  for await (const line of transcribeStream(pcm, { modelPath: 'fixture.bin', inputFormat: 'pcm_s16le', chunkSeconds: 2 })) lines.push(line);
  assert.equal(lines.length, 2);
  assert.ok(seen.length === 2 && seen.every(entry => entry.exists));
  for (const entry of seen) {
    assert.equal(path.dirname(path.dirname(entry.file)), tmpDir);
    assert.match(path.basename(path.dirname(entry.file)), new RegExp(`^wh-stream-${process.pid}-[A-Za-z0-9]{6}$`));
  }
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('stale temporary audio from dead processes is removed; live, foreign and recent data is kept', async () => {
  const tmp = dir('stale');
  const deadPid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    child.once('error', reject);
    child.once('exit', () => resolve(child.pid));
  });
  const make = (name, files = { 'chunk-0.wav': 'voice' }, ageMs = 0) => {
    const target = dir('stale', name);
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(target, file), content);
    if (ageMs) fs.utimesSync(target, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
    return target;
  };
  const dead = make(`wh-stream-${deadPid}-abc123`);
  const deadVad = make(`wh-${deadPid}-Zx09aa`, { 'tmp.wav': 'voice' });
  const own = make(`wh-stream-${process.pid}-own123`);
  const live = make(`wh-stream-${process.ppid}-live12`);
  const legacyOld = make('wh-stream-old123', {}, 60 * 60 * 1000);
  const legacyNew = make('wh-stream-new123');
  const foreign = make(`wh-stream-${deadPid}-frgn12`, { 'notes.txt': 'not ours' });
  const unrelated = make('wh-something-else');
  const removed = cleanupTempFiles({ dir: tmp });
  assert.deepEqual(removed.sort(), [dead, deadVad, legacyOld].sort());
  for (const kept of [own, live, legacyNew, foreign, unrelated]) assert.ok(fs.existsSync(kept), kept);
  assert.deepEqual(cleanupTempFiles({ dir: path.join(tmp, 'missing') }), []);
});

test('threads and prompt flags are validated and passed as literal arguments', async () => {
  const input = path.join(temporary, 'flags.wav');
  fs.writeFileSync(input, makeWav());
  const prompt = 'Ditado: "Moçambique" & Angola; $HOME %PATH% `x`';
  const command = await createCppInvocation({ filePath: input, modelPath: 'model.bin', options: { threads: 4, prompt } });
  assert.equal(command.args[command.args.indexOf('-t') + 1], '4');
  assert.equal(command.args[command.args.indexOf('--prompt') + 1], prompt);
  const empty = await createCppInvocation({ filePath: input, modelPath: 'model.bin', options: { prompt: '' } });
  assert.ok(!empty.args.includes('--prompt'));
  for (const threads of [0, -1, 1.5, '4', NaN, 2000]) {
    await assert.rejects(createCppInvocation({ filePath: input, modelPath: 'model.bin', options: { threads } }), /threads must be an integer/, String(threads));
  }
  for (const bad of [42, 'x'.repeat(4097), 'a\0b']) {
    await assert.rejects(createCppInvocation({ filePath: input, modelPath: 'model.bin', options: { prompt: bad } }), /prompt/);
  }
});
