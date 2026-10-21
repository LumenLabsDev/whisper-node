'use strict';

const fs = require('node:fs');
const path = require('node:path');
const LITTLE_ENDIAN = require('node:os').endianness() === 'LE';
const { spawn } = require('node:child_process');
const { runProcess } = require('../process');

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  // Load lazily: compliant WAVs do not need an installed FFmpeg binary.
  return require('ffmpeg-static') || 'ffmpeg';
}

/** Locate RIFF chunks instead of assuming all WAV headers have 44 bytes. */
function readWavInfo(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(12);
    if (fs.readSync(fd, header, 0, 12, 0) !== 12 ||
        header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;
    const limit = Math.min(size, header.readUInt32LE(4) + 8);
    let format;
    let data;
    const chunk = Buffer.alloc(8);
    for (let offset = 12; offset + 8 <= limit;) {
      if (fs.readSync(fd, chunk, 0, 8, offset) !== 8) return null;
      const id = chunk.toString('ascii', 0, 4);
      const length = chunk.readUInt32LE(4);
      const start = offset + 8;
      if (length > limit - start) return null;
      if (id === 'fmt ' && length >= 16) {
        const fmt = Buffer.alloc(Math.min(length, 40));
        if (fs.readSync(fd, fmt, 0, fmt.length, start) !== fmt.length) return null;
        let audioFormat = fmt.readUInt16LE(0);
        if (audioFormat === 0xfffe && fmt.length >= 40 && fmt.readUInt16LE(16) >= 22) {
          const pcmGuid = Buffer.from('0100000000001000800000aa00389b71', 'hex');
          if (fmt.subarray(24, 40).equals(pcmGuid)) audioFormat = 1;
        }
        format = {
          audioFormat, channels: fmt.readUInt16LE(2), sampleRate: fmt.readUInt32LE(4),
          blockAlign: fmt.readUInt16LE(12), bitsPerSample: fmt.readUInt16LE(14),
        };
      } else if (id === 'data' && !data) data = { dataOffset: start, dataLength: length };
      if (format && data) return { ...format, ...data };
      offset = start + length + (length % 2);
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function isWav16kMono(filePath) {
  const info = readWavInfo(filePath);
  return !!info && info.audioFormat === 1 && info.channels === 1 && info.sampleRate === 16000 &&
    [16, 24, 32].includes(info.bitsPerSample) && info.blockAlign === info.bitsPerSample / 8 &&
    info.dataLength % info.blockAlign === 0;
}

async function convertToWav16kMono(inputPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await runProcess(ffmpegPath(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', path.resolve(inputPath),
    '-map', '0:a:0', '-vn', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', '-f', 'wav', path.resolve(outputPath),
  ]);
}

function readPCM16(filePath, maxBytes = 500 * 1024 * 1024) {
  const info = readWavInfo(filePath);
  if (!info || info.audioFormat !== 1 || info.channels !== 1 || info.sampleRate !== 16000 ||
      info.bitsPerSample !== 16 || info.blockAlign !== 2 || info.dataLength % 2) {
    const error = new Error('Expected a 16 kHz mono PCM16 WAV file');
    error.code = 'ERR_WAV_FORMAT';
    throw error;
  }
  if (info.dataLength > maxBytes) throw new Error('Audio file too large for in-memory processing. Use smaller audio segments.');
  const fd = fs.openSync(filePath, 'r');
  try {
    const samples = new Float32Array(info.dataLength / 2);
    const bytes = Buffer.allocUnsafe(Math.min(info.dataLength, 256 * 1024));
    const integers = LITTLE_ENDIAN ? new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2) : null;
    for (let offset = 0; offset < info.dataLength;) {
      const wanted = Math.min(bytes.length, info.dataLength - offset);
      let filled = 0;
      while (filled < wanted) {
        const count = fs.readSync(fd, bytes, filled, wanted - filled, info.dataOffset + offset + filled);
        if (!count) throw new Error('Truncated WAV data');
        filled += count;
      }
      const firstSample = offset / 2;
      if (integers) {
        for (let i = 0; i < wanted / 2; i++) samples[firstSample + i] = integers[i] / 32768;
      } else {
        for (let i = 0; i < wanted / 2; i++) samples[firstSample + i] = bytes.readInt16LE(i * 2) / 32768;
      }
      offset += wanted;
    }
    return samples;
  } finally {
    fs.closeSync(fd);
  }
}

/** Write little-endian PCM16 mono samples as a canonical 44-byte-header WAV. */
function writeWavPCM16(filePath, pcm, sampleRate = 16000) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (data.length % 2) throw new Error('PCM16 data must contain whole samples');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  if (!LITTLE_ENDIAN && !Buffer.isBuffer(pcm)) {
    const swapped = Buffer.from(data);
    swapped.swap16();
    fs.writeFileSync(filePath, Buffer.concat([header, swapped]));
  } else fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

/**
 * Decode any FFmpeg-supported byte stream (or file path) into raw 16 kHz mono PCM16.
 * The returned iterable yields Buffers as FFmpeg produces them; it rejects on decoder failure.
 */
async function* decodeToPCM16(input, options = {}) {
  const fromFile = typeof input === 'string';
  const child = spawn(ffmpegPath(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    ...(options.inputFormat ? ['-f', options.inputFormat] : []),
    '-i', fromFile ? path.resolve(input) : 'pipe:0',
    '-map', '0:a:0', '-vn', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
  ], { windowsHide: true, shell: false, stdio: [fromFile ? 'ignore' : 'pipe', 'pipe', 'pipe'], signal: options.signal });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || 'FFmpeg exited with ' + (code ?? signal)));
    });
  });
  exited.catch(() => {});
  let feedError;
  if (!fromFile) {
    // EPIPE is expected when FFmpeg stops early; its exit status carries the real error.
    child.stdin.on('error', () => {});
    (async () => {
      try {
        for await (const chunk of input) {
          if (child.stdin.destroyed) break;
          if (!(chunk instanceof Uint8Array)) {
            throw new TypeError('Audio chunks must be Buffers or Uint8Arrays; do not set an encoding on the source stream');
          }
          if (!child.stdin.write(chunk)) {
            await new Promise(resolve => { child.stdin.once('drain', resolve); child.stdin.once('close', resolve); });
          }
        }
      } finally {
        child.stdin.end();
      }
    })().catch(error => { feedError = error; child.kill(); });
  }
  try {
    for await (const chunk of child.stdout) yield chunk;
    if (feedError) throw feedError;
    await exited;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

module.exports = { readWavInfo, isWav16kMono, convertToWav16kMono, readPCM16, writeWavPCM16, decodeToPCM16 };
