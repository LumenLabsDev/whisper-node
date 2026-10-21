/**
 * Spoken-language metadata reported by whisper.cpp for a transcription.
 */
export type ILanguageInfo = {
  /** ISO 639 code used for decoding, such as `en` or `pt`. */
  code: string;
  /** Detection probability between 0 and 1. Present only when the language was auto-detected. */
  probability?: number;
  /** `true` when whisper.cpp detected the language; `false` when it was requested or forced. */
  detected: boolean;
};

const AUTO_DETECTED = /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([0-9.]+)\)/i;
const PROCESSING_LANG = /\blang\s*=\s*([a-z]{2,3}|auto)\s*,/i;

/**
 * Extract language metadata from native diagnostic output (stderr).
 *
 * whisper.cpp logs `auto-detected language: xx (p = 0.97)` when detecting,
 * and `lang = xx` on its "processing" line for the effective language.
 * Falls back to the requested language when native output has neither.
 */
export function parseLanguageInfo(stderr: string, requested?: string): ILanguageInfo | undefined {
  const detected = AUTO_DETECTED.exec(stderr || "");
  if (detected) {
    const probability = Number(detected[2]);
    return {
      code: detected[1].toLowerCase(),
      detected: true,
      ...(Number.isFinite(probability) ? { probability } : {}),
    };
  }
  const effective = PROCESSING_LANG.exec(stderr || "")?.[1]?.toLowerCase();
  if (effective && effective !== "auto") return { code: effective, detected: false };
  const fallback = requested?.trim().toLowerCase();
  if (fallback && fallback !== "auto") return { code: fallback, detected: false };
  return undefined;
}
