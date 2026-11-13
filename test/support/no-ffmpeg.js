'use strict';

// Runs in a child process: simulates an install without the optional ffmpeg-static package and
// without FFmpeg on PATH, then checks that WAV/PCM input still works and other input fails clearly.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'ffmpeg-static') {
    const error = new Error("Cannot find module 'ffmpeg-static'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return load.call(this, request, ...rest);
};
delete process.env.FFMPEG_PATH;
const [, , root, temporary] = process.argv;
process.env.PATH = path.join(temporary, 'empty-path');
process.env.WHISPER_NODE_LOG_LEVEL = 'ERROR';

const audio = require(path.join(root, 'packages', 'audio'));
const shellModule = require(path.join(root, 'dist', 'infra', 'shell'));
const { transcribe, transcribeStream } = require(path.join(root, 'dist', 'index'));
const { makeWav } = require(path.join(root, 'test', 'support', 'wav'));

shellModule.default = async (_command, _options, run = {}) => {
  const stdout = '\n[00:00:00.000 --> 00:00:01.000]   olá\n';
  run.onStdout?.(stdout);
  return { stdout, stderr: 'lang = pt, task' };
};

(async () => {
  assert.equal(audio.ffmpegPath(), 'ffmpeg');
  const wav = path.join(temporary, 'speech.wav');
  fs.writeFileSync(wav, makeWav({ samples: Array(16000).fill(1000) }));
  const result = await transcribe(wav, { modelPath: 'fixture.bin', whisperOptions: { language: 'pt' } });
  assert.deepEqual(result.transcript.map(line => line.speech), ['olá']);

  const pcm = Buffer.alloc(16000 * 2 * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 4) * 9000), i * 2);
  const lines = [];
  for await (const line of transcribeStream(pcm, { modelPath: 'fixture.bin', inputFormat: 'pcm_s16le' })) lines.push(line);
  assert.equal(lines.length, 1);
  const fromWavFile = [];
  for await (const line of transcribeStream(wav, { modelPath: 'fixture.bin', inputFormat: 'pcm_s16le' })) fromWavFile.push(line);
  assert.equal(fromWavFile.length, 1);

  const mp3 = path.join(temporary, 'speech.mp3');
  fs.writeFileSync(mp3, 'ID3 not really audio');
  await assert.rejects(audio.convertToWav16kMono(mp3, path.join(temporary, 'out.wav')), error => error.code === 'ERR_FFMPEG_NOT_FOUND');
  await assert.rejects(transcribe(mp3, { modelPath: 'fixture.bin' }), /FFmpeg is required/);
  await assert.rejects(async () => { for await (const _ of transcribeStream(mp3, { modelPath: 'fixture.bin' })) { /* drain */ } }, /FFmpeg is required/);
  console.log('ok');
})().catch(error => { console.error(error); process.exit(1); });
