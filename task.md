# 1) Public API (breaking changes: none)

Expose diarization via new options; default off.

```ts
// src/types.ts
export interface DiarizationOptions {
  enabled?: boolean;           // default false
  numSpeakers?: number | null; // k for k-means; null => estimate
  vadMode?: 0|1|2|3;           // WebRTC VAD mode; default 2
  minSpeechMs?: number;        // merge small gaps; default 150
  maxChunkMs?: number;         // max diar chunk; default 2000
  embeddingModelPath?: string; // .onnx ECAPA/ResNet
  onnxExecutionProviders?: ('cpu'|'cuda'|'dml')[]; // default ['cpu']
}

export interface WhisperOptions {
  // ...existing
  word_timestamps?: boolean; // must be true for diarization
  diarization?: DiarizationOptions;
}

export interface Word {
  start: number; end: number; text: string;
  speaker?: string;           // NEW
}

export interface Segment {
  start: number; end: number; text: string; words: Word[];
  speaker?: string;           // NEW (majority vote of words)
}

export interface TranscribeResult {
  segments: Segment[];
  language: string;
  speakers?: { id: string; color?: string; centroid?: number[] }[]; // NEW (metadata)
}
```

CLI flags (optional):

```
--diarize
--diarize-num-speakers 2
--diarize-model ./models/ecapa-tdnn.onnx
--diarize-vad 2
```

---

# 2) File layout (new modules)

```
src/
  audio/
    decode.ts        // wav/ffmpeg => PCM16 mono 16k
    framing.ts       // frame slicing utils
    features.ts      // log-mel extraction for embeddings
  diar/
    vad.ts           // WebRTC VAD wrapper
    embed.ts         // ONNX ECAPA wrapper
    cluster.ts       // k-means + k estimation
    align.ts         // map clusters -> whisper words
    pipeline.ts      // orchestrates diarization
  whisper/
    run.ts           // existing whisper.cpp bridge
index.ts             // public entry (plumbs diarization)
```

---

# 3) Minimal implementations (TS)

### 3.1 VAD wrapper

```ts
// src/diar/vad.ts
import Vad from 'webrtcvad';

export type VadFrame = { start: number; end: number; pcm: Int16Array };

export function runVad(
  pcm16: Int16Array,
  sampleRate = 16000,
  mode: 0|1|2|3 = 2,
  frameMs = 20
) {
  const vad = new Vad(mode);
  const hop = (sampleRate * frameMs) / 1000;
  const frames: VadFrame[] = [];
  let t = 0;
  for (let off = 0; off + hop <= pcm16.length; off += hop) {
    const slice = pcm16.subarray(off, off + hop);
    if (vad.processAudio(slice, sampleRate)) {
      frames.push({ start: t, end: t + frameMs / 1000, pcm: slice });
    }
    t += frameMs / 1000;
  }
  return coalesce(frames, 0.15); // merge gaps <150ms
}

function coalesce(fr: VadFrame[], maxGapSec: number) {
  if (fr.length === 0) return [];
  const out: { start:number; end:number; }[] = [];
  let cur = { start: fr[0].start, end: fr[0].end };
  for (let i = 1; i < fr.length; i++) {
    if (fr[i].start - cur.end <= maxGapSec) cur.end = fr[i].end;
    else { out.push(cur); cur = { start: fr[i].start, end: fr[i].end }; }
  }
  out.push(cur);
  return out;
}
```

### 3.2 ONNX speaker embeddings

```ts
// src/diar/embed.ts
import ort from 'onnxruntime-node';
import { logMel } from '../audio/features';

export class SpeakerEmbedder {
  private session!: ort.InferenceSession;
  constructor(
    private modelPath: string,
    private providers: ('cpu'|'cuda'|'dml')[] = ['cpu']
  ){}
  async init() {
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: this.providers
    });
  }
  async embed(pcm16: Float32Array, sr = 16000) {
    const mel = logMel(pcm16, sr);               // [n_mels, n_frames]
    const input = new ort.Tensor('float32', mel.data, [1, mel.nMels, mel.nFrames]);
    const out = await this.session.run({ input });
    const key = Object.keys(out)[0];
    return Array.from(out[key].data as Float32Array); // [d]
  }
}
```

> `logMel` can be a tiny implementation: pre-emphasis → STFT (25 ms win / 10 ms hop) → Mel filterbank (e.g., 80 bins) → log10.

### 3.3 Clustering

```ts
// src/diar/cluster.ts
import { kmeans } from '@mljs/kmeans';

export function cluster(embs: number[][], k?: number|null) {
  const K = k ?? estimateK(embs, 2, 6);
  const { clusters, centroids } = kmeans(embs, { k: K, initialization: 'kmeans++' });
  return { labels: clusters, centroids };
}

function estimateK(X: number[][], kMin=2, kMax=6) {
  // cheap elbow by inertia
  let bestK = kMin, bestScore = Infinity;
  for (let k = kMin; k <= kMax; k++) {
    const { clusters, centroids } = kmeans(X, { k });
    const inertia = X.reduce((s,x,i)=>{
      const c = centroids[clusters[i]];
      const d = x.reduce((a,v,j)=> a + (v - c[j])**2, 0);
      return s + d;
    }, 0);
    if (inertia < bestScore) { bestScore = inertia; bestK = k; }
  }
  return bestK;
}
```

### 3.4 Align clusters → Whisper words

```ts
// src/diar/align.ts
import { Segment, Word } from '../types';

type Chunk = { start:number; end:number; label:number };

export function labelTranscript(
  segments: Segment[],
  chunks: Chunk[],
  labelPrefix='S'
) {
  const labelAt = (t:number) => {
    for (const c of chunks) if (t >= c.start && t <= c.end) return c.label;
    return -1;
  };

  for (const seg of segments) {
    let votes: Record<number, number> = {};
    for (const w of seg.words ?? []) {
      const mid = (w.start + w.end) / 2;
      const lab = labelAt(mid);
      if (lab >= 0) {
        w.speaker = `${labelPrefix}${lab}`;
        votes[lab] = (votes[lab] ?? 0) + (w.end - w.start);
      }
    }
    const winner = Object.entries(votes).sort((a,b)=>b[1]-a[1])[0]?.[0];
    if (winner) seg.speaker = `${labelPrefix}${winner}`;
  }
  return segments;
}
```

### 3.5 Orchestrate the pipeline

```ts
// src/diar/pipeline.ts
import { DiarizationOptions, Segment } from '../types';
import { runVad } from './vad';
import { SpeakerEmbedder } from './embed';
import { cluster } from './cluster';

export async function diarize(
  pcm16: Int16Array,
  sr: number,
  segments: Segment[],
  opt: DiarizationOptions
) {
  const vadRegions = runVad(pcm16, sr, opt.vadMode ?? 2);
  if (!vadRegions.length) return { segments, speakers: [] };

  // sample a center slice per region (or sliding windows if > maxChunkMs)
  const embs: number[][] = [];
  const chunkMeta: { start:number; end:number }[] = [];
  const embedder = new SpeakerEmbedder(
    opt.embeddingModelPath ?? 'models/ecapa-tdnn.onnx',
    opt.onnxExecutionProviders ?? ['cpu']
  );
  await embedder.init();

  for (const r of vadRegions) {
    const duration = r.end - r.start;
    const step = Math.min(duration, (opt.maxChunkMs ?? 2_000) / 1000);
    const n = Math.max(1, Math.floor(duration / step));
    for (let i=0;i<n;i++){
      const t0 = r.start + i*step;
      const t1 = Math.min(r.end, t0 + step);
      const s = Math.floor(t0*sr), e = Math.floor(t1*sr);
      const f32 = new Float32Array(pcm16.slice(s, e).map(x=>x/32768));
      embs.push(await embedder.embed(f32, sr));
      chunkMeta.push({ start: t0, end: t1 });
    }
  }

  const { labels, centroids } = cluster(embs, opt.numSpeakers ?? null);
  const chunks = chunkMeta.map((m,i)=>({ ...m, label: labels[i] }));
  const labeledSegments = (await import('./align')).then(m=>m.labelTranscript(segments, chunks));
  const segmentsOut = await labeledSegments;

  const unique = [...new Set(labels)].sort((a,b)=>a-b);
  const speakers = unique.map(u => ({ id: `S${u}`, centroid: centroids[u] }));

  return { segments: segmentsOut, speakers };
}
```

---

# 4) Integration point (single call site)

Hook after Whisper completes (you already have word timestamps).

```ts
// src/index.ts
import { transcribeWhisper } from './whisper/run';
import { diarize } from './diar/pipeline';
import { WhisperOptions, TranscribeResult } from './types';
import { decodeToPCM16 } from './audio/decode';

export async function transcribe(
  audioPathOrBuffer: string | Buffer,
  options: WhisperOptions = {}
): Promise<TranscribeResult> {
  const asr = await transcribeWhisper(audioPathOrBuffer, {
    ...options,
    word_timestamps: true, // ensure on
  });

  if (!options.diarization?.enabled) return asr;

  const { pcm16, sampleRate } = await decodeToPCM16(audioPathOrBuffer, 16000);
  const { segments, speakers } = await diarize(
    pcm16, sampleRate, asr.segments, options.diarization
  );
  return { ...asr, segments, speakers };
}
```

---

# 5) Example usage (library consumer)

```ts
import { transcribe } from '@your-scope/nodejs-whisper';

const out = await transcribe('meeting.wav', {
  modelName: 'large-v3',
  diarization: {
    enabled: true,
    numSpeakers: 2,                 // or omit to auto-estimate
    embeddingModelPath: './models/ecapa-tdnn.onnx',
    vadMode: 2
  }
});

for (const s of out.segments) {
  console.log(`[${s.speaker ?? 'S?'}] ${s.text}`);
}
```

---

# 6) Notes you’ll want in the README

* **Models**: ship a lightweight ECAPA-TDNN `.onnx` (192–256 dim) in a separate download to keep NPM small.
* **Runtimes**: support `onnxruntime-node` CPU by default; optionally load `onnxruntime-node` GPU build if present (CUDA / DirectML).
* **Performance**: share one ONNX session across files; batch windows when possible.
* **Overlaps**: baseline k-means can’t label simultaneous speakers; call this out.
* **Locales**: diarization is language-agnostic; Whisper language only affects ASR.
* **Licenses**: confirm the model’s license permits redistribution.

---

# 7) Tests (quick but meaningful)

* **Unit**:

  * VAD merges tiny gaps;
  * Embedding output shape is stable;
  * Clustering returns the requested `k`.
* **Golden audio**: 60–120 s with 2 speakers → assert majority-speaker labels per segment.
* **Fuzz**: different `vadMode`, `numSpeakers`, and resampled inputs (8/44.1/48k → 16k).

---

# 8) Optional polish (later, if you want)

* Add `resegment` pass (per-word smoothing via HMM/CRF).
* Expose `speakers[i].name` mapping + simple UI color generator.
* Output **.rttm** and **.srt** helpers.