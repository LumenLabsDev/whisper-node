'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('../packages/process');
const audio = require('../packages/audio');
const { configure } = require('../dist/index');
const { resetRuntimeConfig } = require('../dist/config/runtime');

const root = path.join(__dirname, '..');
let temporary;
before(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-ffmpeg-test-')); });
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });
afterEach(() => resetRuntimeConfig());

test('ffmpeg-static is an optional dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies?.['ffmpeg-static'], undefined);
  assert.ok(pkg.optionalDependencies['ffmpeg-static']);
});

test('without ffmpeg-static or FFmpeg on PATH, WAV and PCM input still work and other input fails clearly', async () => {
  const { stdout } = await runProcess(process.execPath, [path.join(__dirname, 'support', 'no-ffmpeg.js'), root, temporary], {
    cwd: temporary, signal: AbortSignal.timeout(30000),
  });
  assert.equal(stdout.trim().split('\n').at(-1), 'ok');
});

test('configure({ ffmpegPath }) selects the executable and a missing one is reported', async () => {
  const missing = path.join(temporary, 'no-ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  configure({ ffmpegPath: missing });
  assert.equal(audio.ffmpegPath(), missing);
  await assert.rejects(async () => { for await (const _ of audio.decodeToPCM16([Buffer.from('x')])) { /* drain */ } },
    error => error.code === 'ERR_FFMPEG_NOT_FOUND' && error.message.includes(missing));
  configure({ ffmpegPath: null });
  assert.notEqual(audio.ffmpegPath(), missing);
});
