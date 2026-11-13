# Performance measurements

Node.js audio preparation and transcript post-processing were compared against commit `2b9edda` using identical generated inputs.

| Operation | Before (ms) | After (ms) | Ratio |
| --- | ---: | ---: | ---: |
| PCM reader, 5-minute WAV | 9.633 | 9.368 | 1.03x |
| Extract PCM from an already compliant 5-minute WAV | 102.252 | 9.067 | 11.28x |
| 1200 transcript lines / 120000 speaker segments | 522.733 | 4.192 | 124.70x |
| 6000 words, custom 65536-character segment limit | 223.220 | 3.825 | 58.36x |
| 6000 words, default 320-character segment limit | 7.838 | 3.615 | 2.17x |
| VAD median over 90000 frames | 20.250 | 6.958 | 2.91x |

Measured on 2026-10-21 with Node v24.21.0, Windows x64 and AMD Ryzen 9 7900X 12-Core Processor. Each figure is the median of seven samples after two warmups, with explicit garbage collection before each sample. WAV data was served from the local filesystem cache. These are synthetic component benchmarks; they do not measure Whisper model inference or imply the same speedup for an entire transcription.

PCM read time was effectively unchanged. The reader now caps its input scratch buffer at 256 KiB instead of allocating the entire PCM payload; the output Float32Array still scales with audio duration.

The largest change is that already compliant PCM16 WAVs are read directly, removing a redundant FFmpeg process and temporary WAV. Other formats retain the conversion fallback.

Speaker lookup uses binary search for chronological, non-overlapping diarization segments. Custom overlapping or unordered segments keep the original first-match behavior. Word merging tracks text length incrementally and joins only when flushing a segment. VAD threshold calculation sorts a Float64Array while retaining the previous NaN behavior.

Validation includes 36 automated tests and a comparison against the baseline for 200 speaker-assignment cases, 200 word-merge cases, 200 VAD inputs and 150000 decoded PCM samples.

## Reproduce

`npm run benchmark` builds and benchmarks the current source. Run `npm run benchmark -- --output results.json` to save the measurements.

To compare another checkout with the same harness, compile that checkout and run `node --expose-gc scripts/benchmark.js --root /path/to/checkout --output baseline.json`. Use the same Node.js version, machine and FFmpeg binary for both runs. Raw measurements are recorded in [performance-results.json](performance-results.json).

## Inference: CLI mode vs server mode (1.1.0)

Latency to transcribe one 5-second chunk of Portuguese speech with `language: 'pt'` and 4 threads. The CLI mode starts `whisper-cli.exe` for each chunk, so it loads the model every time. The server mode sends the chunk from memory to a `whisper-server.exe` that is already running. Each figure is the median of 7 requests after one warmup; the five 5-second chunks were used in turn. The ranges are the minimum and maximum of those 7.

| Variant | Model | CLI, beam 5 | Server, beam 5 | Server, greedy (default) | Server start |
| --- | --- | ---: | ---: | ---: | ---: |
| cpu (`Win64`) | base-q5_1 | 822 ms (771–845) | 667 ms (643–687) · 1.23x | 535 ms (515–559) · 1.54x | 238 ms |
| cpu (`Win64`) | small-q5_1 | 2490 ms (2451–2568) | 2248 ms (2202–2374) · 1.11x | 1959 ms (1940–2003) · 1.27x | 398 ms |
| blas (`BlasWin64`) | base-q5_1 | 622 ms (589–654) | 455 ms (420–544) · 1.37x | 328 ms (318–333) · 1.90x | 212 ms |
| blas (`BlasWin64`) | small-q5_1 | 1640 ms (1577–1773) | 1723 ms (1487–1820) · 0.95x | 1188 ms (1127–1318) · 1.38x | 401 ms |

Measured on 2026-11-13 with Node v24.21.0, Windows 11 x64, an AMD Ryzen 9 7900X (24 logical cores, AVX-512), NVMe storage, whisper.cpp v1.9.5 (b5454). The audio was synthesized offline with the Windows pt-BR voice "Maria" (16 kHz mono, 27 s). Raw rows are in [inference-results.json](inference-results.json).

How to read it:

- `whisper-cli` decodes with beam search 5 by default; `whisper-server` decodes greedily. The "Server, beam 5" column (`beamSize: 5`) uses the same decoding as the CLI, so it isolates the cost of starting a process and loading the model per chunk. "Server, greedy" is what `createWhisperServer()` does by default.
- On this machine the model loads in 0.2–0.4 s because the file sits in the OS cache on a fast disk, so the CLI's per-chunk overhead is small and the gain is 1.1–1.4x at equal decoding. On a laptop with slow storage, little RAM or a cold cache, loading takes much longer and the CLI pays it on every chunk; the server pays it once (or once per `idleTimeoutMs` cycle). We have not measured such a machine; run the benchmark there before sizing chunks.
- The CLI also reads the model from disk again and allocates its buffers for every chunk. Each chunk therefore does extra I/O and memory work, which costs energy that latency alone does not show.
- BLAS helps `base` more than `small` here. With `small-q5_1` and beam 5, BLAS server and CLI are within noise of each other. Measure both variants on the target hardware.
- `small-q5_1` is 3–3.7x slower than `base-q5_1`. With 5-second chunks on a 4-thread budget, `base-q5_1` stays well under real time on this CPU, and `small-q5_1` uses about 40 % of real time.

Server request format matters. Early measurements used `response_format=verbose_json` for every request. That format computes per-word timing and probabilities, and made each request about 1.9 s slower with `small-q5_1` (3.9 s vs 2.0 s), which left the server *slower* than the CLI. Requests now use WebVTT, which carries segment timestamps at plain-JSON cost. Only `language: 'auto'` requests use `verbose_json`, because the detected language is reported only there. Detection itself adds about 1.8 s per request with `small-q5_1` (an extra encoder pass), so set the language whenever it is known.

### Reproduce

```sh
npm run benchmark:inference -- --audio speech-16k-mono.wav --models base-q5_1,small-q5_1 --flavors cpu,blas --runs 7 --threads 4 --output results.json
```

The audio must be 16 kHz mono PCM16 WAV and at least one chunk long (`--chunk`, default 5 s). Download the models first (`npx whisper-node`), and run `npm run native:setup` so that both CPU and BLAS variants are present. On Windows, a test clip can be made offline with `System.Speech.Synthesis.SpeechSynthesizer`, using `SetOutputToWaveFile` with a 16 kHz, 16-bit mono `SpeechAudioFormatInfo`.
