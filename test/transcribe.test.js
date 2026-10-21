'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { readWavInfo, writeWavPCM16, decodeToPCM16, readPCM16 } = require('../packages/audio');
const shellModule = require('../dist/infra/shell');
const { transcribe, whisper, transcribeStream, parseLanguageInfo } = require('../dist/index');
const { findSplitOffset } = require('../dist/core/stream');
const { createTranscriptLineParser } = require('../dist/utils/transcription');
const { makeWav } = require('./support/wav');

let temporary;
const realShell = shellModule.default;
before(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-transcribe-test-')); });
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });
afterEach(() => { shellModule.default = realShell; });

const ts = ms => new Date(ms).toISOString().slice(11, 23);

/**
 * Replace the native runner with a fixture that reports one segment per input file,
 * streams stdout in split pieces and logs language like whisper.cpp does on stderr.
 */
function fakeShell({ detected = 'pt', probability = 0.912, speakerTurn = false } = {}) {
  const calls = [];
  shellModule.default = async (command, _options, run = {}) => {
    const file = command.args[command.args.indexOf('-f') + 1];
    const language = command.args.includes('-l') ? command.args[command.args.indexOf('-l') + 1] : 'en';
    const info = readWavInfo(file);
    const durationMs = Math.round((info.dataLength / 2 / 16000) * 1000);
    calls.push({ args: command.args, durationMs });
    const half = Math.floor(durationMs / 2);
    const turn = speakerTurn ? ' [SPEAKER_TURN]' : '';
    const stdout = `\n[${ts(0)} --> ${ts(half)}]   first ${calls.length}${turn}\n[${ts(half)} --> ${ts(durationMs + 500)}]   second ${calls.length}\n`;
    const stderr = `whisper_full_with_state: processing ... lang = ${language}, task = transcribe, timestamps = 1 ...\n` +
      (language === 'auto' ? `whisper_full_with_state: auto-detected language: ${detected} (p = ${probability})\n` : '');
    run.onStderr?.(stderr);
    // Deliver stdout in uneven pieces to exercise incremental parsing.
    for (let i = 0; i < stdout.length; i += 7) run.onStdout?.(stdout.slice(i, i + 7));
    return { stdout, stderr };
  };
  return calls;
}

/** 16 kHz PCM16 tone with an optional silent gap, as a little-endian Buffer. */
function tonePcm(seconds, gap) {
  const samples = new Int16Array(Math.round(seconds * 16000));
  for (let i = 0; i < samples.length; i++) {
    const t = i / 16000;
    samples[i] = gap && t >= gap[0] && t < gap[1] ? 0 : Math.round(Math.sin(2 * Math.PI * 440 * t) * 12000);
  }
  return Buffer.from(samples.buffer);
}

test('language metadata is parsed from detection, effective and requested languages', () => {
  assert.deepEqual(parseLanguageInfo('whisper_full_with_state: auto-detected language: de (p = 0.874512)'), {
    code: 'de', probability: 0.874512, detected: true,
  });
  assert.deepEqual(parseLanguageInfo('processing x (1 samples, 1.0 sec), lang = es, task = transcribe'), { code: 'es', detected: false });
  assert.deepEqual(parseLanguageInfo('processing x, lang = auto, task = transcribe', 'auto'), undefined);
  assert.deepEqual(parseLanguageInfo('', 'FR'), { code: 'fr', detected: false });
  assert.equal(parseLanguageInfo(''), undefined);
});

test('transcribe returns detected language metadata while whisper keeps returning an array', async () => {
  const input = path.join(temporary, 'speech.wav');
  fs.writeFileSync(input, makeWav({ samples: Array(16000).fill(1000) }));
  const calls = fakeShell();
  const result = await transcribe(input, { modelPath: 'fixture.bin', whisperOptions: { language: 'auto' } });
  assert.deepEqual(result.language, { code: 'pt', probability: 0.912, detected: true });
  assert.deepEqual(result.transcript.map(line => line.speech), ['first 1', 'second 1']);
  const lines = await whisper(input, { modelPath: 'fixture.bin', whisperOptions: { language: 'en' } });
  assert.ok(Array.isArray(lines));
  assert.equal(lines.length, 2);
  assert.ok(!calls[1].args.includes('-tdrz'));
});

test('tinydiarize adds the native flag and labels turns', async () => {
  const input = path.join(temporary, 'turns.wav');
  fs.writeFileSync(input, makeWav({ samples: Array(16000).fill(1000) }));
  const calls = fakeShell({ speakerTurn: true });
  const result = await transcribe(input, {
    modelPath: 'ggml-small.en-tdrz.bin',
    diarization: { enabled: true, backend: 'tinydiarize' },
  });
  assert.ok(calls[0].args.includes('-tdrz'));
  assert.deepEqual(result.transcript.map(line => [line.speaker, line.speech]), [['S0', 'first 1'], ['S1', 'second 1']]);
  await assert.rejects(transcribe(input, { modelPath: 'x.bin', diarization: { enabled: true, backend: 'unknown' } }), /Unknown diarization backend/);
});

test('incremental parser emits complete lines across chunk boundaries', () => {
  const lines = [];
  const parser = createTranscriptLineParser(line => lines.push(line.speech));
  parser.push('[00:00:00.000 --> 00:00:01.000]   hel');
  assert.deepEqual(lines, []);
  parser.push('lo\n[00:00:01.000 --> 00:00:02.000]   wor');
  assert.deepEqual(lines, ['hello']);
  parser.push('ld');
  parser.flush();
  assert.deepEqual(lines, ['hello', 'world']);
});

test('chunks split at the quietest frame near the end', () => {
  const pcm = tonePcm(4, [3.5, 3.56]);
  const split = findSplitOffset(pcm, pcm.length);
  const seconds = split / 2 / 16000;
  assert.ok(seconds >= 3.5 && seconds <= 3.56, `split at ${seconds}s`);
  assert.equal(split % 2, 0);
});

test('WAV writer round-trips PCM16 samples', () => {
  const file = path.join(temporary, 'written.wav');
  writeWavPCM16(file, new Int16Array([-32768, 0, 16384, 32767]));
  assert.deepEqual(Array.from(readPCM16(file)), [-1, 0, 0.5, 32767 / 32768]);
});

test('stream transcription offsets timestamps, locks the detected language and skips silence', async () => {
  const pcm = Buffer.concat([tonePcm(5, [3.6, 3.7]), Buffer.alloc(3 * 32000)]);
  const calls = fakeShell();
  const segments = [];
  for await (const segment of transcribeStream(Readable.from([pcm.subarray(0, 12345), pcm.subarray(12345)]), {
    modelPath: 'fixture.bin',
    inputFormat: 'pcm_s16le',
    chunkSeconds: 4,
    whisperOptions: { language: 'auto' },
  })) segments.push(segment);

  // Chunk 0 is cut in the gap (~3.65 s); chunk 1 holds the rest of the tone; chunk 2 is silent.
  assert.equal(calls.length, 2);
  assert.ok(Math.abs(calls[0].durationMs - 3650) <= 60, `first chunk ${calls[0].durationMs} ms`);
  assert.equal(calls[0].args[calls[0].args.indexOf('-l') + 1], 'auto');
  assert.equal(calls[1].args[calls[1].args.indexOf('-l') + 1], 'pt');
  assert.deepEqual(segments.map(segment => [segment.chunk, segment.speech]), [[0, 'first 1'], [0, 'second 1'], [1, 'first 2'], [1, 'second 2']]);
  // Ends are clamped to the chunk and later chunks are offset by earlier audio.
  assert.equal(segments[1].end, ts(calls[0].durationMs));
  assert.equal(segments[2].start, ts(calls[0].durationMs));
  // Chunk 0 learns its detected language from stderr before its lines are printed.
  assert.deepEqual(segments.map(segment => segment.language), ['pt', 'pt', 'pt', 'pt']);
});

test('one large input buffer is split into consecutive chunks without losing audio', async () => {
  const calls = fakeShell();
  const segments = [];
  for await (const segment of transcribeStream([tonePcm(10)], {
    modelPath: 'fixture.bin', inputFormat: 'pcm_s16le', chunkSeconds: 2, whisperOptions: { language: 'en' },
  })) segments.push(segment);
  assert.equal(calls.reduce((sum, call) => sum + call.durationMs, 0), 10000);
  assert.ok(calls.length >= 5 && calls.length <= 6, `${calls.length} chunks`);
  assert.equal(segments.at(-1).end, ts(10000));
  for (let i = 1; i < segments.length; i++) assert.ok(segments[i].start >= segments[i - 1].start);
});

test('text chunks are rejected instead of being decoded as audio', async () => {
  fakeShell();
  const drain = async iterable => { for await (const _ of iterable) { /* drain */ } };
  await assert.rejects(drain(transcribeStream(['not bytes'], { modelPath: 'x.bin', inputFormat: 'pcm_s16le' })), /Uint8Array/);
  await assert.rejects(drain(decodeToPCM16(['not bytes'])), /Uint8Array/);
});

test('stream transcription decodes container bytes through FFmpeg stdin', async () => {
  const wav = fs.readFileSync((() => {
    const file = path.join(temporary, 'piped.wav');
    writeWavPCM16(file, tonePcm(2.5));
    return file;
  })());
  const decoded = [];
  for await (const chunk of decodeToPCM16(Readable.from([wav]))) decoded.push(chunk);
  assert.equal(Buffer.concat(decoded).length, 2.5 * 32000);

  const calls = fakeShell();
  const segments = [];
  for await (const segment of transcribeStream(fs.createReadStream(path.join(temporary, 'piped.wav')), {
    modelPath: 'fixture.bin', chunkSeconds: 2, whisperOptions: { language: 'en' },
  })) segments.push(segment);
  assert.equal(calls.length, 2);
  assert.ok(segments.every(segment => segment.language === 'en'));
  await assert.rejects(async () => {
    for await (const _ of decodeToPCM16(Readable.from([Buffer.from('not audio at all')]))) { /* drain */ }
  });
});

test('stream transcription validates options and stops when aborted', async () => {
  fakeShell();
  const drain = async iterable => { for await (const _ of iterable) { /* drain */ } };
  await assert.rejects(drain(transcribeStream(42, {})), /Stream source/);
  await assert.rejects(drain(transcribeStream('x.wav', { chunkSeconds: 1 })), /chunkSeconds/);
  await assert.rejects(drain(transcribeStream('x.wav', { diarization: { enabled: true, backend: 'spectral' } })), /only the tinydiarize/);

  const controller = new AbortController();
  async function* endless() {
    while (true) {
      yield tonePcm(1);
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  const received = [];
  await assert.rejects(async () => {
    for await (const segment of transcribeStream(endless(), {
      modelPath: 'fixture.bin', inputFormat: 'pcm_s16le', chunkSeconds: 2, signal: controller.signal,
    })) {
      received.push(segment);
      if (received.length === 2) controller.abort();
    }
  }, error => error.code === 'ABORTED');
  assert.equal(received.length, 2);
});
