'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { downloadFile } = require('../packages/download');

let temporary;
before(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-download-test-')); });
after(() => { fs.rmSync(temporary, { recursive: true, force: true }); });

function mockResponses(t, responses) {
  const urls = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    urls.push(url.href);
    const request = new EventEmitter();
    queueMicrotask(() => {
      const fixture = responses.shift();
      if (fixture instanceof Error) return request.emit('error', fixture);
      const response = fixture.stream || Readable.from([Buffer.from(fixture.body || '')]);
      response.statusCode = fixture.status ?? 200;
      response.headers = fixture.location ? { location: fixture.location } : {};
      callback(response);
      if (fixture.earlyError) queueMicrotask(() => response.destroy(new Error('early response failure')));
    });
    return request;
  });
  return urls;
}

test('download follows relative redirects and writes the completed body', async t => {
  const urls = mockResponses(t, [{ status: 302, location: '/model' }, { body: 'model payload' }]);
  const destination = path.join(temporary, 'model.bin');
  await downloadFile('https://example.test/start', destination);
  assert.deepEqual(urls, ['https://example.test/start', 'https://example.test/model']);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'model payload');
  assert.equal(fs.readdirSync(temporary).some(name => name.startsWith('.whisper-download-')), false);
});

test('HTTP failures preserve an existing model', async t => {
  mockResponses(t, [{ status: 404 }]);
  const destination = path.join(temporary, 'existing.bin');
  fs.writeFileSync(destination, 'existing model');
  await assert.rejects(downloadFile('https://example.test/missing', destination), /HTTP 404/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'existing model');
});

test('download rejects redirect loops and HTTPS downgrades', async t => {
  mockResponses(t, [{ status: 302, location: '/again' }, { status: 302, location: '/again' }, { status: 302, location: 'http://example.test/insecure' }]);
  await assert.rejects(downloadFile('https://example.test/start', path.join(temporary, 'loop'), { maxRedirects: 1 }), /Too many redirects/);
  await assert.rejects(downloadFile('https://example.test/start', path.join(temporary, 'downgrade')), /require HTTPS/);
});

test('interrupted downloads remove temporary data and preserve the previous file', async t => {
  const stream = new Readable({
    read() {
      this.push('partial bytes');
      this.destroy(new Error('interrupted fixture'));
    },
  });
  mockResponses(t, [{ stream }]);
  const destination = path.join(temporary, 'interrupted.bin');
  fs.writeFileSync(destination, 'previous complete model');
  await assert.rejects(downloadFile('https://example.test/model', destination), /interrupted fixture/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'previous complete model');
  assert.equal(fs.readdirSync(temporary).some(name => name.startsWith('.whisper-download-')), false);
});

test('network errors propagate and non-HTTPS URLs are rejected', async t => {
  mockResponses(t, [new Error('network fixture')]);
  await assert.rejects(downloadFile('https://example.test/model', path.join(temporary, 'network')), /network fixture/);
  await assert.rejects(downloadFile('http://example.test/model', path.join(temporary, 'http')), /require HTTPS/);
});

test('response errors before disk preparation finishes reject without an unhandled stream error', async t => {
  mockResponses(t, [{ earlyError: true }]);
  const destination = path.join(temporary, 'early-error.bin');
  await assert.rejects(downloadFile('https://example.test/model', destination), /early response failure/);
  assert.equal(fs.existsSync(destination), false);
});

test('stalled downloads abort after the inactivity timeout but slow ones complete', async t => {
  const stalled = new Readable({ read() {} });
  stalled.push('first bytes');
  async function* slow() {
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 30));
      yield Buffer.from('part' + i);
    }
  }
  mockResponses(t, [{ stream: stalled }, { stream: Readable.from(slow()) }]);
  const destination = path.join(temporary, 'stalled.bin');
  await assert.rejects(downloadFile('https://example.test/model', destination, { timeoutMs: 50 }), /stalled for 50 ms/);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readdirSync(temporary).some(name => name.startsWith('.whisper-download-')), false);
  // Total time (~150 ms) exceeds the timeout, but no single gap does.
  await downloadFile('https://example.test/model', destination, { timeoutMs: 100 });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'part0part1part2part3part4');
});
