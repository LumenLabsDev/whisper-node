'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dictation', {
  start: () => ipcRenderer.invoke('dictation:start'),
  /** @param {ArrayBuffer} pcm Int16 little-endian samples, 16 kHz mono. */
  sendAudio: pcm => ipcRenderer.send('dictation:audio', pcm),
  stop: () => ipcRenderer.send('dictation:stop'),
  onText: callback => ipcRenderer.on('dictation:text', (_event, segment) => callback(segment)),
  onDone: callback => ipcRenderer.on('dictation:done', () => callback()),
  onError: callback => ipcRenderer.on('dictation:error', (_event, message) => callback(message)),
});
