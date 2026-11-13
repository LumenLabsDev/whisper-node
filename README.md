# Whisper-Node

[![npm downloads](https://img.shields.io/npm/dm/@lumen-labs-dev/whisper-node)](https://www.npmjs.com/package/@lumen-labs-dev/whisper-node)
[![License](https://img.shields.io/npm/l/@lumen-labs-dev/whisper-node)](LICENSE)

**Version 1.1.0 · Node.js 22+ · MIT**

Local audio and video transcription for Node.js using [whisper.cpp](https://github.com/ggml-org/whisper.cpp). The API returns timestamped text with the spoken language. It can also transcribe audio streams chunk by chunk and add speaker labels through pluggable diarization backends.

- Local CPU transcription with JavaScript and TypeScript support.
- Automatic conversion of common audio/video formats to 16 kHz mono WAV.
- Structured transcripts and optional TXT, SRT and VTT files.
- Detected-language metadata, with the detection probability.
- Streaming transcription from files, Node streams or raw PCM, with incremental results.
- Live dictation through a persistent `whisper-server` that keeps the model loaded and receives audio from memory.
- Configurable locations for binaries, models, FFmpeg and temporary files, for Electron and other offline apps.
- Speaker diarization with energy, spectral (MFCC), tinydiarize or custom backends.
- Precompiled Windows CPU/OpenBLAS binaries for x86 and x64, with optional app-local Visual C++ runtime.
- Internal runtime modules with a pinned native release and integrity checks.

## Contents

- [Quick start](#quick-start)
- [API](#api)
- [Streaming transcription](#streaming-transcription)
- [Live dictation (server mode)](#live-dictation-server-mode)
- [Models](#models)
- [Audio preparation](#audio-preparation)
- [Speaker diarization](#speaker-diarization)
- [Configuration](#configuration)
- [Electron / offline apps](#electron--offline-apps)
- [Native assets](#native-assets)
- [Internal packages and dependencies](#internal-packages-and-dependencies)
- [Performance](#performance)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Quick start

Install the package, then download a model:

```sh
npm install @lumen-labs-dev/whisper-node
npx whisper-node
```

Press Enter to download the default `base.en` model, or enter another supported name. You can skip the downloader if you already have a model and pass its location through `modelPath`.

Save this example as `transcribe.mjs`:

```javascript
import { whisper } from '@lumen-labs-dev/whisper-node';

const transcript = await whisper('audio.mp3', {
  modelName: 'base.en',
  whisperOptions: { language: 'auto' },
});

console.log(transcript);
```

```sh
node transcribe.mjs
```

Example result:

```json
[
  {
    "start": "00:00:14.310",
    "end": "00:00:16.480",
    "speech": "Hello from a local transcription."
  }
]
```

CommonJS is also supported:

```javascript
const { whisper } = require('@lumen-labs-dev/whisper-node');

whisper('audio.wav', { modelName: 'base.en' })
  .then(console.log)
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
```

Installations need model weights before transcription. Transcription runs locally after the required model and native executables are available.

## API

| Function | Returns |
| --- | --- |
| `whisper(filePath, options?)` | `Promise<ITranscriptLine[]>`: the transcript lines. |
| `transcribe(filePath, options?)` | `Promise<ITranscriptionResult>`: `{ transcript, language? }`. |
| `transcribeStream(source, options?)` | `AsyncGenerator<IStreamSegment>`: see [Streaming transcription](#streaming-transcription). |
| `createWhisperServer(options?)` | `Promise<IWhisperServer>`: a persistent server, see [Live dictation](#live-dictation-server-mode). |
| `configure(config)` / `getRuntimeConfig()` | Set / read the locations of binaries, models, FFmpeg and temporary files. See [Runtime locations](#runtime-locations). |
| `cleanupTempFiles(options?)` | `string[]`: removes temporary audio left by crashed processes. See [Temporary files](#temporary-files). |

The entrypoint is CommonJS. Use the named exports with native Node.js ES modules or `require()`. Each transcript line contains `start`, `end` and `speech`, with an optional `speaker` label when diarization succeeds.

| Option | Description |
| --- | --- |
| `modelName` | Name of a model in the models directory (`lib/whisper.cpp/models/` by default; see [Runtime locations](#runtime-locations)). Defaults to `base.en` when no model selector is provided. |
| `modelPath` | Path to an existing model `.bin` file. Use an absolute path. Mutually exclusive with `modelName`. |
| `whisperOptions` | Native transcription and output options listed below. |
| `shellOptions` | Process output controls. |
| `diarization` | Optional [speaker diarization](#speaker-diarization) settings. |

### Transcription options

| `whisperOptions` field | Default | Behavior |
| --- | --- | --- |
| `language` | `'en'` in the pinned native binary | Language code, such as `'pt'`, or `'auto'` for detection. |
| `gen_file_txt` | `false` | Generate a TXT transcript. |
| `gen_file_subtitle` | `false` | Generate SRT subtitles. |
| `gen_file_vtt` | `false` | Generate WebVTT subtitles. |
| `output_file_path` | Native output location | Output filename prefix, without an extension, for generated files. |
| `word_timestamps` | `false` | Request native word-level output. The wrapper may merge word-like lines into sentence segments. |
| `timestamp_size` | `0` in the native binary | Non-negative maximum segment length in characters. `0` leaves the length unlimited. |
| `no_timestamps` | `false` | Suppress native timestamps; this normally produces an empty structured transcript array. |
| `threads` | min(4, cores) in the native binary | CPU threads (`-t`), an integer from 1 to 1024. |
| `prompt` | None | Initial prompt (`--prompt`), up to 4096 characters: names, vocabulary or punctuation style that guide decoding. Passed as one literal argument. |

Use an absolute `output_file_path` to select a predictable destination; relative prefixes are interpreted from the native executable's working directory.

Use either `timestamp_size` or `word_timestamps`, not both. Keep `no_timestamps: false` when you need structured JSON. Generated TXT/SRT/VTT files can still be requested independently of the returned array.

```typescript
import path from 'node:path';
import { whisper, type IOptions } from '@lumen-labs-dev/whisper-node';

const options: IOptions = {
  modelName: 'base',
  whisperOptions: {
    language: 'auto',
    gen_file_txt: true,
    gen_file_subtitle: true,
    output_file_path: path.resolve('transcript'),
  },
  shellOptions: { silent: true },
};

const transcript = await whisper('audio.mp4', options);
console.log(transcript);
```

### Detected language

`transcribe()` takes the same options as `whisper()` and also reports the spoken language:

```javascript
import { transcribe } from '@lumen-labs-dev/whisper-node';

const { transcript, language } = await transcribe('interview.mp3', {
  modelName: 'base',
  whisperOptions: { language: 'auto' },
});

console.log(language); // { code: 'pt', probability: 0.97, detected: true }
```

| `language` field | Meaning |
| --- | --- |
| `code` | ISO 639 code whisper.cpp used to decode, such as `'en'` or `'pt'`. |
| `probability` | Detection probability from 0 to 1. Present only when the language was auto-detected. |
| `detected` | `true` for auto-detection; `false` when the language was requested or forced. |

The value comes from whisper.cpp's diagnostic output. English-only (`.en`) models always decode English, so `'auto'` reports `{ code: 'en', detected: false }` with them. `language` is omitted when native output includes no language.

### Process options and types

`shellOptions.silent` defaults to `true`; set it to `false` to display native process output. The legacy `shellOptions.async` flag is accepted for compatibility. Calls always execute asynchronously and return a Promise.

Processes receive literal argument arrays and a per-process working directory. Paths with spaces or shell metacharacters do not require manual quoting.

Exported TypeScript types include `IOptions`, `IFlagTypes`, `IShellOptions`, `ITranscriptLine`, `ITranscriptionResult`, `ILanguageInfo`, `IStreamOptions`, `IStreamSegment`, `StreamSource`, `DiarizationOptions`, `DiarizationResult`, `DiarizationBackend`, `DiarizationBackendName`, `IWhisperServer`, `IWhisperServerOptions`, `ITranscribePCMOptions`, `IServerStreamOptions`, `IServerTranscription`, `IRuntimeConfig` and `ICleanupOptions`. `WhisperNodeError` and `ValidationError` are exported for `instanceof` checks; errors carry a `code` such as `MODEL_NOT_FOUND`, `NATIVE_NOT_FOUND`, `VC_RUNTIME_MISSING` or `SERVER_CLOSED`.

## Streaming transcription

`transcribeStream()` transcribes audio as it arrives and yields lines as whisper.cpp prints them. The source can be a file path, a `Buffer`, a Node `Readable` (such as an HTTP upload or a child process's stdout) or any sync or async iterable of `Buffer`/`Uint8Array` chunks. Do not set an encoding on the stream; text chunks are rejected.

```javascript
import { createReadStream } from 'node:fs';
import { transcribeStream } from '@lumen-labs-dev/whisper-node';

for await (const segment of transcribeStream(createReadStream('podcast.mp3'), {
  modelName: 'base',
  whisperOptions: { language: 'auto' },
  chunkSeconds: 30,
})) {
  console.log(segment.start, segment.end, segment.language, segment.speech);
}
```

FFmpeg decodes the bytes to 16 kHz mono PCM. The PCM is split into chunks of about `chunkSeconds`. Each chunk is cut at the quietest 20 ms frame in its last 20 %, so words are not split. Timestamps count from the start of the stream. Each segment also has `chunk`, the zero-based index of its chunk, and `language` when known.

| Stream option | Default | Behavior |
| --- | --- | --- |
| `chunkSeconds` | `30` | Target chunk length, from 2 to 600 seconds. Shorter chunks give earlier results; longer chunks give Whisper more context. |
| `inputFormat` | Probed by FFmpeg | Set `'pcm_s16le'` for raw 16 kHz mono little-endian PCM16, such as microphone capture; FFmpeg is skipped. Any other value is passed to FFmpeg as its `-f` input format. |
| `lockLanguage` | `true` | With `language: 'auto'`, reuse the first detected language for later chunks. |
| `skipSilence` | `true` | Skip chunks that contain only digital silence, where Whisper tends to invent text. |
| `signal` | None | An `AbortSignal`. Aborting stops decoding and the native process, and the loop rejects with code `ABORTED`. |

All `whisper()` options also apply. Lines arrive as each native segment is printed. With `word_timestamps`, each chunk is merged into sentences before its lines are yielded. Breaking out of the loop stops the work and removes the temporary chunk files. At most two decoded chunks wait in memory, so a fast source is held back while Whisper catches up.

Streaming supports only the `tinydiarize` diarization backend, which tracks speaker turns across chunks. The other backends need the whole recording. Trailing audio shorter than 100 ms is dropped.

`transcribeStream()` starts one `whisper-cli` process per chunk, and each process loads the model again. That suits files and batch work. For live dictation, use the server mode below.

## Live dictation (server mode)

`createWhisperServer()` starts the native `whisper-server` once, waits for the model to load and keeps it in memory. Audio goes to it from memory over HTTP on `127.0.0.1`, so nothing is written to disk and no process starts per chunk. The `whisper-cli` mode above stays available.

```javascript
import { createWhisperServer } from '@lumen-labs-dev/whisper-node';

const server = await createWhisperServer({
  modelName: 'base-q5_1', // multilingual; see Models
  language: 'pt',
  threads: 4,
  prompt: 'Ditado em português. Luanda, Maputo, kwanzas.',
  idleTimeoutMs: 120_000, // stop the process after 2 idle minutes; the next request restarts it
});

// One buffer: 16 kHz mono PCM16 bytes, Int16Array or Float32Array.
const { transcript, language } = await server.transcribePCM(pcm16k);

// Or a live source: Readable, async iterable of PCM chunks, buffer or file.
for await (const segment of server.transcribeStream(microphone, { inputFormat: 'pcm_s16le', chunkSeconds: 5 })) {
  console.log(segment.start, segment.speech);
}

await server.close();
```

| Server option | Default | Behavior |
| --- | --- | --- |
| `modelName` / `modelPath` | Configuration file, then `base.en` | Model selection, as for `whisper()`. The file must exist before start. |
| `language` | `'en'` | Default language for requests, or `'auto'`. Use `'pt'` with a multilingual model for Portuguese. |
| `threads` | min(4, cores) | CPU threads (`-t`). |
| `prompt` | None | Default initial prompt (`--prompt`); requests can override it. |
| `beamSize` | Greedy decoding | Beam search width (`-bs` and `-bo`), 1–16. `whisper-cli` uses 5, so transcripts from the two modes can differ slightly. 5 gives the same decoding at higher latency. |
| `port` | Free port at each start | Loopback port. The host is always `127.0.0.1`. |
| `idleTimeoutMs` | `0` (never) | Stop the process after this much inactivity to save memory and power. It restarts on the next request, which then waits for the model to load. |
| `autoRestart` | `true` | Restart the process with exponential backoff if it exits unexpectedly. |
| `maxRestarts` | `5` | Consecutive failed restarts before automatic restarts stop. Requests still try once. The count resets after a successful request. |
| `startupTimeoutMs` | `60000` | Maximum wait for the model to load. |
| `requestTimeoutMs` | `120000` | Maximum time for one request. |
| `executable` | Configured native root | Absolute path to a custom `whisper-server` build. |

| `transcribePCM` option | Behavior |
| --- | --- |
| `language` | Override the server language for this request. With `'auto'`, the result reports the detected language and its probability. |
| `prompt` | Override the server prompt. `''` sends no prompt. |
| `word_timestamps` / `timestamp_size` | Same meaning as in `whisperOptions`. |
| `offsetMs` | Added to all timestamps, for callers that track their own stream position. |
| `signal` | `AbortSignal` that cancels the request. |

`server.transcribeStream(source, options)` uses the same chunking as `transcribeStream()` (`chunkSeconds`, `inputFormat`, `lockLanguage`, `skipSilence`, `signal`), plus `language`, `prompt` and `word_timestamps`. With `language: 'auto'`, the first detected language is locked for later chunks. Diarization is not available in server mode.

Requests use the server's WebVTT output for segment timestamps. A request with `language: 'auto'` uses `verbose_json` instead, the only format that reports the detected language. Detection and that format each add roughly one encoder pass of latency, so set the language when it is known. In streams, `lockLanguage` limits the cost to the first chunk.

The server instance exposes `port`, `pid`, `running` and `restarts`. Requests are processed one at a time, in order. A request that hits a crashed process is retried once on a new process. Results are clamped to the audio duration, because whisper.cpp pads input to 30 s. Audio shorter than 100 ms returns an empty transcript without a request. `close()` stops the process; a host process that exits without calling it still kills the process on its way out.

The server listens on `127.0.0.1` only. `whisper-server` has no API key, so each start uses a random 128-bit request path (for example `/<token>/inference`) that other local programs and web pages cannot guess. This covers `/load`, which can swap the model. The path also confirms that the process answering on the port is the one that was started.


## Models

The interactive downloader is available through either command:

```sh
npx whisper-node
npx whisper-node download
```

It writes model files to the models directory: `lib/whisper.cpp/models/` inside the installed package, or `WHISPER_NODE_MODELS` when set. Enter `cancel` to exit. A valid `modelName` in the configuration file skips the prompt.

The default model stays `base.en` for compatibility, and it understands **English only**: with it, `language: 'pt'` still produces English. For Portuguese and other languages, download a multilingual model and set the language:

```javascript
const transcript = await whisper('ditado.wav', { modelName: 'base-q5_1', whisperOptions: { language: 'pt' } });
```

| Multilingual model | File | Size | Use |
| --- | --- | ---: | --- |
| `base-q5_1` | `ggml-base-q5_1.bin` | 57 MiB | Fast dictation on modest laptops. |
| `small-q5_1` | `ggml-small-q5_1.bin` | 181 MiB | Better accuracy; about three times slower. See [docs/performance.md](docs/performance.md). |

| Model group | Supported names and examples |
| --- | --- |
| Multilingual | `tiny`, `base`, `small`, `medium`, `large`, `large-v1`, `large-v2`, `large-v3`, `large-v3-turbo` |
| English-only | `tiny.en`, `base.en`, `small.en`, `medium.en` |
| Quantized variants | Selected `q5_0`, `q5_1` and `q8_0` variants, such as `base.en-q8_0` and `large-v3-turbo-q5_0` |

The complete name-to-file mapping is defined in [src/core/whisper.ts](src/core/whisper.ts). Choose a multilingual model for languages other than English.

To use a model stored elsewhere:

```javascript
import path from 'node:path';
import { whisper } from '@lumen-labs-dev/whisper-node';

const transcript = await whisper('audio.wav', {
  modelPath: path.resolve('models/ggml-base.bin'),
  whisperOptions: { language: 'auto' },
});

console.log(transcript);
```

Provide only one model selector across the combined configuration and API options. For example, remove a configured `modelName` before switching to `modelPath`.

## Audio preparation

The input is a local audio or video file. FFmpeg handles supported formats such as MP3, M4A and MP4, selecting the first audio stream when conversion is needed.

- A 16 kHz mono PCM WAV with 16-, 24- or 32-bit samples is reused for transcription.
- PCM16 WAVs are also read directly for diarization, avoiding another FFmpeg process and temporary WAV.
- Other inputs are converted to a sibling `<name>.wav16k.wav` file. This file remains on disk after transcription.
- Diarization converts 24-/32-bit or otherwise incompatible inputs to PCM16 when needed.

WAV parsing follows RIFF chunks, including metadata and padding. PCM reads use a scratch buffer capped at 256 KiB; diarization still holds the decoded samples in a `Float32Array`.

FFmpeg is **optional**. 16 kHz mono PCM WAV files, streams with `inputFormat: 'pcm_s16le'` and everything sent to the server mode never start it. For other formats, the executable is chosen in this order: `configure({ ffmpegPath })`, `FFMPEG_PATH`, the optional `ffmpeg-static` dependency (installed by default, about 75 MB), then `ffmpeg` on `PATH`. If none is found, the call fails with code `ERR_FFMPEG_NOT_FOUND` and a message explaining these options. To leave it out, install with `npm install --omit=optional`.

## Speaker diarization

Diarization adds labels such as `S0` and `S1`. Choose a backend with `backend`:

| Backend | How it works | Best for |
| --- | --- | --- |
| `'energy'` (default) | Energy VAD, then k-means over frame log-energy and its delta. | Speakers with clearly different loudness. Fastest. |
| `'spectral'` | Energy VAD, then the MFCC mean and standard deviation over `segmentMs` windows, standardized and clustered with k-means. Labels are numbered by first appearance, and isolated one-window flips are smoothed out. | Speakers at similar volume with different voice timbre. Pure JavaScript. |
| `'tinydiarize'` | whisper.cpp's `-tdrz` speaker-turn detection, run during transcription. Needs a tdrz model such as `small.en-tdrz`. | English audio, including streaming. |
| Custom object | Your `diarize(audioPath, options)` returns `{ segments: [{ start, end, speaker }] }` in seconds. | External models such as pyannote, or a hosted service. |


```typescript
import { whisper, type DiarizationOptions } from '@lumen-labs-dev/whisper-node';

const diarization: DiarizationOptions = {
  enabled: true,
  numSpeakers: 2,
  frameMs: 20,
};

const transcript = await whisper('meeting.wav', {
  modelName: 'base',
  whisperOptions: { language: 'auto' },
  diarization,
});

console.log(transcript);
```

| Setting | Default | Behavior |
| --- | --- | --- |
| `enabled` | `false` | Enable speaker labeling. |
| `numSpeakers` | `2` | Positive integer, capped at six speakers. The count is not estimated automatically. |
| `frameMs` | `20` | Analysis frame duration in milliseconds. |
| `vadThreshold` | Computed | Override the energy threshold; otherwise it uses median log-energy multiplied by 1.5. |
| `backend` | `'energy'` | `'energy'`, `'spectral'`, `'tinydiarize'` or a custom backend object. |
| `segmentMs` | `1000` | Spectral backend: length of each speaker embedding window. Must be at least `frameMs`. |

Short or uniform recordings may produce fewer distinct labels than requested. Labels belong to the recording and do not identify people across files or versions.

tinydiarize detects turns, not identities. Labels rotate through `numSpeakers` (default 2) at each predicted turn, so a third speaker reuses an earlier label. It adds no audio pass of its own. A model without `tdrz` in its name logs a warning, because it predicts no turns.

A custom backend receives the prepared 16 kHz mono WAV path and the diarization options. Its segments are validated and sorted before speakers are assigned:

```javascript
import { whisper } from '@lumen-labs-dev/whisper-node';

const pyannote = {
  name: 'pyannote',
  async diarize(audioPath, options) {
    const segments = await runMyPyannoteScript(audioPath, options.numSpeakers);
    return { segments }; // [{ start: 0.0, end: 3.2, speaker: 'SPEAKER_00' }, ...]
  },
};

const transcript = await whisper('meeting.wav', { diarization: { enabled: true, backend: pyannote } });
```

The built-in backends are simple and have limits with overlapping speech and noisy audio. If the energy, spectral or custom backend fails, the API logs a warning and returns the transcription without speaker labels. An unknown backend name is rejected with a `ValidationError` before transcription starts.

## Configuration

The loader reads `whisper-node.config.json` or `whisper.config.json` from the current working directory, in that order. Set `WHISPER_NODE_CONFIG` to select an explicit JSON file.

```json
{
  "modelName": "base.en",
  "whisperOptions": {
    "language": "auto",
    "word_timestamps": false
  },
  "shellOptions": {
    "silent": true
  }
}
```

API values override corresponding configuration values; omitted settings retain their configured values or defaults. Configuration supports `modelName`, `modelPath`, `whisperOptions` and `shellOptions`. Pass `diarization` directly to `whisper()`. `createWhisperServer()` also uses the configured `modelName`/`modelPath`.

### Runtime locations

By default, binaries and models live in the package's `lib/whisper.cpp/`. An application can move them with `configure()`, which affects every later call in the process:

```javascript
import { configure } from '@lumen-labs-dev/whisper-node';

configure({
  nativeRoot: 'C:\\Program Files\\MyApp\\resources\\bin\\whisper',
  modelsPath: 'C:\\Program Files\\MyApp\\resources\\models',
  tmpDir: 'C:\\Users\\me\\AppData\\Roaming\\MyApp\\tmp',
});
```

| `configure` field | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `nativeRoot` | `WHISPER_NODE_ROOT` | `lib/whisper.cpp` in the package | Folder with the whisper.cpp binaries. On Windows it can hold the variant folders (`Win64`, `BlasWin64`, ...), or flat, the files of one variant (`whisper-cli.exe`, `whisper-server.exe` and their DLLs). |
| `modelsPath` | `WHISPER_NODE_MODELS` | `<nativeRoot>/models` | Folder searched for `modelName` and used by the model downloader. |
| `ffmpegPath` | `FFMPEG_PATH` | `ffmpeg-static`, then `ffmpeg` on `PATH` | FFmpeg executable, used only for non-WAV input. |
| `tmpDir` | `WHISPER_NODE_TMPDIR` | `os.tmpdir()` | Parent folder for temporary audio chunks. |
| `flavor` | `WHISPER_WIN_FLAVOR` | `cpu` | Windows variant inside `nativeRoot`: `cpu` or `blas`. |

Values set with `configure()` win over environment variables, which win over the defaults. Paths must be absolute, because an app's working directory is not predictable; relative values are rejected with a `ValidationError`. Pass `null` for a field to return it to its default. `getRuntimeConfig()` returns the effective values. `WHISPER_WIN_BIN_DIR` still selects a subfolder, and it must stay inside `nativeRoot`: values such as `..\\..\\Windows` are rejected.

When the package itself sits inside an Electron `app.asar`, the default paths point to `app.asar.unpacked` automatically. The same applies to the `ffmpeg-static` path.

### Temporary files

Only `whisper-cli` streaming writes audio to disk: each chunk becomes a WAV in a private folder named `wh-stream-<pid>-XXXXXX` under `tmpDir`. Each file is removed as soon as its chunk is transcribed, and the folder when the stream ends. Diarization conversions use `wh-<pid>-XXXXXX` the same way. Server mode writes no audio.

If a process is killed, its folder stays behind. The first streaming call or `createWhisperServer()` in each process removes such leftovers, and an app can call `cleanupTempFiles()` itself at startup. It removes only folders with this package's naming pattern that contain only its chunk files, and only when the owning process has exited (or, for folders from 1.0.x without a process id, when they are older than 10 minutes). On shared computers, set `tmpDir` to a per-user application folder.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `WHISPER_NODE_CONFIG` | Explicit path to a configuration JSON file. |
| `WHISPER_NODE_LOG_LEVEL` | `ERROR`, `WARN`, `INFO` or `DEBUG`; defaults to `INFO`. |
| `WHISPER_NODE_ROOT` | Native binaries folder. See [Runtime locations](#runtime-locations). |
| `WHISPER_NODE_MODELS` | Models folder, also used by the model downloader. |
| `WHISPER_NODE_TMPDIR` | Parent folder for temporary audio. |
| `FFMPEG_PATH` | Runtime FFmpeg executable override. |
| `WHISPER_WIN_FLAVOR` | `cpu` or `blas`; defaults to `cpu`. |
| `WHISPER_WIN_BIN_DIR` | Windows binary subdirectory inside the native root. Takes precedence over the flavor. |
| `WHISPER_NODE_VCRUNTIME` | `native:setup` only: `system` or a folder to copy the Visual C++ runtime DLLs from. |

PowerShell, for the current session:

```powershell
$env:WHISPER_NODE_LOG_LEVEL = 'DEBUG'
$env:WHISPER_WIN_FLAVOR = 'blas'
node transcribe.mjs
```

Bash:

```sh
WHISPER_NODE_LOG_LEVEL=DEBUG node transcribe.mjs
```

## Electron / offline apps

The library runs in Electron's main process (Electron 35 or later, for Node.js 22). Electron cannot execute programs or load DLLs from inside `app.asar`, so the native files must live outside the archive. Two layouts work:

| Layout | How | Notes |
| --- | --- | --- |
| **Copy to resources** (recommended) | Copy one variant to `resources/bin/whisper` and the models to `resources/models` with electron-builder `extraResources`, then call `configure({ nativeRoot, modelsPath })`. | Smallest installer: ship only the needed files. Exclude `node_modules/@lumen-labs-dev/whisper-node/lib/whisper.cpp/**` from `files`. |
| **asarUnpack** | `"asarUnpack": ["node_modules/@lumen-labs-dev/whisper-node/lib/whisper.cpp/**"]`. | No `configure()` needed: default paths switch to `app.asar.unpacked`. Ships every variant (about 150 MB). |

The minimal Windows x64 CPU set is `whisper-server.exe`, `whisper-cli.exe`, `whisper.dll`, `ggml*.dll` and the Visual C++ runtime DLLs, about 14 MB. The BLAS variant adds `libopenblas.dll` and `ggml-blas.dll`, about 65 MB. Keep `LICENSE` and the files under `licenses/` with them.

```javascript
// main process
const path = require('node:path');
const { app } = require('electron');
const { configure, createWhisperServer } = require('@lumen-labs-dev/whisper-node');

const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
configure({
  nativeRoot: path.join(resources, 'bin', 'whisper'),
  modelsPath: path.join(resources, 'models'),
  tmpDir: path.join(app.getPath('userData'), 'tmp'),
});
const server = await createWhisperServer({ modelName: 'base-q5_1', language: 'pt', idleTimeoutMs: 120_000 });
```

Everything runs offline: model and binary downloads happen only in `native:setup` and the model CLI, at build time. FFmpeg is not needed when the renderer sends 16 kHz PCM, so the optional `ffmpeg-static` package can be left out (`npm install --omit=optional`, or exclude `node_modules/ffmpeg-static/**`).

[examples/electron](examples/electron) is a minimal dictation app. The renderer captures the microphone at 16 kHz with an AudioWorklet and sends Int16 PCM over IPC; the main process feeds it to `server.transcribeStream()` in 5-second chunks and sends each partial text back. Its `prepare-resources` script copies the minimal file set and the Visual C++ runtime.

### Visual C++ runtime

The official Windows builds need the Microsoft Visual C++ 2015–2022 runtime. Without it the executables exit with `0xC0000135` and the library reports error code `VC_RUNTIME_MISSING`. Rather than running the Redistributable installer, place these DLLs next to `whisper-cli.exe` / `whisper-server.exe`. Windows loads DLLs from the executable's folder first, a deployment Microsoft calls app-local.

| DLL | x64 | x86 |
| --- | :---: | :---: |
| `vcruntime140.dll` | ✓ | ✓ |
| `vcruntime140_1.dll` | ✓ | |
| `msvcp140.dll` | ✓ | ✓ |
| `vcomp140.dll` (OpenMP, used by `ggml-cpu`) | ✓ | ✓ |

`npm run native:setup -- --vcruntime=<folder>` copies them into every installed variant, checking each file's architecture. Use the Visual Studio redistributable folder (`VC\Redist\MSVC\<version>\x64` or `x86`), which is covered by the Visual Studio redistribution terms. `--vcruntime` alone (or `WHISPER_NODE_VCRUNTIME=system`) copies the build machine's `System32`/`SysWOW64` files. Nothing is downloaded. Integrity receipts ignore these added DLLs, so later setups do not reinstall the variants. `npm pack` leaves both these DLLs and downloaded `models/*.bin` files out of the package; ship them with your application. From code, `installVcRuntime(directory, arch, source)` and `missingVcRuntime(directory, arch)` in `packages/whisper-native` do the same for a custom folder.

## Native assets

The native release is pinned to **whisper.cpp v1.9.5**, using the official **b5454** Windows artifacts. Both tags identify commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`. See the [stable release](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5) and its [associated binary build](https://github.com/ggml-org/whisper.cpp/releases/tag/b5454).

### Windows

| Folder under `lib/whisper.cpp/` | Architecture | Backend |
| --- | --- | --- |
| `Win32` | x86 / 32-bit | CPU |
| `Win64` | x64 / 64-bit | CPU |
| `BlasWin32` | x86 / 32-bit | OpenBLAS |
| `BlasWin64` | x64 / 64-bit | OpenBLAS |

The default folder follows the Node.js process architecture. Set `WHISPER_WIN_FLAVOR=blas` to use the matching BLAS build. These variants require no local compiler.

The binaries need the Microsoft Visual C++ 2015–2022 runtime matching their architecture. Install the Redistributable, or place the runtime DLLs next to the executables (see [Visual C++ runtime](#visual-c-runtime)). A missing runtime prevents startup with error `0xC0000135`.

Each variant contains `whisper-cli.exe`, used by `whisper()`, `transcribe()` and `transcribeStream()`, and `whisper-server.exe`, used by `createWhisperServer()`.

CUDA builds remain optional custom installations. The legacy `cublas-11.8` and `cublas-12.4` flavor aliases select `CublasWin64-11.8` and `CublasWin64-12.4` respectively; those folders must be supplied separately.

### Native setup and integrity

In a source checkout, restore the version specified by the release lock:

```sh
npm run native:setup
```

[packages/whisper-native/release.json](packages/whisper-native/release.json) records source/build tags, the commit, upstream URLs, archive SHA-256 hashes and pinned support files.

Windows setup stages every changed variant before replacement. It verifies archive hashes, executable architecture, required DLLs and CLI startup. Complete folders are replaced together to avoid mixing old and new DLLs. Per-file receipts detect stale or modified installations, and a failed replacement triggers rollback. Existing `models/` files are preserved.

The compatible upstream BLAS bundles include OpenBLAS 0.3.29 and SDL2 2.28.5. Model download helper scripts and redistribution notices are pinned too; notices are stored in `lib/whisper.cpp/LICENSE` and `lib/whisper.cpp/licenses/`.

The model downloader fetches model weights. To restore missing native files, use `native:setup` in a source checkout or reinstall a prepared npm package.

### macOS and Linux

Source builds require Git, CMake and a C/C++ compiler. Run `npm run native:setup` from a source checkout to prepare the pinned upstream source, then build the Node wrapper. The native executable is built through CMake on first transcription if missing.

Existing upstream source trees must match the pinned version. A native directory prepared on Windows contains Windows binaries; use source setup when preparing a package for macOS/Linux.

## Internal packages and dependencies

Version 0.5.0 moved runtime helpers into local modules under `packages/`. These modules implement the subset of behavior used by this project and ship in the npm archive with TypeScript declarations. Their APIs are internal.

| Internal module | Responsibility | Replaces |
| --- | --- | --- |
| `packages/process` | Literal process arguments, bounded output and a per-process working directory | `shelljs` |
| `packages/audio` | WAV detection, conversion and bounded PCM reads | `fluent-ffmpeg`, `ffprobe-static` |
| `packages/clustering` | Deterministic, bounded k-means | `ml-kmeans` |
| `packages/prompt` | Asynchronous CLI input through Node readline | `readline-sync` |
| `packages/download` | HTTPS downloads with redirect limits, inactivity timeouts and atomic file replacement | Duplicated download code |
| `packages/whisper-native` | Release lock, integrity checks, Windows updates and architecture selection | Unversioned native downloads |

The unused `wavefile` dependency was removed. Development scripts now use TypeScript and Node directly, replacing `nodemon`, `ts-node`, `shx` and `@types/shelljs`.

There are no required external runtime npm dependencies. **ffmpeg-static 5.3.0** is an optional dependency since 1.1.0: it supplies FFmpeg platform binaries for non-WAV input and has its own transitive dependencies. The lockfile also pins **TypeScript 7.0.2** and **@types/node 24.19.2** as development dependencies.

On 2026-10-21, `npm audit` reported **zero vulnerabilities**, down from the original 13 findings. That audit covers the npm dependency tree; FFmpeg/whisper.cpp binaries and model files have separate upstream lifecycles.

## Performance

### CLI vs server mode

Latency per 5-second chunk of Portuguese speech, 4 threads, median of 7 (Ryzen 9 7900X, Windows x64):

| Variant | Model | CLI (beam 5) | Server (beam 5) | Server (greedy, default) |
| --- | --- | ---: | ---: | ---: |
| cpu | base-q5_1 | 822 ms | 667 ms | 535 ms |
| cpu | small-q5_1 | 2490 ms | 2248 ms | 1959 ms |
| blas | base-q5_1 | 622 ms | 455 ms | 328 ms |
| blas | small-q5_1 | 1640 ms | 1723 ms | 1188 ms |

On this fast machine a model loads in 0.2–0.4 s, so starting a process per chunk costs little. Slower storage and colder caches widen the gap. See [docs/performance.md](docs/performance.md#inference-cli-mode-vs-server-mode-110) for the method, ranges and caveats, and run `npm run benchmark:inference` on the target hardware.

### Audio and transcript processing

Version **0.5.1** removes redundant audio conversion, bounds PCM input buffering, indexes chronological speaker segments, tracks merged text length incrementally and uses typed-array sorting for the VAD median.

| Component benchmark | Before | After | Ratio |
| --- | ---: | ---: | ---: |
| Extract PCM from an already compliant 5-minute WAV | 102.252 ms | 9.067 ms | 11.28x |
| Assign 1200 transcript lines across 120000 speaker segments | 522.733 ms | 4.192 ms | 124.70x |
| Merge 6000 words with the default 320-character limit | 7.838 ms | 3.615 ms | 2.17x |
| Merge 6000 words with a custom 65536-character limit | 223.220 ms | 3.825 ms | 58.36x |
| Compute the VAD median over 90000 frames | 20.250 ms | 6.958 ms | 2.91x |

These are synthetic component measurements on Windows x64, Node 24.21.0 and a Ryzen 9 7900X. Results are medians of seven samples after two warmups, compared with commit `2b9edda`. They measure preparation and post-processing, not Whisper model inference or total transcription time.

PCM reader time was effectively unchanged; its input scratch buffer is now capped at 256 KiB. Custom overlapping or unordered diarization segments retain their original first-match behavior.

See the [measurement report](docs/performance.md) and [raw results](docs/performance-results.json) for methodology and equivalence checks. To run the benchmark:

```sh
npm run benchmark
npm run benchmark -- --output results.json
```

## Development

From a source checkout:

```sh
npm ci
npm run native:setup
npm test
```

| Command | Purpose |
| --- | --- |
| `npm ci` | Install locked dependencies and build the Node wrapper. |
| `npm run native:setup` | Prepare the native version pinned in the release lock. |
| `npm run build` | Clean stale output, compile TypeScript to `dist/` and mark the downloader executable. |
| `npm run dev` / `npm start` | Watch and compile TypeScript. |
| `npm test` | Build and run Node's test runner. |
| `npm audit` | Audit npm dependencies. |
| `npm run benchmark` | Build and measure audio/transcript processing. |
| `npm run benchmark:inference -- --audio <wav>` | Build and compare per-chunk latency of CLI and server modes. See [docs/performance.md](docs/performance.md). |
| `npm pack` | Build, prepare native assets and create a local npm tarball. |

The automated tests cover audio conversion, WAV chunks, PCM boundaries, every diarization backend, language metadata, stream chunking, FFmpeg piping and abort, operation without FFmpeg, transcript merging, literal process arguments, configurable paths and traversal checks, temporary-file cleanup, the server lifecycle (start, transcribe, idle stop, crash restart, close), download failures, native integrity and rollback. They use synthetic fixtures, a stand-in for the native runner and a Node stand-in for `whisper-server`, and do not download Whisper models. One test drives the real `whisper-server.exe`. It runs only on Windows after native setup, with `lib/whisper.cpp/models/ggml-base-q5_1.bin` or the model in `WHISPER_NODE_TEST_MODEL`.

To adopt another native release, update the source/build tags, commit, artifact hashes and support-file entries in the release lock, then run native setup and validation.

### Source layout

```text
.github/             Issue and pull request templates
src/                 Public API, CLI, configuration, transcription, server mode and diarization
packages/            Internal runtime modules and native release lock
lib/whisper.cpp/     Prepared native assets, sources and models
examples/electron/   Offline dictation example for Electron (not published to npm)
scripts/             Build, native setup and benchmark commands
test/                Node tests and synthetic fixtures
docs/                Performance methodology and recorded results
dist/                Generated JavaScript and TypeScript declarations
```

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Model not found | Run `npx whisper-node` or pass an existing absolute `modelPath`. |
| Both model selectors are set | Keep only `modelName` or `modelPath` across API options and configuration. |
| Empty transcript array | Keep `no_timestamps` disabled so native output includes timestamps. |
| Missing native binary or DLL (`NATIVE_NOT_FOUND`) | Restore the pinned assets in a source checkout, reinstall a prepared package, or check `nativeRoot`. |
| Windows startup error `0xC0000135` (`VC_RUNTIME_MISSING`) | Place the [Visual C++ runtime DLLs](#visual-c-runtime) next to the executables, or install the Redistributable for the binary's x86/x64 architecture. |
| `modelName: 'base-q5_1'` not found in 1.0.x | Fixed in 1.1.0: names with `-` and `_` resolved to the wrong file. |
| Portuguese audio comes out in English | `.en` models (including the default `base.en`) only know English. Use a multilingual model such as `base-q5_1` with `language: 'pt'`. |
| Server mode slower than expected | Set `language` instead of `'auto'`. Detection adds an encoder pass and the `verbose_json` format. |
| Source build fails | Check Git, CMake and the C/C++ compiler; existing sources must match the release lock. |
| FFmpeg cannot start or conversion fails (`ERR_FFMPEG_NOT_FOUND`) | Install `ffmpeg-static`, set `FFMPEG_PATH` or `configure({ ffmpegPath })`, or pass 16 kHz mono PCM16 WAV / `inputFormat: 'pcm_s16le'`. Check write access for the sibling WAV. |
| Long audio uses too much memory | Split the recording. Diarization holds decoded samples in memory and rejects PCM payloads above 500 MiB. |

## Roadmap

Delivered in 1.1.0:

- Persistent server mode for live dictation (`createWhisperServer`).
- Configurable native, model, FFmpeg and temporary paths (`configure`), with Electron support.
- `threads` and `prompt` options; optional FFmpeg; stale temporary audio cleanup; app-local Visual C++ runtime.

Delivered in 1.0.0:

- Streaming audio transcription (`transcribeStream`).
- Optional advanced diarization backends (`spectral`, `tinydiarize` and custom).
- Detected-language metadata in API results (`transcribe`).

Next:

- Automatic speaker-count estimation.
- Whole-stream diarization with the energy and spectral backends while streaming.
- Optional whisper.cpp VAD model support for choosing stream chunk boundaries.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, coding guidelines and the pull request process, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open public issues for security problems. Only the latest 1.1.x release receives security fixes.

## License

[MIT](LICENSE). Third-party native redistribution notices are included with the prepared assets under `lib/whisper.cpp/`.
