'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
    throw new Error('Expected a 16 kHz mono PCM16 WAV file');
  }
  if (info.dataLength > maxBytes) throw new Error('Audio file too large for in-memory processing. Use smaller audio segments.');
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytes = Buffer.alloc(info.dataLength);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, info.dataOffset + offset);
      if (!count) throw new Error('Truncated WAV data');
      offset += count;
    }
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
    return samples;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readWavInfo, isWav16kMono, convertToWav16kMono, readPCM16 };
