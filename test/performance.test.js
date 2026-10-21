'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPCM16 } = require('../packages/audio');
const { extractPCM16, computeVadThreshold, median } = require('../dist/core/vad');
const { assignSpeakersToTranscript } = require('../dist/core/diarization');
const { mergeWordLevelTranscript } = require('../dist/utils/transcription');
const { runProcess } = require('../packages/process');
const { makeWav } = require('./support/wav');

let temporary;
before(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-performance-test-')); });
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });
const ts = milliseconds => '00:00:' + String(Math.floor(milliseconds / 1000)).padStart(2, '0') + '.' + String(milliseconds % 1000).padStart(3, '0');

test('PCM16 WAV extraction bypasses FFmpeg, including WAV metadata', async t => {
  const input = path.join(temporary, 'native-pcm.wav');
  fs.writeFileSync(input, makeWav({ samples: [-32768, 0, 16384, 32767], metadata: true }));
  const original = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = path.join(temporary, 'ffmpeg-must-not-start');
  t.after(() => { if (original === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = original; });
  assert.deepEqual(Array.from(await extractPCM16(input)), [-1, 0, 0.5, 32767 / 32768]);
});

test('chunked PCM reads preserve samples across the 256 KiB boundary', () => {
  const samples = Array.from({ length: 131079 }, (_, index) => (index * 37 % 65536) - 32768);
  const input = path.join(temporary, 'chunk-boundary.wav');
  fs.writeFileSync(input, makeWav({ samples, metadata: true }));
  const pcm = readPCM16(input);
  assert.equal(pcm.length, samples.length);
  for (let i = 0; i < samples.length; i++) assert.equal(pcm[i], samples[i] / 32768);
});

test('PCM reads tolerate short, odd-sized reads and empty audio', t => {
  const input = path.join(temporary, 'short-reads.wav');
  const samples = Array.from({ length: 71 }, (_, index) => index * 100 - 3000);
  fs.writeFileSync(input, makeWav({ samples }));
  const read = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(length, 17), position));
  assert.deepEqual(Array.from(readPCM16(input)), samples.map(sample => sample / 32768));
  const empty = path.join(temporary, 'empty.wav');
  fs.writeFileSync(empty, makeWav({ samples: [] }));
  assert.equal(readPCM16(empty).length, 0);
});

test('24-bit mono WAVs retain the FFmpeg conversion fallback', async () => {
  const input = path.join(temporary, 'pcm24.wav');
  await runProcess(require('ffmpeg-static'), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=0.1', '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s24le', input,
  ]);
  assert.throws(() => readPCM16(input), error => error.code === 'ERR_WAV_FORMAT');
  const pcm = await extractPCM16(input);
  assert.equal(pcm.length, 1600);
  assert.ok(pcm.some(sample => Math.abs(sample) > 0.01));
});

test('indexed speaker lookup preserves boundaries, first overlap and unsorted transcript order', () => {
  const segments = Object.freeze([
    Object.freeze({ start: 1, end: 2, speaker: 'A' }),
    Object.freeze({ start: 3, end: 4, speaker: 'B' }),
    Object.freeze({ start: 5, end: 7, speaker: 'C' }),
  ]);
  const intervals = [[6000, 6500], [2000, 3000], [1500, 5500], [0, 500], [3000, 3500], [7000, 8000]];
  const lines = Object.freeze(intervals.map(([start, end]) => Object.freeze({ start: ts(start), end: ts(end), speech: 'line', speaker: 'previous' })));
  const result = assignSpeakersToTranscript(lines, { segments });
  assert.deepEqual(result.map(line => line.speaker), ['C', undefined, 'A', undefined, 'B', undefined]);
  assert.equal(lines[0].speaker, 'previous');
  assert.notEqual(result[0], lines[0]);
});

test('custom overlapping and unordered speaker segments keep their original first match', () => {
  const lines = [{ start: ts(1500), end: ts(5500), speech: 'line' }];
  const cases = [
    [{ start: 2, end: 8, speaker: 'first' }, { start: 1, end: 3, speaker: 'second' }],
    [{ start: 1, end: 8, speaker: 'first' }, { start: 2, end: 3, speaker: 'second' }],
    [{ start: 5, end: 6, speaker: 'first' }, { start: 1, end: 2, speaker: 'second' }],
  ];
  for (const segments of cases) assert.equal(assignSpeakersToTranscript(lines, { segments })[0].speaker, 'first');
  assert.deepEqual(assignSpeakersToTranscript([], { segments: [] }), []);
  assert.equal(assignSpeakersToTranscript(lines, { segments: [] })[0].speaker, undefined);
});

test('word merging preserves punctuation, timestamps, speaker labels and length boundaries', () => {
  const tokens = ['Hello', ',', 'world', '!', 'Next', 'line', '.'];
  const ranges = [[0, 100], [100, 150], [200, 300], [300, 400], [1500, 1600], [1600, 1700], [1700, 1800]];
  const lines = tokens.map((speech, index) => ({
    start: ts(ranges[index][0]), end: ts(ranges[index][1]), speech, speaker: index < 4 ? 'A' : 'B',
  }));
  assert.deepEqual(mergeWordLevelTranscript(lines), [
    { start: ts(0), end: ts(400), speech: 'Hello, world!', speaker: 'A' },
    { start: ts(1500), end: ts(1800), speech: 'Next line.', speaker: 'B' },
  ]);
  const capped = ['abc', 'def', 'ghi'].map((speech, index) => ({ start: ts(index * 100), end: ts(index * 100 + 100), speech }));
  assert.deepEqual(mergeWordLevelTranscript(capped, { maxCharsPerSegment: 7 }).map(line => line.speech), ['abc def', 'ghi']);
});

test('word merging preserves pause boundaries and Unicode length accounting', () => {
  const lines = [[0, 100, 'alpha'], [700, 800, 'beta'], [1500, 1600, 'gamma']]
    .map(([start, end, speech]) => ({ start: ts(start), end: ts(end), speech }));
  assert.deepEqual(mergeWordLevelTranscript(lines).map(line => line.speech), ['alpha beta', 'gamma']);
  const unicode = ['😀', 'é', '好'].map((speech, index) => ({ start: ts(index * 100), end: ts(index * 100 + 100), speech }));
  assert.deepEqual(mergeWordLevelTranscript(unicode, { maxCharsPerSegment: 4 }).map(line => line.speech), ['😀 é', '好']);
});

test('typed VAD median preserves odd, even, duplicate and exceptional energy results', () => {
  for (const values of [[-9], [-9, -1], [-9, -2, -5, -5, -4], [0, 0, 0, 0], [Infinity, Infinity], [NaN, -1, -2]]) {
    const frames = values.map((energy, index) => ({ start: index, end: index + 1, energy }));
    assert.equal(computeVadThreshold(frames, 1.5), median(values) * 1.5);
    assert.deepEqual(frames.map(frame => frame.energy), values);
  }
  assert.equal(computeVadThreshold([]), Infinity);
});
