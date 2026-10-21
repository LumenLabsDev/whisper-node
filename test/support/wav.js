'use strict';

function chunk(id, bytes) {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'ascii');
  header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes, bytes.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function makeWav({ samples = [0, 1000, -1000, 0], metadata = false } = {}) {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(16000, 4);
  format.writeUInt32LE(32000, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const chunks = [chunk('fmt ', format)];
  if (metadata) chunks.push(chunk('JUNK', Buffer.from('odd')), chunk('LIST', Buffer.from('metadata')));
  chunks.push(chunk('data', data));
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WAVE', 8, 'ascii');
  return Buffer.concat([header, body]);
}

module.exports = { makeWav };
