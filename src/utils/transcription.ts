/**
 * A single transcript record with start/end timestamps and text.
 */
export type ITranscriptLine = {
  start: string;
  end: string;
  speech: string;
  speaker?: string;
};

/**
 * Parse whisper.cpp VTT-like console output into structured transcript lines.
 * Lines are expected in the form: "[HH:MM:SS.mmm --> HH:MM:SS.mmm]  text".
 * Returns an empty array for empty or unmatched input.
 */
export default function parseTranscript(vtt: string): ITranscriptLine[] {
  if (!vtt) return [];

  const matches = vtt.match(/\[[0-9:.]+\s-->\s[0-9:.]+\][^\n]*/g) || [];

  const results: ITranscriptLine[] = [];
  for (const raw of matches) {
    const line = raw.trim();
    const m = line.match(/^\[([0-9:.]+)\s-->\s([0-9:.]+)\]\s+(.*)$/);
    if (!m) continue;

    const start = m[1];
    const end = m[2];
    const speech = m[3].replace(/\r?\n/g, "").trimStart();

    results.push({ start, end, speech });
  }

  return results;
}


/**
 * Heuristic: does the transcript look like it is split per word?
 */
export function looksLikeWordLevelTranscript(lines: ITranscriptLine[]): boolean {
  if (!lines || lines.length < 4) return false;
  let wordLike = 0;
  for (const l of lines) {
    if (!/\s/.test(l.speech)) wordLike++;
  }
  return wordLike / lines.length > 0.8; // mostly single tokens
}

function pad2(n: number): string {
  return n < 10 ? "0" + String(n) : String(n);
}

function pad3(n: number): string {
  if (n < 10) return "00" + String(n);
  if (n < 100) return "0" + String(n);
  return String(n);
}

function timeToMs(t: string): number {
  const parts = t.split(":");
  if (parts.length !== 3) return 0;
  const hours = Number(parts[0]) || 0;
  const minutes = Number(parts[1]) || 0;
  const seconds = Number(parts[2]) || 0; // supports SS.mmm
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return Math.round(totalSeconds * 1000);
}

function msToTime(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const milli = ms - totalSeconds * 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad3(Math.round(milli))}`;
}

function isPunctuation(token: string): boolean {
  if (!token) return false;
  // Common punctuation tokens as emitted by whisper.cpp with word timestamps
  return /^[.,!?;:\-–—…()\[\]{}"'`]+$/.test(token);
}

function isEndSentencePunct(token: string): boolean {
  return /[.!?]$/.test(token);
}

export type MergeOptions = {
  maxGapMs?: number; // pause threshold to break sentence
  maxCharsPerSegment?: number; // soft cap on segment size
};

/**
 * Merge per-word ITranscriptLine entries into sentence/segment-level entries
 * using simple punctuation and pause heuristics.
 */
export function mergeWordLevelTranscript(
  lines: ITranscriptLine[],
  opts?: MergeOptions,
): ITranscriptLine[] {
  if (!lines || lines.length === 0) return [];

  const maxGapMs = opts?.maxGapMs ?? 600; // 0.6s pause => break
  const maxChars = opts?.maxCharsPerSegment ?? 320;

  const merged: ITranscriptLine[] = [];
  let buffer: string[] = [];
  let segStartMs: number | null = null;
  let segEndMs: number | null = null;
  let currentSpeaker: string | undefined = undefined;

  const flush = () => {
    if (buffer.length === 0 || segStartMs === null || segEndMs === null) return;
    const text = buffer.join("");
    const item: ITranscriptLine = {
      start: msToTime(segStartMs),
      end: msToTime(segEndMs),
      speech: text.trim(),
    };
    if (currentSpeaker) item.speaker = currentSpeaker;
    merged.push(item);
    buffer = [];
    segStartMs = null;
    segEndMs = null;
    currentSpeaker = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const next = lines[i + 1];

    const curStart = timeToMs(cur.start);
    const curEnd = timeToMs(cur.end);

    if (segStartMs === null) segStartMs = curStart;
    segEndMs = curEnd;
    if (!currentSpeaker && cur.speaker) currentSpeaker = cur.speaker;

    const token = cur.speech;

    if (buffer.length === 0) {
      buffer.push(token);
    } else {
      if (isPunctuation(token)) {
        buffer.push(token);
      } else {
        const prev = buffer[buffer.length - 1];
        if (prev && isPunctuation(prev)) buffer.push(" " + token);
        else buffer.push(" " + token);
      }
    }

    const reachedMaxChars = buffer.join("").length >= maxChars;
    const endedWithEOS = isEndSentencePunct(token);

    let gapBreak = false;
    if (next) {
      const nextStart = timeToMs(next.start);
      const gap = nextStart - curEnd;
      gapBreak = gap > maxGapMs;
    }

    if (endedWithEOS || gapBreak || reachedMaxChars || !next) {
      flush();
    }
  }

  return merged;
}


