'use strict';

// Main process: one whisper-server for the whole app, fed with microphone PCM sent by the renderer.
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { configure, createWhisperServer } = require('@lumen-labs-dev/whisper-node');

// Packaged: <install>/resources/bin/whisper and <install>/resources/models (electron-builder extraResources).
// Development: ./resources, filled by `npm run prepare-resources`.
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
configure({
  nativeRoot: path.join(resources, 'bin', 'whisper'),
  modelsPath: path.join(resources, 'models'),
  // Per-user folder instead of the shared system temp; only CLI-mode chunks are ever written here.
  tmpDir: path.join(app.getPath('userData'), 'tmp'),
});

let server;
/** Start whisper-server on first use; it stops after 2 idle minutes and restarts on demand. */
function getServer() {
  server ??= createWhisperServer({
    modelName: 'base-q5_1', // or 'small-q5_1' for better accuracy on faster machines
    language: 'pt',
    threads: 4,
    prompt: 'Ditado em português. Angola, Moçambique, Luanda, Maputo.',
    idleTimeoutMs: 120_000,
  }).catch(error => { server = undefined; throw error; });
  return server;
}

/** Async iterable fed by IPC messages; ends when the renderer stops dictation. */
class PcmQueue {
  constructor() { this.items = []; this.waiting = null; this.ended = false; }
  push(chunk) { this.items.push(chunk); this.waiting?.(); }
  end() { this.ended = true; this.waiting?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) { yield this.items.shift(); continue; }
      if (this.ended) return;
      await new Promise(resolve => { this.waiting = resolve; });
      this.waiting = null;
    }
  }
}

const sessions = new Map(); // webContents id -> { queue, controller }

ipcMain.handle('dictation:start', async event => {
  const sender = event.sender;
  sessions.get(sender.id)?.controller.abort();
  const queue = new PcmQueue();
  const controller = new AbortController();
  sessions.set(sender.id, { queue, controller });
  const whisper = await getServer();
  (async () => {
    try {
      // 5 s chunks cut at quiet points; each partial result is sent back as soon as it is ready.
      for await (const segment of whisper.transcribeStream(queue, {
        inputFormat: 'pcm_s16le', chunkSeconds: 5, signal: controller.signal,
      })) {
        if (!sender.isDestroyed()) sender.send('dictation:text', { text: segment.speech, start: segment.start, end: segment.end });
      }
      if (!sender.isDestroyed()) sender.send('dictation:done');
    } catch (error) {
      if (!controller.signal.aborted && !sender.isDestroyed()) sender.send('dictation:error', error.message);
    }
  })();
});

// Int16 little-endian samples at 16 kHz mono, as an ArrayBuffer.
ipcMain.on('dictation:audio', (event, buffer) => {
  sessions.get(event.sender.id)?.queue.push(Buffer.from(buffer));
});

ipcMain.on('dictation:stop', event => {
  sessions.get(event.sender.id)?.queue.end();
  sessions.delete(event.sender.id);
});

app.whenReady().then(() => {
  // Allow the microphone for this app's own pages only.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && webContents.getURL().startsWith('file://'));
  });
  const window = new BrowserWindow({
    width: 720,
    height: 520,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Warm up while the window loads, so the first dictation does not wait for the model.
  getServer().catch(error => console.error('whisper-server failed to start:', error.message));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { server?.then(instance => instance.close()).catch(() => {}); });
