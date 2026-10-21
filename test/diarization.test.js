'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDiarization, applySpeakerTurns, assignSpeakersToTranscript } = require('../dist/core/diarization');
const { computeMfcc } = require('../dist/core/features');
const { mergeWordLevelTranscript } = require('../dist/utils/transcription');
const { makeWav } = require('./support/wav');

let temporary;
before(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-diarization-test-')); });
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });

/** Alternate two "voices" with equal loudness but different spectra, with deterministic noise. */
function twoVoiceSamples(turns, seconds) {
  const rate = 16000;
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const voices = [[180, 360, 540], [1400, 2600, 3900]];
  const samples = [];
  for (let turn = 0; turn < turns; turn++) {
    const tones = voices[turn % 2];
    for (let i = 0; i < seconds * rate; i++) {
      const t = i / rate;
      const value = tones.reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * t), 0) / tones.length;
      samples.push(Math.round((value * 0.5 + noise() * 0.02) * 32767));
    }
  }
  return samples;
}

test('spectral backend separates equally loud voices with different spectra', async () => {
  const file = path.join(temporary, 'two-voices.wav');
  fs.writeFileSync(file, makeWav({ samples: twoVoiceSamples(4, 2) }));
  const { segments } = await runDiarization(file, { backend: 'spectral', numSpeakers: 2, vadThreshold: -100 });
  assert.deepEqual(segments.map(segment => segment.speaker), ['S0', 'S1', 'S0', 'S1']);
  for (const [index, segment] of segments.entries()) {
    assert.ok(Math.abs(segment.start - index * 2) < 0.05, `segment ${index} starts near ${index * 2}s`);
    assert.ok(Math.abs(segment.end - (index + 1) * 2) < 0.05, `segment ${index} ends near ${(index + 1) * 2}s`);
  }
});

test('spectral backend validates window settings and handles silence', async () => {
  const file = path.join(temporary, 'silence.wav');
  fs.writeFileSync(file, makeWav({ samples: Array(16000).fill(0) }));
  assert.deepEqual(await runDiarization(file, { backend: 'spectral', vadThreshold: 100 }), { segments: [] });
  await assert.rejects(runDiarization(file, { backend: 'spectral', segmentMs: 5 }), /segmentMs/);
});

test('MFCC frames line up with energy frames', () => {
  const pcm = new Float32Array(16000).map((_, i) => Math.sin(i / 10));
  const mfcc = computeMfcc(pcm, 16000, 20);
  assert.equal(mfcc.length, 50);
  assert.equal(mfcc[0].length, 12);
  assert.ok(mfcc.every(frame => frame.every(Number.isFinite)));
});

test('custom backends receive the audio path and their segments are validated and sorted', async () => {
  const calls = [];
  const backend = {
    name: 'fixture',
    async diarize(audioPath, options) {
      calls.push([audioPath, options.numSpeakers]);
      return { segments: [{ start: 2, end: 4, speaker: 'B' }, { start: 0, end: 2, speaker: 'A' }] };
    },
  };
  const result = await runDiarization('audio.wav', { backend, numSpeakers: 3 });
  assert.deepEqual(calls, [['audio.wav', 3]]);
  assert.deepEqual(result.segments.map(segment => segment.speaker), ['A', 'B']);
  const broken = { name: 'broken', diarize: async () => ({ segments: [{ start: 1, end: 0, speaker: 'A' }] }) };
  await assert.rejects(runDiarization('audio.wav', { backend: broken }), /invalid segment/);
  await assert.rejects(runDiarization('audio.wav', { backend: { name: 'none' } }), /diarize/);
  await assert.rejects(runDiarization('audio.wav', { backend: 'pyannote' }), /Unknown diarization backend/);
  await assert.rejects(runDiarization('audio.wav', { backend: 'tinydiarize' }), /inside whisper.cpp/);
});

test('tinydiarize speaker turns rotate labels, strip markers and carry state', () => {
  const lines = [
    { start: '00:00:00.000', end: '00:00:01.000', speech: 'Hello there. [SPEAKER_TURN]' },
    { start: '00:00:01.000', end: '00:00:02.000', speech: 'Hi!' },
    { start: '00:00:02.000', end: '00:00:03.000', speech: 'How are you? [SPEAKER_TURN]' },
    { start: '00:00:03.000', end: '00:00:04.000', speech: 'Fine.' },
  ];
  const state = { current: 0 };
  const labeled = applySpeakerTurns(lines, {}, state);
  assert.deepEqual(labeled.map(line => [line.speaker, line.speech]), [
    ['S0', 'Hello there.'], ['S1', 'Hi!'], ['S1', 'How are you?'], ['S0', 'Fine.'],
  ]);
  assert.equal(state.current, 0);
  assert.deepEqual(applySpeakerTurns(lines.slice(0, 2), { numSpeakers: 3 }).map(line => line.speaker), ['S0', 'S1']);
  assert.equal(applySpeakerTurns([lines[0]], {}, { current: 1 })[0].speaker, 'S1');
});

test('word merging breaks sentences when the speaker changes', () => {
  const words = ['one', 'two', 'three', 'four'].map((speech, index) => ({
    start: `00:00:0${index}.000`, end: `00:00:0${index}.500`, speech, speaker: index < 2 ? 'S0' : 'S1',
  }));
  const merged = mergeWordLevelTranscript(words, { maxGapMs: 1000 });
  assert.deepEqual(merged.map(line => [line.speaker, line.speech]), [['S0', 'one two'], ['S1', 'three four']]);
  assert.deepEqual(assignSpeakersToTranscript(merged, { segments: [] }).map(line => line.speaker), [undefined, undefined]);
});
