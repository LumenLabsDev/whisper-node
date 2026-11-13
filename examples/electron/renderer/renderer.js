'use strict';

// Renderer: microphone -> AudioWorklet (Float32 at 16 kHz) -> Int16 PCM -> IPC every ~250 ms.
const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const output = document.getElementById('text');
let capture = null;

window.dictation.onText(segment => { output.textContent += (output.textContent ? ' ' : '') + segment.text; });
window.dictation.onDone(() => { status.textContent = ''; });
window.dictation.onError(message => { status.textContent = 'Erro: ' + message; });

async function start() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // Chromium resamples the microphone to the context rate, so the worklet already receives 16 kHz.
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule('pcm-worklet.js');
  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, 'pcm-capture');
  let pending = [];
  let samples = 0;
  worklet.port.onmessage = ({ data }) => {
    pending.push(data);
    samples += data.length;
    if (samples < 4000) return; // ~250 ms per IPC message
    const pcm = new Int16Array(samples);
    let offset = 0;
    for (const block of pending) {
      for (let i = 0; i < block.length; i++) {
        const value = Math.max(-1, Math.min(1, block[i]));
        pcm[offset++] = value < 0 ? value * 32768 : value * 32767;
      }
    }
    pending = [];
    samples = 0;
    window.dictation.sendAudio(pcm.buffer);
  };
  source.connect(worklet);
  await window.dictation.start();
  capture = { stream, context };
}

async function stop() {
  capture.stream.getTracks().forEach(track => track.stop());
  await capture.context.close();
  capture = null;
  window.dictation.stop();
}

toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  try {
    if (capture) {
      await stop();
      toggle.textContent = 'Ditar';
      status.textContent = 'A terminar...';
    } else {
      await start();
      toggle.textContent = 'Parar';
      status.textContent = 'A ouvir...';
    }
  } catch (error) {
    status.textContent = 'Erro: ' + error.message;
  } finally {
    toggle.disabled = false;
  }
});
