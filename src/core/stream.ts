import fs from "fs";
import path from "path";
import { decodeToPCM16, writeWavPCM16 } from "../../packages/audio";
import shell from "../infra/shell";
import { createCppInvocation, IFlagTypes } from "./whisper";
import { DiarizationOptions, applySpeakerTurns, resolveDiarizationBackend } from "./diarization";
import { IOptions, resolveOptions, warnIfNotTinydiarizeModel } from "../config/options";
import { AUDIO_CONSTANTS, STREAM_CONSTANTS } from "../config/constants";
import {
  ITranscriptLine,
  createTranscriptLineParser,
  looksLikeWordLevelTranscript,
  mergeWordLevelTranscript,
  msToTime,
  timeToMs,
} from "../utils/transcription";
import { ILanguageInfo, parseLanguageInfo } from "../utils/language";
import { ValidationError, WhisperNodeError, isWhisperNodeError } from "../utils/errors";
import { createLogger } from "../utils/logger";
import { makeTempDir } from "../utils/tempfiles";

const logger = createLogger("stream");

/**
 * File path, a single buffer, a Node Readable (without an encoding),
 * or any sync/async iterable of audio byte chunks.
 */
export type StreamSource = string | Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

type ChunkSource = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/** Chunking options shared by the CLI and server streaming modes. */
export interface IChunkingOptions {
  /**
   * Target chunk duration in seconds (default 30, range 2–600). Each chunk is cut at the
   * quietest 20 ms frame within its last 20 %, to avoid splitting words.
   */
  chunkSeconds?: number;
  /**
   * Input container/codec. Omit to let FFmpeg probe the bytes. Use `'pcm_s16le'` for raw
   * 16 kHz mono little-endian PCM16 (for example a microphone), which skips FFmpeg entirely.
   * Any other value is passed to FFmpeg as its `-f` input format.
   */
  inputFormat?: string;
  /**
   * When the language is `'auto'`, reuse the first detected language for later
   * chunks so they are decoded consistently. Default `true`.
   */
  lockLanguage?: boolean;
  /** Skip chunks that contain only digital silence instead of sending them to Whisper. Default `true`. */
  skipSilence?: boolean;
  /** Stop decoding and transcription when aborted. */
  signal?: AbortSignal;
}

export interface IStreamOptions extends IOptions, IChunkingOptions {}

/** Transcript line produced by `transcribeStream`, with timestamps relative to the stream start. */
export interface IStreamSegment extends ITranscriptLine {
  /** Zero-based index of the audio chunk that produced the line. */
  chunk: number;
  /** Language code whisper.cpp used for the chunk, when known. */
  language?: string;
}

/** Transcription of one chunk; lines use chunk-relative timestamps. */
export interface IChunkRun {
  lines: AsyncIterable<ITranscriptLine>;
  /** Language known so far; final once `lines` is exhausted. */
  language(): ILanguageInfo | undefined;
}

/** Turns PCM chunks into transcript lines (whisper-cli process, whisper-server request, ...). */
export interface IChunkBackend {
  transcribe(pcm: Buffer, index: number, whisperOptions: IFlagTypes, signal: AbortSignal): IChunkRun;
  dispose?(): void | Promise<void>;
}

const BYTES_PER_SECOND = AUDIO_CONSTANTS.SAMPLE_RATE * 2;
const FRAME_BYTES = (AUDIO_CONSTANTS.SAMPLE_RATE / 50) * 2; // 20 ms
/** whisper.cpp rejects input shorter than 100 ms. */
export const MIN_CHUNK_BYTES = BYTES_PER_SECOND / 10;
const SILENCE_RMS = 1e-4; // about -80 dBFS
const MAX_PENDING_CHUNKS = 2;

/** Mean square of PCM16 samples in `[start, end)`, normalized to [-1, 1] amplitude. */
function meanSquare(pcm: Buffer, start: number, end: number): number {
  let sum = 0;
  let count = 0;
  for (let offset = start; offset + 1 < end; offset += 2) {
    const sample = pcm.readInt16LE(offset) / AUDIO_CONSTANTS.PCM_SCALE_FACTOR;
    sum += sample * sample;
    count++;
  }
  return count ? sum / count : 0;
}

/**
 * Pick a split offset (in bytes, sample aligned) inside the last part of the chunk,
 * at the centre of the quietest 20 ms frame.
 */
export function findSplitOffset(pcm: Buffer, targetBytes: number): number {
  const searchBytes = Math.floor(targetBytes * STREAM_CONSTANTS.SPLIT_SEARCH_FRACTION);
  const first = Math.max(0, targetBytes - searchBytes);
  let best = targetBytes;
  let quietest = Infinity;
  for (let start = first - (first % FRAME_BYTES); start + FRAME_BYTES <= targetBytes; start += FRAME_BYTES) {
    const energy = meanSquare(pcm, start, start + FRAME_BYTES);
    if (energy < quietest) {
      quietest = energy;
      best = start + FRAME_BYTES / 2;
    }
  }
  return best - (best % 2);
}

export function isSilent(pcm: Buffer): boolean {
  for (let start = 0; start < pcm.length; start += FRAME_BYTES) {
    if (Math.sqrt(meanSquare(pcm, start, Math.min(pcm.length, start + FRAME_BYTES))) > SILENCE_RMS) return false;
  }
  return true;
}

function abortError(): WhisperNodeError {
  return new WhisperNodeError("Streaming transcription aborted", "ABORTED");
}

/** Bounded single-producer/single-consumer queue that applies backpressure to the producer. */
class ChunkQueue<T> {
  private items: T[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;
  private failure: unknown;

  constructor(private readonly limit: number) {}

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async put(item: T): Promise<void> {
    while (this.items.length >= this.limit && !this.closed) await new Promise<void>(resolve => this.waiters.push(resolve));
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  close(failure?: unknown): void {
    this.closed = true;
    this.failure ??= failure;
    this.wake();
  }

  async take(): Promise<T | undefined> {
    while (!this.items.length) {
      if (this.closed) {
        if (this.failure) throw this.failure;
        return undefined;
      }
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    const item = this.items.shift();
    this.wake();
    return item;
  }
}

/** Raw PCM16 byte source, either passed through or decoded by FFmpeg. */
function pcmSource(source: string | ChunkSource, options: IChunkingOptions): ChunkSource {
  if (options.inputFormat === "pcm_s16le") {
    return typeof source === "string" ? fs.createReadStream(source) : source;
  }
  return decodeToPCM16(source, { inputFormat: options.inputFormat, signal: options.signal });
}

/** Normalize the public source union, rejecting values that are not audio. */
function toChunkSource(source: StreamSource): string | ChunkSource {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return [source];
  const iterable = source as Partial<Iterable<Uint8Array> & AsyncIterable<Uint8Array>> | null;
  if (iterable && (typeof iterable[Symbol.asyncIterator] === "function" || typeof iterable[Symbol.iterator] === "function")) {
    return source as ChunkSource;
  }
  throw new ValidationError("Stream source must be a file path, a buffer, a Readable or an iterable of audio bytes");
}

/** Split the decoded PCM stream into chunks and feed them to the queue. */
async function produceChunks(
  source: ChunkSource,
  queue: ChunkQueue<Buffer>,
  chunkBytes: number,
  signal: AbortSignal,
): Promise<void> {
  let pending = Buffer.alloc(0);
  try {
    for await (const data of source) {
      if (signal.aborted) break;
      if (!(data instanceof Uint8Array)) {
        throw new ValidationError("Audio chunks must be Buffers or Uint8Arrays; do not set an encoding on the source stream");
      }
      // Copy once so chunks never alias a caller-owned buffer that may be reused.
      pending = Buffer.concat([pending, data]);
      let offset = 0;
      while (pending.length - offset >= chunkBytes) {
        const view = pending.subarray(offset);
        const split = findSplitOffset(view, chunkBytes);
        await queue.put(view.subarray(0, split));
        offset += split;
      }
      if (offset) pending = Buffer.from(pending.subarray(offset));
    }
    const remainder = pending.subarray(0, pending.length - (pending.length % 2));
    if (!signal.aborted && remainder.length >= MIN_CHUNK_BYTES) await queue.put(remainder);
    else if (remainder.length) logger.debug("Dropping trailing audio shorter than 100 ms", { bytes: remainder.length });
    queue.close();
  } catch (error) {
    queue.close(error);
  }
}

/** Validate chunking options shared by every streaming mode. */
export function validateChunking(options: IChunkingOptions): number {
  const chunkSeconds = options.chunkSeconds ?? STREAM_CONSTANTS.DEFAULT_CHUNK_SECONDS;
  if (!Number.isFinite(chunkSeconds) || chunkSeconds < STREAM_CONSTANTS.MIN_CHUNK_SECONDS || chunkSeconds > STREAM_CONSTANTS.MAX_CHUNK_SECONDS) {
    throw new ValidationError(`chunkSeconds must be between ${STREAM_CONSTANTS.MIN_CHUNK_SECONDS} and ${STREAM_CONSTANTS.MAX_CHUNK_SECONDS}`);
  }
  return chunkSeconds;
}

/**
 * Chunk an audio source and transcribe it with `backend`, yielding lines with stream-relative
 * timestamps. Handles silence skipping, language locking, word merging and tinydiarize turns.
 */
export async function* runChunkedStream(
  source: StreamSource,
  options: IChunkingOptions & { whisperOptions: IFlagTypes; diarization?: DiarizationOptions; backend: IChunkBackend },
): AsyncGenerator<IStreamSegment, void, undefined> {
  const input = toChunkSource(source);
  const chunkSeconds = validateChunking(options);
  const { backend, diarization } = options;
  const whisperOptions = { ...options.whisperOptions };
  const wordLevel = !!whisperOptions.word_timestamps;
  const lockLanguage = options.lockLanguage !== false;
  const turnState = { current: 0 };
  const label = (batch: ITranscriptLine[]) => (diarization ? applySpeakerTurns(batch, diarization, turnState) : batch);

  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  const chunkBytes = Math.floor(chunkSeconds * AUDIO_CONSTANTS.SAMPLE_RATE) * 2;
  const queue = new ChunkQueue<Buffer>(MAX_PENDING_CHUNKS);
  const producer = produceChunks(pcmSource(input, { ...options, signal: controller.signal }), queue, chunkBytes, controller.signal);
  logger.info("Starting streaming transcription", { chunkSeconds, inputFormat: options.inputFormat ?? "auto" });

  let chunkIndex = 0;
  let offsetBytes = 0;
  try {
    for (let pcm = await queue.take(); pcm; pcm = await queue.take()) {
      if (controller.signal.aborted) break;
      const index = chunkIndex++;
      const offsetMs = (offsetBytes / BYTES_PER_SECOND) * 1000;
      const durationMs = (pcm.length / BYTES_PER_SECOND) * 1000;
      offsetBytes += pcm.length;
      if (options.skipSilence !== false && isSilent(pcm)) {
        logger.debug("Skipping silent chunk", { chunk: index });
        continue;
      }

      const toStreamSegment = (line: ITranscriptLine, language?: string): IStreamSegment => {
        const start = Math.min(timeToMs(line.start), durationMs);
        const end = Math.min(Math.max(timeToMs(line.end), start), durationMs);
        return {
          ...line,
          start: msToTime(Math.round(offsetMs + start)),
          end: msToTime(Math.round(offsetMs + end)),
          chunk: index,
          ...(language ? { language } : {}),
        };
      };

      const run = backend.transcribe(pcm, index, { ...whisperOptions }, controller.signal);
      const words: ITranscriptLine[] = [];
      for await (const line of run.lines) {
        if (wordLevel) words.push(line);
        else for (const labeled of label([line])) yield toStreamSegment(labeled, run.language()?.code);
      }
      const language = run.language();
      if (wordLevel) {
        let batch = label(words);
        if (looksLikeWordLevelTranscript(batch)) batch = mergeWordLevelTranscript(batch);
        for (const line of batch) yield toStreamSegment(line, language?.code);
      }
      if (language) logger.debug("Chunk language", { chunk: index, ...language });
      if (lockLanguage && language?.detected && whisperOptions.language === "auto") {
        whisperOptions.language = language.code;
        logger.info("Locked stream language", language);
      }
    }
    if (options.signal?.aborted) throw abortError();
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    if (isWhisperNodeError(error)) throw error;
    throw new WhisperNodeError(`Streaming transcription failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    controller.abort();
    queue.close();
    options.signal?.removeEventListener("abort", abort);
    // A live source may never produce again, so the producer is not awaited here.
    producer.catch(() => {});
    await backend.dispose?.();
    logger.info("Streaming transcription finished", { chunks: chunkIndex });
  }
}

/** Runs one whisper-cli process per chunk, streaming stdout lines as they are printed. */
function cliBackend(effective: IOptions, tinydiarize: boolean): IChunkBackend {
  let tmpDir: string | undefined;
  return {
    transcribe(pcm, index, whisperOptions, outerSignal) {
      let stderr = "";
      const language = () => parseLanguageInfo(stderr, whisperOptions.language);
      async function* lines(): AsyncGenerator<ITranscriptLine> {
        tmpDir ??= makeTempDir("wh-stream");
        const wavPath = path.join(tmpDir, `chunk-${index}.wav`);
        writeWavPCM16(wavPath, pcm);
        // Stops the process when the consumer leaves early, without waiting for the chunk to finish.
        const local = new AbortController();
        const forward = () => local.abort(outerSignal.reason);
        if (outerSignal.aborted) forward();
        outerSignal.addEventListener("abort", forward, { once: true });
        const buffered: ITranscriptLine[] = [];
        let notify: (() => void) | undefined;
        let finished = false;
        let failure: unknown;
        let run: Promise<void> | undefined;
        try {
          const command = await createCppInvocation({
            filePath: wavPath,
            modelName: effective.modelName,
            modelPath: effective.modelPath,
            options: whisperOptions,
            extraArgs: tinydiarize ? ["-tdrz"] : [],
          });
          const wordLevel = !!whisperOptions.word_timestamps;
          const parser = createTranscriptLineParser(line => { buffered.push(line); notify?.(); });
          // whisper.cpp logs the effective/detected language before printing segments.
          run = shell(command, effective.shellOptions, {
            onStdout: wordLevel ? undefined : parser.push,
            onStderr: chunk => { if (stderr.length < 64 * 1024) stderr += chunk; },
            signal: local.signal,
          }).then(
            output => {
              stderr = output.stderr;
              if (wordLevel) parser.push(output.stdout + "\n");
              parser.flush();
            },
            error => { failure = error; },
          ).finally(() => { finished = true; notify?.(); });
          while (true) {
            if (buffered.length) {
              yield* buffered.splice(0);
              continue;
            }
            if (finished) break;
            await new Promise<void>(resolve => { notify = resolve; });
            notify = undefined;
          }
          if (failure) throw failure;
        } finally {
          outerSignal.removeEventListener("abort", forward);
          if (!finished) local.abort();
          // Wait for the process so its WAV is no longer open when removed.
          await run;
          fs.rmSync(wavPath, { force: true });
        }
      }
      return { lines: lines(), language };
    },
    dispose() {
      if (!tmpDir) return;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        logger.warn("Failed to remove temporary stream directory", { tmpDir, error });
      }
    },
  };
}

/**
 * Transcribe an audio stream incrementally.
 *
 * Audio is decoded to 16 kHz mono PCM, cut into chunks at quiet points and transcribed chunk by
 * chunk. Lines are yielded as whisper.cpp prints them, with timestamps offset to the start of the
 * stream. Breaking out of the loop or aborting `signal` stops decoding and the native process.
 *
 * Each chunk starts a whisper-cli process that loads the model again. For live dictation use
 * `createWhisperServer(...).transcribeStream`, which keeps the model loaded.
 *
 * Diarization supports only the `tinydiarize` backend, whose turn state carries across chunks.
 */
export async function* transcribeStream(
  source: StreamSource,
  options: IStreamOptions = {},
): AsyncGenerator<IStreamSegment, void, undefined> {
  validateChunking(options);
  const effective = resolveOptions(options);
  const diarize = effective.diarization;
  const backend = diarize?.enabled ? resolveDiarizationBackend(diarize) : undefined;
  if (backend && backend !== "tinydiarize") {
    throw new ValidationError("Streaming transcription supports only the tinydiarize diarization backend");
  }
  if (backend) warnIfNotTinydiarizeModel(effective);
  yield* runChunkedStream(source, {
    ...options,
    whisperOptions: effective.whisperOptions || {},
    diarization: backend ? diarize : undefined,
    backend: cliBackend(effective, !!backend),
  });
}
