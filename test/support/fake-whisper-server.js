'use strict';

// Minimal stand-in for whisper-server: the same CLI flags, /health and /inference under --request-path.
// FAKE_SERVER_LOG: file that receives one JSON line per start and per request.
// FAKE_SERVER_EXIT: exit immediately with this code. FAKE_SERVER_LOAD_MS: delay before /health succeeds.
const http = require('node:http');
const fs = require('node:fs');

const argv = process.argv.slice(2);
const flag = name => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const log = entry => { if (process.env.FAKE_SERVER_LOG) fs.appendFileSync(process.env.FAKE_SERVER_LOG, JSON.stringify(entry) + '\n'); };

if (process.env.FAKE_SERVER_EXIT) process.exit(Number(process.env.FAKE_SERVER_EXIT));
log({ event: 'start', pid: process.pid, argv });

const base = flag('--request-path') || '';
const defaults = { language: flag('-l') || 'en', prompt: flag('--prompt') || '' };
const loadedAt = Date.now() + Number(process.env.FAKE_SERVER_LOAD_MS || 0);
let count = 0;

function parseMultipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  const fields = {};
  let fileBytes = 0;
  for (const part of body.toString('latin1').split('--' + boundary)) {
    const header = part.indexOf('\r\n\r\n');
    if (header < 0) continue;
    const name = /name="([^"]+)"/.exec(part.slice(0, header))?.[1];
    const value = part.slice(header + 4, part.length - 2);
    if (name === 'file') fileBytes = value.length - 44;
    else if (name) fields[name] = Buffer.from(value, 'latin1').toString('utf8');
  }
  return { fields, fileBytes };
}

const server = http.createServer((request, response) => {
  const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.method === 'GET' && request.url === base + '/health') {
    return Date.now() >= loadedAt ? send(200, { status: 'ok' }) : send(503, { status: 'loading model' });
  }
  if (request.method !== 'POST' || request.url !== base + '/inference') return send(404, {});
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const { fields, fileBytes } = parseMultipart(Buffer.concat(chunks), request.headers['content-type']);
    count++;
    const language = fields.language || defaults.language;
    const prompt = fields.prompt ?? defaults.prompt;
    log({ event: 'request', pid: process.pid, fields, fileBytes });
    const seconds = fileBytes / 32000;
    if (fields.response_format === 'vtt') {
      const ts = value => new Date(Math.round(value * 1000)).toISOString().slice(11, 23);
      response.writeHead(200, { 'content-type': 'text/vtt' });
      return response.end(`WEBVTT\n\n${ts(0)} --> ${ts(seconds / 2)}\n request ${count} lang=${language} prompt=${prompt}\n\n` +
        `${ts(seconds / 2)} --> ${ts(30)}\n second half\n\n`);
    }
    send(200, {
      task: 'transcribe',
      language: language === 'auto' ? 'portuguese' : language,
      duration: seconds,
      text: ' request ' + count,
      segments: [
        { id: 0, text: ` request ${count} lang=${language} prompt=${prompt}`, start: 0, end: seconds / 2 },
        { id: 1, text: ' second half', start: seconds / 2, end: 30 },
      ],
      ...(language === 'auto'
        ? { detected_language: 'portuguese', detected_language_probability: 0.93, language_probabilities: { en: 0.05, pt: 0.93 } }
        : {}),
    });
  });
});
server.listen(Number(flag('--port')), flag('--host') || '127.0.0.1');
