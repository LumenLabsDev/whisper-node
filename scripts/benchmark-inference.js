'use strict';

// Per-chunk latency of whisper-cli (one process per chunk) versus whisper-server (model kept loaded).
// Usage: node scripts/benchmark-inference.js --audio speech-16k-mono.wav [--models base-q5_1,small-q5_1]
//        [--flavors cpu,blas] [--chunk 5] [--runs 7] [--threads 4] [--language pt] [--output results.json]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

process.env.WHISPER_NODE_LOG_LEVEL = 'ERROR';
const root = path.resolve(__dirname, '..');
const { configure, createWhisperServer } = require(path.join(root, 'dist'));
const { createCppInvocation } = require(path.join(root, 'dist', 'core', 'whisper'));
const shell = require(path.join(root, 'dist', 'infra', 'shell')).default;
const { readWavInfo, writeWavPCM16 } = require(path.join(root, 'packages', 'audio'));

const arg = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const audio = arg('audio');
if (!audio) throw new Error('--audio <16 kHz mono PCM16 WAV> is required');
const models = arg('models', 'base-q5_1,small-q5_1').split(',');
const flavors = arg('flavors', 'cpu,blas').split(',');
const chunkSeconds = Number(arg('chunk', '5'));
const runs = Number(arg('runs', '7'));
const threads = Number(arg('threads', '4'));
const language = arg('language', 'pt');

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => Number(value.toFixed(1));

(async () => {
  const info = readWavInfo(audio);
  if (!info || info.sampleRate !== 16000 || info.channels !== 1 || info.bitsPerSample !== 16) throw new Error('Expected 16 kHz mono PCM16 WAV');
  const pcm = fs.readFileSync(audio).subarray(info.dataOffset, info.dataOffset + info.dataLength);
  const chunkBytes = chunkSeconds * 32000;
  const chunks = [];
  for (let offset = 0; offset + chunkBytes <= pcm.length; offset += chunkBytes) chunks.push(pcm.subarray(offset, offset + chunkBytes));
  if (!chunks.length) throw new Error('Audio is shorter than one chunk');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-bench-'));
  const files = chunks.map((chunk, index) => {
    const file = path.join(directory, `chunk-${index}.wav`);
    writeWavPCM16(file, chunk);
    return file;
  });
  const rows = [];
  try {
    for (const flavor of flavors) {
      configure({ flavor });
      for (const modelName of models) {
        const cli = [];
        for (let i = -1; i < runs; i++) {
          const command = await createCppInvocation({ filePath: files[(i + 1) % files.length], modelName, options: { language, threads } });
          const started = performance.now();
          await shell(command);
          if (i >= 0) cli.push(performance.now() - started);
        }
        // whisper-cli decodes with beam search 5 by default; whisper-server decodes greedily.
        const measureServer = async beamSize => {
          let started = performance.now();
          const server = await createWhisperServer({ modelName, language, threads, beamSize });
          const startupMs = performance.now() - started;
          const served = [];
          try {
            for (let i = -1; i < runs; i++) {
              started = performance.now();
              await server.transcribePCM(chunks[(i + 1) % chunks.length]);
              if (i >= 0) served.push(performance.now() - started);
            }
          } finally {
            await server.close();
          }
          return { startupMs, served };
        };
        const greedy = await measureServer(undefined);
        const beam = await measureServer(5);
        const row = {
          flavor, model: modelName, chunkSeconds, threads,
          cliMedianMs: round(median(cli)), cliMinMs: round(Math.min(...cli)), cliMaxMs: round(Math.max(...cli)),
          serverMedianMs: round(median(greedy.served)), serverMinMs: round(Math.min(...greedy.served)), serverMaxMs: round(Math.max(...greedy.served)),
          serverBeam5MedianMs: round(median(beam.served)), serverBeam5MinMs: round(Math.min(...beam.served)), serverBeam5MaxMs: round(Math.max(...beam.served)),
          serverStartupMs: round(Math.max(greedy.startupMs, beam.startupMs)),
        };
        row.speedup = Number((row.cliMedianMs / row.serverMedianMs).toFixed(2));
        row.speedupBeam5 = Number((row.cliMedianMs / row.serverBeam5MedianMs).toFixed(2));
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const result = {
    date: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`,
    cpu: os.cpus()[0]?.model.trim(), cores: os.cpus().length, runs, language, rows,
  };
  const output = arg('output');
  if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log('\n| Variant | Model | CLI, beam 5 (ms) | Server, beam 5 (ms) | Server, greedy (ms) | Server start (ms) |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    console.log(`| ${row.flavor} | ${row.model} | ${row.cliMedianMs} | ${row.serverBeam5MedianMs} (${row.speedupBeam5}x) | ` +
      `${row.serverMedianMs} (${row.speedup}x) | ${row.serverStartupMs} |`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
