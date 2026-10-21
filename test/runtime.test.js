'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runProcess } = require('../packages/process');
const { readWavInfo, isWav16kMono, readPCM16 } = require('../packages/audio');
const { kmeans } = require('../packages/clustering');
const { ensureWav16kMono } = require('../dist/utils/convert');
const { extractPCM16, computeFrameEnergies } = require('../dist/core/vad');
const { runDiarization } = require('../dist/core/diarization');
const { createCppInvocation } = require('../dist/core/whisper');
const { makeWav } = require('./support/wav');

let temporary;
before(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-node-test-')); });
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });

test('process arguments preserve shell metacharacters and Unicode literally', async () => {
  const args = ['a b', '"; echo injected', '%PATH%', '$(echo injected)', '& | ; > <', 'olá'];
  const { stdout } = await runProcess(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...args]);
  assert.deepEqual(JSON.parse(stdout), args);
});

test('concurrent processes use their own cwd without changing the host cwd', async () => {
  const initial = process.cwd();
  const dirs = ['one', 'two'].map(name => path.join(temporary, name));
  dirs.forEach(dir => fs.mkdirSync(dir));
  const results = await Promise.all(dirs.map(cwd => runProcess(process.execPath, ['-e', 'console.log(process.cwd())'], { cwd })));
  assert.deepEqual(results.map(result => path.resolve(result.stdout.trim())), dirs.map(dir => path.resolve(dir)));
  assert.equal(process.cwd(), initial);
});

test('process failures and output limits reject with useful errors', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.error("failed fixture"); process.exit(7)']), error => error.code === 7 && error.message.includes('failed fixture'));
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { maxBuffer: 32 }), /exceeded/);
  await assert.rejects(runProcess(path.join(temporary, 'missing-executable')), /ENOENT/);
});

test('WAV reader finds PCM after metadata and odd-sized RIFF chunks', () => {
  const file = path.join(temporary, 'metadata.wav');
  fs.writeFileSync(file, makeWav({ samples: [-32768, 0, 16384, 32767], metadata: true }));
  const info = readWavInfo(file);
  assert.ok(info.dataOffset > 44);
  assert.equal(isWav16kMono(file), true);
  assert.deepEqual(Array.from(readPCM16(file)), [-1, 0, 0.5, 32767 / 32768]);
});

test('malformed and truncated WAV data are rejected without out-of-bounds reads', () => {
  const file = path.join(temporary, 'bad.wav');
  const bytes = makeWav();
  bytes.writeUInt32LE(0xffffffff, 40);
  fs.writeFileSync(file, bytes);
  assert.equal(readWavInfo(file), null);
  assert.throws(() => readPCM16(file), /Expected/);
  fs.writeFileSync(file, Buffer.from('RIFF'));
  assert.equal(readWavInfo(file), null);
});

test('PCM extraction enforces its memory limit before allocation', () => {
  const file = path.join(temporary, 'limited.wav');
  fs.writeFileSync(file, makeWav({ samples: [1, 2, 3, 4] }));
  assert.throws(() => readPCM16(file, 2), /too large/);
});

test('compliant WAVs are returned unchanged without FFmpeg', async () => {
  const file = path.join(temporary, 'already.wav');
  fs.writeFileSync(file, makeWav());
  assert.equal(await ensureWav16kMono(file), file);
  assert.equal(fs.existsSync(path.join(temporary, 'already.wav16k.wav')), false);
});

test('actual FFmpeg converts stereo 44.1 kHz MP3 and extracts PCM', async () => {
  const input = path.join(temporary, 'audio %PATH% & spaces.mp3');
  await runProcess(require('ffmpeg-static'), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=0.2', '-ar', '44100', '-ac', '2', input,
  ]);
  const output = await ensureWav16kMono(input);
  assert.equal(isWav16kMono(output), true);
  const pcm = await extractPCM16(input);
  assert.ok(pcm.length >= 3000 && pcm.length <= 4000);
  assert.ok(pcm.some(value => Math.abs(value) > 0.01));
});

test('conversion failures propagate instead of returning an invalid output', async () => {
  const file = path.join(temporary, 'not-audio.mp3');
  fs.writeFileSync(file, 'not an audio file');
  await assert.rejects(ensureWav16kMono(file));
});

test('k-means separates groups and handles duplicate points and short input', () => {
  const result = kmeans([[0, 0], [0.1, 0], [10, 10], [10.1, 10]], 2);
  assert.equal(result.clusters[0], result.clusters[1]);
  assert.equal(result.clusters[2], result.clusters[3]);
  assert.notEqual(result.clusters[0], result.clusters[2]);
  assert.deepEqual(kmeans([[2, 2]], 6).clusters, [0]);
  assert.deepEqual(kmeans([[1], [1], [1]], 3).clusters, [0, 0, 0]);
  assert.throws(() => kmeans([[NaN]], 1), /finite/);
  assert.throws(() => kmeans([[1]], 0), /positive integer/);
});

test('diarization handles a single voiced frame with more requested speakers', async () => {
  const file = path.join(temporary, 'short.wav');
  fs.writeFileSync(file, makeWav({ samples: Array(320).fill(10000) }));
  const result = await runDiarization(file, { numSpeakers: 6, vadThreshold: -100 });
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].speaker, 'S0');
});

test('invalid frame and speaker settings fail without hanging', async () => {
  assert.throws(() => computeFrameEnergies(new Float32Array(320), 16000, 0), /positive frame size/);
  assert.throws(() => computeFrameEnergies(new Float32Array(320), 16000, NaN), /positive frame size/);
  await assert.rejects(runDiarization('unused.wav', { numSpeakers: 1.5 }), /positive integer/);
});

test('Whisper options and paths remain separate literal arguments', async () => {
  const input = path.join(temporary, 'input & %PATH%.wav');
  fs.writeFileSync(input, makeWav());
  const model = 'model"; echo injected; %PATH%.bin';
  const language = 'en; echo injected';
  const command = await createCppInvocation({
    filePath: input,
    modelPath: model,
    options: { language, output_file_path: 'output & %PATH%', no_timestamps: true },
  });
  assert.equal(command.args[command.args.indexOf('-m') + 1], model);
  assert.equal(command.args[command.args.indexOf('-l') + 1], language);
  assert.equal(command.args[command.args.indexOf('-f') + 1], input);
  assert.ok(command.args.includes('-nt'));
  assert.ok(!command.args.includes('true'));
  const noSplit = await createCppInvocation({ filePath: input, modelPath: model, options: { timestamp_size: 0 } });
  assert.equal(noSplit.args[noSplit.args.indexOf('-ml') + 1], '0');
  await assert.rejects(createCppInvocation({ filePath: input, modelPath: model, options: { timestamp_size: 1, word_timestamps: true } }), /not both/);
});

test('importing the downloader has no interactive or network side effects', async () => {
  const { stdout } = await runProcess(process.execPath, ['-e', 'console.log(typeof require("./dist/cli/download").default)'], { signal: AbortSignal.timeout(5000) });
  assert.equal(stdout.trim(), 'function');
});

test('native prompt accepts piped input and exits cleanly', async () => {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'require("./packages/prompt").question("model: ").then(value => console.log(JSON.stringify(value)))'], {
      cwd: path.join(__dirname, '..'), windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      try { assert.equal(code, 0); assert.ok(stdout.includes('"base.en"')); resolve(); } catch (error) { reject(error); }
    });
    child.stdin.end(' base.en \n');
  });
});
