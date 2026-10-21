# Whisper-Node

[![npm downloads](https://img.shields.io/npm/dm/@lumen-labs-dev/whisper-node)](https://www.npmjs.com/package/@lumen-labs-dev/whisper-node)
[![License](https://img.shields.io/npm/l/@lumen-labs-dev/whisper-node)](LICENSE)

**Version 1.0.0 · Node.js 22+ · MIT**

Local audio and video transcription for Node.js using [whisper.cpp](https://github.com/ggml-org/whisper.cpp). The API returns timestamped text with the spoken language. It can also transcribe audio streams chunk by chunk and add speaker labels through pluggable diarization backends.

- Local CPU transcription with JavaScript and TypeScript support.
- Automatic conversion of common audio/video formats to 16 kHz mono WAV.
- Structured transcripts and optional TXT, SRT and VTT files.
- Detected-language metadata, with the detection probability.
- Streaming transcription from files, Node streams or raw PCM, with incremental results.
- Speaker diarization with energy, spectral (MFCC), tinydiarize or custom backends.
- Precompiled Windows CPU/OpenBLAS binaries for x86 and x64.
- Internal runtime modules with a pinned native release and integrity checks.

## Contents

- [Quick start](#quick-start)
- [API](#api)
- [Streaming transcription](#streaming-transcription)
- [Models](#models)
- [Audio preparation](#audio-preparation)
- [Speaker diarization](#speaker-diarization)
- [Configuration](#configuration)
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

The entrypoint is CommonJS. Use the named exports with native Node.js ES modules or `require()`. Each transcript line contains `start`, `end` and `speech`, with an optional `speaker` label when diarization succeeds.

| Option | Description |
| --- | --- |
| `modelName` | Name of a model under the package's `lib/whisper.cpp/models/` directory. Defaults to `base.en` when no model selector is provided. |
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

Exported TypeScript types include `IOptions`, `IFlagTypes`, `IShellOptions`, `ITranscriptLine`, `ITranscriptionResult`, `ILanguageInfo`, `IStreamOptions`, `IStreamSegment`, `StreamSource`, `DiarizationOptions`, `DiarizationResult`, `DiarizationBackend` and `DiarizationBackendName`.

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


## Models

The interactive downloader is available through either command:

```sh
npx whisper-node
npx whisper-node download
```

It writes model files to `lib/whisper.cpp/models/` inside the installed package. Enter `cancel` to exit. A valid `modelName` in the configuration file skips the prompt.

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

The bundled executable comes from `ffmpeg-static`. Set `FFMPEG_PATH` to select another FFmpeg executable at runtime.

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

API values override corresponding configuration values; omitted settings retain their configured values or defaults. Configuration supports `modelName`, `modelPath`, `whisperOptions` and `shellOptions`. Pass `diarization` directly to `whisper()`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `WHISPER_NODE_CONFIG` | Explicit path to a configuration JSON file. |
| `WHISPER_NODE_LOG_LEVEL` | `ERROR`, `WARN`, `INFO` or `DEBUG`; defaults to `INFO`. |
| `FFMPEG_PATH` | Runtime FFmpeg executable override. |
| `WHISPER_WIN_FLAVOR` | `cpu` or `blas`; defaults to `cpu`. |
| `WHISPER_WIN_BIN_DIR` | Override the Windows binary subdirectory inside `lib/whisper.cpp/`. Takes precedence over the flavor. |

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

Install the Microsoft Visual C++ 2015–2022 Redistributable matching the chosen binary's architecture. A missing runtime can prevent startup with error `0xC0000135`.

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

There is one direct external runtime npm dependency: **ffmpeg-static 5.3.0**, which supplies platform binaries and has its own transitive dependencies. The lockfile also pins **TypeScript 7.0.2** and **@types/node 24.19.2** as development dependencies.

On 2026-10-21, `npm audit` reported **zero vulnerabilities**, down from the original 13 findings. That audit covers the npm dependency tree; FFmpeg/whisper.cpp binaries and model files have separate upstream lifecycles.

## Performance

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
| `npm pack` | Build, prepare native assets and create a local npm tarball. |

The automated tests cover audio conversion, WAV chunks, PCM boundaries, every diarization backend, language metadata, stream chunking, FFmpeg piping and abort, transcript merging, literal process arguments, download failures, native integrity and rollback. They use synthetic fixtures and a stand-in for the native runner, and do not download Whisper models. Full transcription testing requires a model.

To adopt another native release, update the source/build tags, commit, artifact hashes and support-file entries in the release lock, then run native setup and validation.

### Source layout

```text
.github/             Issue and pull request templates
src/                 Public API, CLI, configuration, transcription and diarization
packages/            Internal runtime modules and native release lock
lib/whisper.cpp/     Prepared native assets, sources and models
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
| Missing native binary or DLL | Restore the pinned assets in a source checkout, or reinstall a prepared package. |
| Windows startup error `0xC0000135` | Install the Visual C++ Redistributable matching the binary's x86/x64 architecture. |
| Source build fails | Check Git, CMake and the C/C++ compiler; existing sources must match the release lock. |
| FFmpeg cannot start or conversion fails | Check the bundled executable or `FFMPEG_PATH`, the input format and write access for the sibling WAV. |
| Long audio uses too much memory | Split the recording. Diarization holds decoded samples in memory and rejects PCM payloads above 500 MiB. |

## Roadmap

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

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open public issues for security problems. Only the latest 1.0.x release receives security fixes.

## License

[MIT](LICENSE). Third-party native redistribution notices are included with the prepared assets under `lib/whisper.cpp/`.
