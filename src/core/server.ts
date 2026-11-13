import { ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { encodeWavPCM16 } from "../../packages/audio";
import { findNativeProgram, isMissingDllExit, missingRuntimeError } from "../infra/native";
import { IFlagTypes, getFlags, modelPathOrName, validatePrompt, validateThreads } from "./whisper";
import { IChunkingOptions, IStreamSegment, MIN_CHUNK_BYTES, StreamSource, runChunkedStream, validateChunking } from "./stream";
import { ITranscriptLine, msToTime } from "../utils/transcription";
import { ILanguageInfo } from "../utils/language";
import { ModelNotFoundError, ValidationError, WhisperNodeError } from "../utils/errors";
import { createLogger } from "../utils/logger";
import { cleanupTempFilesOnce } from "../utils/tempfiles";
import { loadConfig } from "../config/config";

const logger = createLogger("server");

/** Options for `createWhisperServer`. */
export interface IWhisperServerOptions {
  /** Model name resolved in the models directory, as for `whisper()`. */
  modelName?: string;
  /** Absolute path to a ggml model file. Mutually exclusive with `modelName`. */
  modelPath?: string;
  /** Default spoken language, such as `'pt'`, or `'auto'`. Default `'en'`, as whisper.cpp. */
  language?: string;
  /** CPU threads used by whisper.cpp (`-t`). Default: whisper.cpp's min(4, cores). */
  threads?: number;
  /** Default initial prompt (`--prompt`); a request can override it. */
  prompt?: string;
  /**
   * Beam search width (`-bs`, with the same `-bo` best-of). Default: whisper-server's greedy decoding.
   * `whisper-cli` uses 5; set 5 for the same decoding, at some extra latency.
   */
  beamSize?: number;
  /** Loopback port. Default: a free port chosen at each start. */
  port?: number;
  /** Stop the native process after this many idle milliseconds; it restarts on the next request. `0` (default) keeps it running. */
  idleTimeoutMs?: number;
  /** Maximum time to wait for the model to load. Default 60 000 ms. */
  startupTimeoutMs?: number;
  /** Maximum time for one transcription request. Default 120 000 ms. */
  requestTimeoutMs?: number;
  /** Restart the native process when it exits unexpectedly. Default `true`. */
  autoRestart?: boolean;
  /** Consecutive failed restarts before automatic restarts stop (requests still try once). Default 5. */
  maxRestarts?: number;
  /** Absolute path to a custom `whisper-server` executable. Default: the configured native root. */
  executable?: string;
  /** @internal Test hook: program and leading arguments used to launch the server. */
  launcher?: { file: string; args?: string[] };
}

/** Per-request options for `transcribePCM`. */
export interface ITranscribePCMOptions {
  /** Override the server language for this request. */
  language?: string;
  /** Override the server prompt for this request. An empty string sends no prompt. */
  prompt?: string;
  /** Split output per word, then merge into sentences (as `word_timestamps` in `whisper()`). */
  word_timestamps?: boolean;
  /** Maximum segment length in characters (`max_len`). */
  timestamp_size?: number;
  /** Added to every timestamp, for callers that keep their own stream position. */
  offsetMs?: number;
  signal?: AbortSignal;
}

/** Options for `server.transcribeStream`. Chunks are sent over HTTP; nothing is written to disk. */
export interface IServerStreamOptions extends IChunkingOptions {
  /** Language for this stream; `'auto'` detects it on the first chunk and keeps it when `lockLanguage` is on. */
  language?: string;
  prompt?: string;
  word_timestamps?: boolean;
}

export interface IServerTranscription {
  transcript: ITranscriptLine[];
  language?: ILanguageInfo;
}

export interface IWhisperServer {
  /** Port of the running process, or `undefined` while stopped. */
  readonly port: number | undefined;
  /** Process id of the running process, or `undefined` while stopped. */
  readonly pid: number | undefined;
  readonly running: boolean;
  /** Number of times the process was started after the first start (crash, idle or restart). */
  readonly restarts: number;
  /** Start the process (if needed) and wait until the model is loaded. */
  start(): Promise<void>;
  /**
   * Transcribe 16 kHz mono audio held in memory: PCM16 little-endian bytes (`Buffer`/`Uint8Array`),
   * `Int16Array` samples or `Float32Array` samples in [-1, 1].
   */
  transcribePCM(pcm: Uint8Array | Int16Array | Float32Array, options?: ITranscribePCMOptions): Promise<IServerTranscription>;
  /** Chunked streaming like `transcribeStream`, without starting a process or writing files per chunk. */
  transcribeStream(source: StreamSource, options?: IServerStreamOptions): AsyncGenerator<IStreamSegment, void, undefined>;
  /** Stop the process. Further calls reject. */
  close(): Promise<void>;
}

interface Instance {
  child: ChildProcess;
  port: number;
  token: string;
  exited: Promise<void>;
  intentional: boolean;
}

/** Children still running, killed if the host process exits without calling close(). */
const live = new Set<ChildProcess>();
let exitHook = false;
function track(child: ChildProcess): void {
  live.add(child);
  child.once("exit", () => live.delete(child));
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => { for (const item of live) item.kill(); });
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function validateLanguage(language: unknown): void {
  if (language != null && (typeof language !== "string" || !/^(auto|[a-z]{2,3})$/i.test(language))) {
    throw new ValidationError("language must be 'auto' or an ISO 639 code such as 'pt'");
  }
}

function positiveInteger(name: string, value: unknown, allowZero = false): void {
  if (value == null) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ValidationError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
}

/** Convert supported sample containers to little-endian PCM16 bytes. */
export function toPCM16Bytes(pcm: Uint8Array | Int16Array | Float32Array): Buffer {
  if (pcm instanceof Float32Array) {
    const out = Buffer.allocUnsafe(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) {
      const value = Math.max(-1, Math.min(1, pcm[i] || 0));
      out.writeInt16LE(value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), i * 2);
    }
    return out;
  }
  if (pcm instanceof Int16Array) {
    const out = Buffer.allocUnsafe(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], i * 2);
    return out;
  }
  if (pcm instanceof Uint8Array) {
    if (pcm.byteLength % 2) throw new ValidationError("PCM16 data must contain whole 16-bit samples");
    return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  }
  throw new ValidationError("pcm must be a Buffer, Uint8Array, Int16Array or Float32Array");
}

function multipart(fields: Record<string, string>, wav: Buffer): { body: Buffer; boundary: string } {
  let boundary: string;
  do boundary = `----whisper-node-${randomBytes(16).toString("hex")}`;
  while (Object.values(fields).some(value => value.includes(boundary)));
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(wav, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

const CONNECTION_ERRORS = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ECONNABORTED", "ERR_STREAM_PREMATURE_CLOSE"]);

class WhisperServer implements IWhisperServer {
  private instance?: Instance;
  private starting?: Promise<Instance>;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private active = 0;
  private idleTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private failures = 0;
  private starts = 0;
  private stderrTail = "";
  private readonly agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  constructor(private readonly options: IWhisperServerOptions) {}

  get port() { return this.instance?.port; }
  get pid() { return this.instance?.child.pid; }
  get running() { return !!this.instance; }
  get restarts() { return Math.max(0, this.starts - 1); }

  async start(): Promise<void> {
    await this.ensure();
  }

  private ensure(): Promise<Instance> {
    if (this.closed) return Promise.reject(new WhisperNodeError("Whisper server is closed", "SERVER_CLOSED"));
    if (this.instance) return Promise.resolve(this.instance);
    this.starting ??= this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async launch(): Promise<Instance> {
    clearTimeout(this.restartTimer);
    const options = this.options;
    const model = modelPathOrName(options.modelName, options.modelPath);
    if (!existsSync(model)) throw new ModelNotFoundError(model);
    const native = options.launcher
      ? { binary: options.launcher.file, cwd: undefined }
      : options.executable
        ? { binary: options.executable, cwd: path.dirname(options.executable) }
        : await findNativeProgram("server");
    const attempts = options.port ? 1 : 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.closed) break;
      const port = options.port ?? await freePort();
      // A random request path makes every route unguessable to other local programs and web pages,
      // and proves that the process answering on the port is ours.
      const token = randomBytes(16).toString("hex");
      const args = [
        ...(options.launcher?.args ?? []),
        "-m", model,
        "--host", "127.0.0.1",
        "--port", String(port),
        "--request-path", `/${token}`,
        "-l", options.language ?? "en",
        ...getFlags({ threads: options.threads }),
        ...(options.prompt ? ["--prompt", options.prompt] : []),
        ...(options.beamSize ? ["-bs", String(options.beamSize), "-bo", String(options.beamSize)] : []),
      ];
      this.stderrTail = "";
      const child = spawn(native.binary, args, {
        cwd: native.cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
      const keepTail = (chunk: Buffer) => { this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8192); };
      child.stdout?.on("data", keepTail);
      child.stderr?.on("data", keepTail);
      let exitCode: number | null | undefined;
      let spawnError: Error | undefined;
      const exited = new Promise<void>(resolve => {
        child.once("error", error => { spawnError = error; exitCode ??= -1; resolve(); });
        child.once("exit", code => { exitCode = code; resolve(); });
      });
      if (child.pid) track(child);
      const instance: Instance = { child, port, token, exited, intentional: false };
      try {
        await this.waitReady(instance, () => exitCode);
      } catch (error) {
        instance.intentional = true;
        child.kill();
        await exited;
        if (spawnError) throw new WhisperNodeError(`Failed to start whisper-server (${native.binary}): ${spawnError.message}`, "SERVER_START_FAILED");
        if (isMissingDllExit(exitCode)) throw missingRuntimeError(native.cwd ?? path.dirname(native.binary));
        lastError = error;
        if ((error as WhisperNodeError).code === "SERVER_PORT_CONFLICT") continue;
        throw error;
      }
      exited.then(() => this.onExit(instance));
      this.instance = instance;
      this.starts++;
      logger.info("Whisper server ready", { port, pid: child.pid, model });
      this.scheduleIdle();
      return instance;
    }
    throw lastError ?? new WhisperNodeError("Whisper server is closed", "SERVER_CLOSED");
  }

  private async waitReady(instance: Instance, exitCode: () => number | null | undefined): Promise<void> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 60_000);
    let wait = 25;
    let foreign = 0;
    while (Date.now() < deadline) {
      if (this.closed) throw new WhisperNodeError("Whisper server is closed", "SERVER_CLOSED");
      if (exitCode() !== undefined) {
        throw new WhisperNodeError(`whisper-server exited during startup (${exitCode()}): ${this.stderrTail.trim().split("\n").slice(-3).join(" ")}`, "SERVER_START_FAILED");
      }
      const status = await this.get(instance, "/health").catch(() => 0);
      if (status === 200) return;
      // Something else answers on this port: the request path is unknown to it.
      if (status === 404 && ++foreign >= 3) throw new WhisperNodeError("Another program is using the server port", "SERVER_PORT_CONFLICT");
      await Promise.race([delay(wait), instance.exited]);
      wait = Math.min(250, wait * 2);
    }
    throw new WhisperNodeError(`whisper-server did not become ready within ${this.options.startupTimeoutMs ?? 60_000} ms`, "SERVER_START_TIMEOUT");
  }

  private get(instance: Instance, route: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: instance.port, path: `/${instance.token}${route}`, agent: false, timeout: 2000 }, response => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.once("timeout", () => request.destroy(new Error("timeout")));
      request.once("error", reject);
    });
  }

  private onExit(instance: Instance): void {
    if (this.instance === instance) this.instance = undefined;
    if (instance.intentional || this.closed) return;
    logger.warn("whisper-server exited unexpectedly", { pid: instance.child.pid, output: this.stderrTail.slice(-500) });
    this.scheduleRestart();
  }

  /**
   * Restart with exponential backoff. `failures` resets only after a successful request, so a
   * process that loads and then crashes repeatedly also stops after `maxRestarts` attempts.
   */
  private scheduleRestart(): void {
    if (this.closed || this.options.autoRestart === false) return;
    if (this.failures >= (this.options.maxRestarts ?? 5)) {
      logger.error("whisper-server keeps failing; automatic restarts stopped until the next request", { failures: this.failures });
      return;
    }
    const backoff = Math.min(30_000, 250 * 2 ** this.failures);
    this.failures++;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (this.closed || this.instance || this.starting) return;
      this.ensure().catch(error => {
        logger.error("Failed to restart whisper-server", { error: error instanceof Error ? error.message : error, failures: this.failures });
        this.scheduleRestart();
      });
    }, backoff);
    this.restartTimer.unref();
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer);
    const ms = this.options.idleTimeoutMs ?? 0;
    if (!ms || this.active || !this.instance) return;
    this.idleTimer = setTimeout(() => {
      if (!this.active) this.stop("idle").catch(() => {});
    }, ms);
    this.idleTimer.unref();
  }

  private async stop(reason: string): Promise<void> {
    const instance = this.instance;
    if (!instance) return;
    instance.intentional = true;
    this.instance = undefined;
    logger.info("Stopping whisper-server", { reason, pid: instance.child.pid });
    instance.child.kill();
    await Promise.race([instance.exited, delay(5000)]);
  }

  private post(instance: Instance, body: Buffer, boundary: string, signal: AbortSignal, json: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: instance.port,
        path: `/${instance.token}/inference`,
        method: "POST",
        agent: this.agent,
        signal,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length },
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200) {
            return reject(new WhisperNodeError(`whisper-server returned ${response.statusCode}: ${text.slice(0, 300)}`, "SERVER_REQUEST_FAILED"));
          }
          // Errors are JSON even when a text format was requested.
          if (!json && !text.trimStart().startsWith("{")) return resolve(text);
          try {
            const json = JSON.parse(text);
            if (json && typeof json === "object" && "error" in json) {
              return reject(new WhisperNodeError(`whisper-server error: ${String(json.error)}`, "SERVER_REQUEST_FAILED"));
            }
            resolve(json);
          } catch {
            reject(new WhisperNodeError(`whisper-server returned invalid JSON: ${text.slice(0, 300)}`, "SERVER_REQUEST_FAILED"));
          }
        });
      });
      request.once("error", reject);
      request.end(body);
    });
  }

  /** Serialize requests: whisper-server decodes one at a time, and timeouts should not count queue time. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async transcribePCM(pcm: Uint8Array | Int16Array | Float32Array, options: ITranscribePCMOptions = {}): Promise<IServerTranscription> {
    validateLanguage(options.language);
    validatePrompt(options.prompt);
    positiveInteger("timestamp_size", options.timestamp_size, true);
    if (options.offsetMs != null && (!Number.isFinite(options.offsetMs) || options.offsetMs < 0)) {
      throw new ValidationError("offsetMs must be a non-negative number");
    }
    if (options.word_timestamps && options.timestamp_size != null) throw new ValidationError("Use timestamp_size OR word_timestamps, not both");
    const bytes = toPCM16Bytes(pcm);
    const language = (options.language ?? this.options.language ?? "en").toLowerCase();
    if (this.closed) throw new WhisperNodeError("Whisper server is closed", "SERVER_CLOSED");
    if (bytes.length < MIN_CHUNK_BYTES) return { transcript: [] };

    // verbose_json adds per-word timing work (about +90 % per request in our measurements), but it is
    // the only format that reports the detected language. VTT keeps segment timestamps at plain-JSON cost.
    const format = language === "auto" ? "verbose_json" : "vtt";
    const fields: Record<string, string> = { response_format: format, language };
    const prompt = options.prompt ?? this.options.prompt;
    if (prompt) fields.prompt = prompt;
    if (options.word_timestamps) fields.max_len = "1";
    else if (options.timestamp_size != null) fields.max_len = String(options.timestamp_size);
    const { body, boundary } = multipart(fields, encodeWavPCM16(bytes));

    const response = await this.enqueue(async () => {
      options.signal?.throwIfAborted();
      clearTimeout(this.idleTimer);
      this.active++;
      try {
        for (let attempt = 0; ; attempt++) {
          const instance = await this.ensure();
          const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? 120_000);
          const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
          try {
            const result = await this.post(instance, body, boundary, signal, format === "verbose_json");
            this.failures = 0;
            return result;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? "";
            if (attempt > 0 || !CONNECTION_ERRORS.has(code) || signal.aborted || this.closed) throw error;
            // The process died under the request: wait for its exit, then retry once on a fresh process.
            await Promise.race([instance.exited, delay(2000)]);
            if (this.instance === instance && instance.child.exitCode === null) throw error;
            if (this.instance === instance) this.instance = undefined;
            logger.warn("Retrying request after whisper-server exit", { code });
          }
        }
      } finally {
        this.active--;
        this.scheduleIdle();
      }
    });
    const json: VerboseJson = typeof response === "string" ? { segments: parseVtt(response) } : response as VerboseJson;

    const offset = options.offsetMs ?? 0;
    // whisper.cpp pads input to 30 s, so the last segment can end after the audio does.
    const durationMs = (bytes.length / 2 / 16000) * 1000;
    const clamp = (seconds: unknown) => Math.min(Math.max(Number(seconds) * 1000 || 0, 0), durationMs);
    const transcript: ITranscriptLine[] = (json.segments ?? []).map(segment => {
      const start = clamp(segment.start);
      return {
        start: msToTime(Math.round(offset + start)),
        end: msToTime(Math.round(offset + Math.max(start, clamp(segment.end)))),
        speech: String(segment.text ?? "").trim(),
      };
    }).filter(line => line.speech);
    const info = languageInfo(json, language);
    return { transcript, ...(info ? { language: info } : {}) };
  }

  transcribeStream(source: StreamSource, options: IServerStreamOptions = {}): AsyncGenerator<IStreamSegment, void, undefined> {
    validateChunking(options);
    validateLanguage(options.language);
    validatePrompt(options.prompt);
    const server = this;
    const whisperOptions: IFlagTypes = {
      language: options.language ?? this.options.language ?? "en",
      ...(options.prompt != null ? { prompt: options.prompt } : {}),
      ...(options.word_timestamps ? { word_timestamps: true } : {}),
    };
    return runChunkedStream(source, {
      ...options,
      whisperOptions,
      backend: {
        transcribe(pcm, _index, flags, signal) {
          let language: ILanguageInfo | undefined;
          async function* lines() {
            const result = await server.transcribePCM(pcm, {
              language: flags.language, prompt: flags.prompt, word_timestamps: flags.word_timestamps, signal,
            });
            language = result.language;
            yield* result.transcript;
          }
          return { lines: lines(), language: () => language };
        },
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.restartTimer);
    await this.starting?.catch(() => {});
    await this.stop("close");
    this.agent.destroy();
  }
}

interface VerboseJson {
  language?: string;
  detected_language_probability?: number;
  language_probabilities?: Record<string, number>;
  segments?: { start: number; end: number; text: string }[];
}

const VTT_CUE = /(\d+):(\d{2}):(\d{2})\.(\d{3}) --> (\d+):(\d{2}):(\d{2})\.(\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|\s*$)/g;

/** Parse whisper-server WebVTT output into segments in seconds. */
export function parseVtt(vtt: string): { start: number; end: number; text: string }[] {
  const seconds = (h: string, m: string, s: string, ms: string) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const segments: { start: number; end: number; text: string }[] = [];
  for (const match of vtt.replace(/\r\n/g, "\n").matchAll(VTT_CUE)) {
    segments.push({
      start: seconds(match[1], match[2], match[3], match[4]),
      end: seconds(match[5], match[6], match[7], match[8]),
      text: match[9].replace(/\n/g, " "),
    });
  }
  return segments;
}

/** whisper-server reports language names; detection also reports probabilities keyed by ISO code. */
function languageInfo(json: VerboseJson, requested: string): ILanguageInfo | undefined {
  if (requested !== "auto") return { code: requested, detected: false };
  const ranked = Object.entries(json.language_probabilities ?? {}).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return undefined;
  const probability = json.detected_language_probability ?? ranked[0][1];
  return { code: ranked[0][0].toLowerCase(), detected: true, ...(Number.isFinite(probability) ? { probability } : {}) };
}

/**
 * Start a persistent `whisper-server` on 127.0.0.1 that keeps the model loaded between requests,
 * for live dictation. Audio is sent from memory over HTTP; no audio is written to disk.
 * Resolves once the model is loaded. Call `close()` when done.
 */
export async function createWhisperServer(options: IWhisperServerOptions = {}): Promise<IWhisperServer> {
  if (!options || typeof options !== "object") throw new ValidationError("createWhisperServer expects an options object");
  const config = loadConfig();
  const resolved: IWhisperServerOptions = {
    ...options,
    modelName: options.modelName ?? (options.modelPath ? undefined : config.modelName),
    modelPath: options.modelPath ?? (options.modelName ? undefined : config.modelPath),
  };
  validateLanguage(resolved.language);
  validateThreads(resolved.threads);
  validatePrompt(resolved.prompt);
  positiveInteger("beamSize", resolved.beamSize);
  if (resolved.beamSize != null && resolved.beamSize > 16) throw new ValidationError("beamSize must be at most 16");
  if (resolved.port != null && (!Number.isInteger(resolved.port) || resolved.port < 1 || resolved.port > 65535)) {
    throw new ValidationError("port must be an integer between 1 and 65535");
  }
  positiveInteger("idleTimeoutMs", resolved.idleTimeoutMs, true);
  positiveInteger("startupTimeoutMs", resolved.startupTimeoutMs);
  positiveInteger("requestTimeoutMs", resolved.requestTimeoutMs);
  positiveInteger("maxRestarts", resolved.maxRestarts, true);
  if (resolved.executable != null && (typeof resolved.executable !== "string" || !path.isAbsolute(resolved.executable))) {
    throw new ValidationError("executable must be an absolute path");
  }
  // Server mode writes no audio, but startup is where stale chunks from crashed CLI streams are purged.
  cleanupTempFilesOnce();
  const server = new WhisperServer(resolved);
  await server.start();
  return server;
}
