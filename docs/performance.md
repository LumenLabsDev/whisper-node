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
