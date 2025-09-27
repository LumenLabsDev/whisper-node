/**
 * A single transcript record with start/end timestamps and text.
 */
export type ITranscriptLine = {
  start: string;
  end: string;
  speech: string;
};

/**
 * Parse whisper.cpp VTT-like console output into structured transcript lines.
 * Lines are expected in the form: "[HH:MM:SS.mmm --> HH:MM:SS.mmm]  text".
 * Returns an empty array for empty or unmatched input.
 */
export default function parseTranscript(vtt: string): ITranscriptLine[] {
  if (!vtt) return [];

  // Capture lines like: "[00:03:04.000 --> 00:03:13.000]   text..."
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


