'use strict';

const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

function responseFor(url, signal) {
  if (url.protocol !== 'https:') throw new Error('Downloads require HTTPS');
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal }, response => {
      // Errors can arrive while the destination directory is being prepared.
      response.on('error', () => {});
      resolve(response);
    });
    request.once('error', reject);
  });
}

/**
 * Follow bounded HTTPS redirects and replace the destination only after success.
 * `timeoutMs` limits inactivity (no connection or body bytes), not the total duration,
 * so multi-gigabyte models can finish on slow connections.
 */
async function downloadFile(href, destination, { maxRedirects = 5, timeoutMs = 300000 } = {}) {
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new Error('maxRedirects must be a non-negative integer');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive number');
  const controller = new AbortController();
  const signal = controller.signal;
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`Download stalled for ${timeoutMs} ms`)), timeoutMs);
  };
  touch();
  let url = new URL(href);
  let response;
  let tempDir;
  try {
    for (let redirects = 0; ; redirects++) {
      response = await responseFor(url, signal);
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.destroy();
        if (redirects >= maxRedirects) throw new Error(`Too many redirects (${maxRedirects})`);
        url = new URL(response.headers.location, url);
        continue;
      }
      if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode} for ${url}`);
      break;
    }
    const target = path.resolve(destination);
    await fs.mkdir(path.dirname(target), { recursive: true });
    tempDir = await fs.mkdtemp(path.join(path.dirname(target), '.whisper-download-'));
    const tempFile = path.join(tempDir, 'download');
    touch();
    await pipeline(response, async function* (source) {
      for await (const chunk of source) {
        touch();
        yield chunk;
      }
    }, createWriteStream(tempFile, { flags: 'wx', mode: 0o600 }), { signal });
    await fs.rename(tempFile, target);
  } catch (error) {
    // Report the stall itself rather than a generic AbortError.
    throw signal.aborted ? signal.reason : error;
  } finally {
    clearTimeout(timer);
    response?.destroy();
    if (tempDir) {
      await fs.unlink(path.join(tempDir, 'download')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(tempDir);
    }
  }
}

module.exports = { downloadFile };
