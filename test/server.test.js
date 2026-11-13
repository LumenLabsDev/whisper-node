'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createWhisperServer, configure } = require('../dist/index');
const { toPCM16Bytes, parseVtt } = require('../dist/core/server');
const { resetRuntimeConfig } = require('../dist/config/runtime');

const FAKE = path.join(__dirname, 'support', 'fake-whisper-server.js');
const launcher = { file: process.execPath, args: [FAKE] };
let temporary;
let model;
let logFile;
const servers = [];

before(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-server-test-'));
  model = path.join(temporary, 'ggml-fixture.bin');
  fs.writeFileSync(model, 'fixture model');
});
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  delete process.env.FAKE_SERVER_EXIT;
  delete process.env.FAKE_SERVER_LOAD_MS;
  resetRuntimeConfig();
});

function freshLog() {
  logFile = path.join(temporary, `log-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  process.env.FAKE_SERVER_LOG = logFile;
  return () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
}

async function start(options = {}) {
  const server = await createWhisperServer({ modelPath: model, launcher, ...options });
  servers.push(server);
  return server;
}

/** 16 kHz PCM16 tone. */
function tone(seconds) {
  const samples = new Int16Array(Math.round(seconds * 16000));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / 16000) * 12000);
  return Buffer.from(samples.buffer);
}

const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function status(port, route) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, agent: false }, response => { response.resume(); resolve(response.statusCode); }).once('error', reject);
  });
}

test('server lifecycle: start, transcribe from memory, close', async () => {
  const entries = freshLog();
  const server = await start({ language: 'pt', threads: 2, prompt: 'Luanda, "kwanza" & Benguela' });
  assert.equal(server.running, true);
  assert.equal(typeof server.port, 'number');
  const pid = server.pid;

  const startArgs = entries().find(entry => entry.event === 'start').argv;
  const arg = name => startArgs[startArgs.indexOf(name) + 1];
  assert.equal(arg('-m'), model);
  assert.equal(arg('--host'), '127.0.0.1');
  assert.equal(arg('-l'), 'pt');
  assert.equal(arg('-t'), '2');
  assert.equal(arg('--prompt'), 'Luanda, "kwanza" & Benguela');
  assert.match(arg('--request-path'), /^\/[0-9a-f]{32}$/);
  // Routes are only reachable through the random request path.
  assert.equal(await status(server.port, '/health'), 404);
  assert.equal(await status(server.port, arg('--request-path') + '/health'), 200);

  const result = await server.transcribePCM(tone(2));
  assert.deepEqual(result.language, { code: 'pt', detected: false });
  assert.equal(result.transcript[0].speech, 'request 1 lang=pt prompt=Luanda, "kwanza" & Benguela');
  assert.equal(result.transcript[0].start, '00:00:00.000');
  assert.equal(result.transcript[0].end, '00:00:01.000');
  // Segment ends past the audio (whisper pads to 30 s) are clamped to its duration.
  assert.equal(result.transcript[1].end, '00:00:02.000');
  const request = entries().find(entry => entry.event === 'request');
  assert.equal(request.fileBytes, 64000);
  // Segment timestamps come from the cheap VTT format; verbose_json is only needed for detection.
  assert.equal(request.fields.response_format, 'vtt');

  const override = await server.transcribePCM(tone(1), { language: 'auto', prompt: 'Maputo', offsetMs: 5000 });
  assert.deepEqual(override.language, { code: 'pt', detected: true, probability: 0.93 });
  assert.equal(override.transcript[0].speech, 'request 2 lang=auto prompt=Maputo');
  assert.equal(override.transcript[0].start, '00:00:05.000');
  assert.equal(entries().filter(entry => entry.event === 'request')[1].fields.response_format, 'verbose_json');

  await server.close();
  assert.equal(server.running, false);
  await waitFor(() => !isAlive(pid));
  await assert.rejects(server.transcribePCM(tone(1)), error => error.code === 'SERVER_CLOSED');
  await server.close();
});

test('server restarts automatically after its process is killed', async () => {
  freshLog();
  const server = await start({ language: 'pt' });
  const first = server.pid;
  process.kill(first);
  await waitFor(() => server.running && server.pid !== first);
  assert.equal(server.restarts, 1);
  const result = await server.transcribePCM(tone(1));
  assert.equal(result.transcript[0].speech, 'request 1 lang=pt prompt=');
  assert.equal(isAlive(first), false);
});

test('a request survives the process dying while it waits', async () => {
  freshLog();
  const server = await start({ language: 'pt', autoRestart: false });
  process.kill(server.pid);
  const result = await server.transcribePCM(tone(1));
  assert.equal(result.transcript.length, 2);
  assert.equal(server.restarts, 1);
});

test('idle timeout stops the process and the next request starts it again', async () => {
  freshLog();
  const server = await start({ idleTimeoutMs: 150 });
  const first = server.pid;
  await server.transcribePCM(tone(1));
  await waitFor(() => !server.running);
  await waitFor(() => !isAlive(first));
  const result = await server.transcribePCM(tone(1));
  assert.equal(result.transcript.length, 2);
  assert.equal(server.running, true);
  assert.notEqual(server.pid, first);
});

test('startup waits for the model to load and reports processes that exit', async () => {
  freshLog();
  process.env.FAKE_SERVER_LOAD_MS = '300';
  const started = Date.now();
  await start();
  assert.ok(Date.now() - started >= 250);
  delete process.env.FAKE_SERVER_LOAD_MS;
  process.env.FAKE_SERVER_EXIT = '3';
  await assert.rejects(start(), error => error.code === 'SERVER_START_FAILED');
  delete process.env.FAKE_SERVER_EXIT;
  await assert.rejects(createWhisperServer({ modelPath: path.join(temporary, 'missing.bin'), launcher }), error => error.code === 'MODEL_NOT_FOUND');
});

test('server streaming locks the detected language and writes no temporary files', async () => {
  const entries = freshLog();
  const tmpDir = path.join(temporary, 'stream-tmp');
  fs.mkdirSync(tmpDir);
  configure({ tmpDir });
  const server = await start({ language: 'auto' });
  const segments = [];
  for await (const segment of server.transcribeStream(tone(5), { inputFormat: 'pcm_s16le', chunkSeconds: 2 })) segments.push(segment);
  const requests = entries().filter(entry => entry.event === 'request');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(entry => entry.fields.language), ['auto', 'pt', 'pt']);
  assert.ok(segments.every(segment => segment.language === 'pt'));
  assert.deepEqual([...new Set(segments.map(segment => segment.chunk))], [0, 1, 2]);
  assert.ok(segments.at(-1).start >= '00:00:04');
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('server options are validated before any process starts', async () => {
  const entries = freshLog();
  for (const options of [
    { threads: 0 }, { threads: 1.5 }, { language: 'pt; rm' }, { prompt: 42 }, { port: 70000 },
    { executable: 'relative/whisper-server.exe' }, { idleTimeoutMs: -1 }, { beamSize: 0 }, { beamSize: 17 },
  ]) {
    await assert.rejects(createWhisperServer({ modelPath: model, launcher, ...options }), error => error.code === 'VALIDATION_ERROR', JSON.stringify(options));
  }
  assert.deepEqual(entries(), []);
  const server = await start();
  await assert.rejects(server.transcribePCM(Buffer.alloc(3)), /whole 16-bit samples/);
  await assert.rejects(server.transcribePCM(tone(1), { language: 'xx-yy' }), /ISO 639/);
  assert.deepEqual(await server.transcribePCM(tone(0.05)), { transcript: [] });
  assert.equal(entries().filter(entry => entry.event === 'request').length, 0);
});

test('beam size is passed to the server as beam and best-of', async () => {
  const entries = freshLog();
  await start({ beamSize: 5 });
  const args = entries().find(entry => entry.event === 'start').argv;
  assert.equal(args[args.indexOf('-bs') + 1], '5');
  assert.equal(args[args.indexOf('-bo') + 1], '5');
});

test('WebVTT responses parse into segments, including CRLF, hours and wrapped text', () => {
  const vtt = 'WEBVTT\r\n\r\n00:00:00.000 --> 00:00:01.720\r\n Bom dia!\r\n\r\n01:02:03.004 --> 01:02:05.500 align:start\r\n linha um\r\nlinha dois\r\n\r\n';
  assert.deepEqual(parseVtt(vtt), [
    { start: 0, end: 1.72, text: ' Bom dia!' },
    { start: 3723.004, end: 3725.5, text: ' linha um linha dois' },
  ]);
  assert.deepEqual(parseVtt('WEBVTT\n\n'), []);
});

test('PCM containers convert to little-endian PCM16', () => {
  assert.deepEqual([...toPCM16Bytes(new Float32Array([0, 1, -1, 2, -2, 0.5]))], [...Buffer.from(new Int16Array([0, 32767, -32768, 32767, -32768, 16384]).buffer)]);
  const ints = new Int16Array([1, -2, 300]);
  assert.deepEqual([...toPCM16Bytes(ints)], [...Buffer.from(ints.buffer)]);
  const bytes = Buffer.from([1, 0, 2, 0]);
  assert.equal(toPCM16Bytes(new Uint8Array(bytes)).length, 4);
});

const realModel = process.env.WHISPER_NODE_TEST_MODEL || path.join(__dirname, '..', 'lib', 'whisper.cpp', 'models', 'ggml-base-q5_1.bin');
const realServer = path.join(__dirname, '..', 'lib', 'whisper.cpp', process.arch === 'ia32' ? 'Win32' : 'Win64', 'whisper-server.exe');
test('real whisper-server: start, transcribe, restart after kill, close', {
  skip: process.platform !== 'win32' || !fs.existsSync(realModel) || !fs.existsSync(realServer)
    ? 'needs Windows, the native setup and a model (WHISPER_NODE_TEST_MODEL)' : false,
  timeout: 120000,
}, async () => {
  const server = await createWhisperServer({ modelPath: realModel, language: 'pt', threads: 2 });
  servers.push(server);
  const first = await server.transcribePCM(tone(2));
  assert.ok(Array.isArray(first.transcript));
  assert.deepEqual(first.language, { code: 'pt', detected: false });
  const pid = server.pid;
  process.kill(pid);
  const second = await server.transcribePCM(tone(2));
  assert.ok(Array.isArray(second.transcript));
  assert.notEqual(server.pid, pid);
  await server.close();
  assert.equal(server.running, false);
});
