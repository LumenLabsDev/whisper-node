'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

process.env.WHISPER_NODE_LOG_LEVEL = 'ERROR';
const targetIndex = process.argv.indexOf('--root');
const targetRoot = targetIndex >= 0 ? path.resolve(process.argv[targetIndex + 1]) : path.resolve(__dirname, '..');
const requireTarget = require('node:module').createRequire(path.join(targetRoot, 'package.json'));
const { readPCM16 } = requireTarget('./packages/audio');
const { extractPCM16, computeVadThreshold } = requireTarget('./dist/core/vad');
const { assignSpeakersToTranscript } = requireTarget('./dist/core/diarization');
const { mergeWordLevelTranscript } = requireTarget('./dist/utils/transcription');

function timestamp(milliseconds) {
  const value = Math.round(milliseconds);
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor(value / 60000) % 60;
  const seconds = Math.floor(value / 1000) % 60;
  return [hours, minutes, seconds].map(part => String(part).padStart(2, '0')).join(':') +
    '.' + String(value % 1000).padStart(3, '0');
}

function writeFixture(filename, seconds) {
  const length = seconds * 16000;
  const bytes = Buffer.alloc(44 + length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 0.17) * 12000), 44 + i * 2);
  fs.writeFileSync(filename, bytes);
}

async function measure(name, description, action, validate) {
  for (let i = 0; i < 2; i++) validate(await action());
  const times = [];
  for (let i = 0; i < 7; i++) {
    global.gc?.();
    const started = performance.now();
    const value = await action();
    times.push(performance.now() - started);
    validate(value);
  }
  times.sort((a, b) => a - b);
  return {
    name, description, medianMs: Number(times[3].toFixed(3)),
    minMs: Number(times[0].toFixed(3)), maxMs: Number(times[6].toFixed(3)),
  };
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-benchmark-'));
  try {
    const audio = path.join(directory, 'five-minutes.wav');
    writeFixture(audio, 300);
    const segments = Array.from({ length: 120000 }, (_, index) => ({
      start: index * 0.03, end: (index + 1) * 0.03, speaker: 'S' + index % 3,
    }));
    const transcript = Array.from({ length: 1200 }, (_, index) => ({
      start: timestamp(index * 3000), end: timestamp(index * 3000 + 2500), speech: 'benchmark sentence',
    }));
    const words = Array.from({ length: 6000 }, (_, index) => ({
      start: timestamp(index * 120), end: timestamp(index * 120 + 100), speech: 'word' + index % 10,
    }));
    const frames = Array.from({ length: 90000 }, (_, index) => ({
      start: index * 0.02, end: (index + 1) * 0.02, energy: -4 + Math.sin(index * 0.137) * 2,
    }));
    const assert = require('node:assert/strict');
    const rows = [];
    rows.push(await measure('read_pcm', 'Read 5 min of mono 16 kHz PCM16 WAV', () => readPCM16(audio),
      value => assert.equal(value.length, 4800000)));
    rows.push(await measure('extract_pcm', 'Extract PCM from the same already compliant 5 min WAV', () => extractPCM16(audio),
      value => assert.equal(value.length, 4800000), true));
    rows.push(await measure('assign_speakers', 'Assign 1200 transcript lines over 120000 ordered speaker segments',
      () => assignSpeakersToTranscript(transcript, { segments }), value => assert.equal(value.length, transcript.length)));
    rows.push(await measure('merge_words', 'Merge 6000 words with maxCharsPerSegment=65536',
      () => mergeWordLevelTranscript(words, { maxCharsPerSegment: 65536 }),
      value => { assert.equal(value.length, 1); assert.equal(value[0].speech.split(' ').length, words.length); }));
    rows.push(await measure('merge_words_default', 'Merge 6000 words with the default 320-character limit',
      () => mergeWordLevelTranscript(words),
      value => assert.equal(value.reduce((count, line) => count + line.speech.split(' ').length, 0), words.length)));
    rows.push(await measure('vad_threshold', 'Compute the VAD median over 90000 frames',
      () => computeVadThreshold(frames), value => assert.ok(Number.isFinite(value))));
    const report = {
      node: process.version, platform: process.platform, arch: process.arch,
      cpu: os.cpus()[0]?.model, methodology: '2 warmups, 7 samples; median wall time; cached local WAV; GC before each sample',
      results: rows,
    };
    const json = JSON.stringify(report, null, 2) + '\n';
    const output = process.argv.indexOf('--output');
    if (output >= 0) {
      if (!process.argv[output + 1]) throw new Error('--output requires a filename');
      fs.writeFileSync(process.argv[output + 1], json);
    }
    console.log(json);
  } finally {
    // Only remove the unique directory created by this benchmark.
    const relative = path.relative(os.tmpdir(), path.resolve(directory));
    if (!relative.startsWith('whisper-benchmark-') || relative.includes(path.sep)) throw new Error('Invalid benchmark directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
