import { AUDIO_CONSTANTS, SPECTRAL_CONSTANTS } from "../config/constants";

/**
 * Lightweight MFCC extraction for speaker embeddings. Pure TypeScript, no native dependencies.
 */

type MelBank = { start: number; peak: number; end: number }[];

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

function createMelBank(filters: number, fftSize: number, sampleRate: number): MelBank {
  const maxMel = hzToMel(sampleRate / 2);
  const points: number[] = [];
  for (let i = 0; i < filters + 2; i++) {
    const hz = melToHz((maxMel * i) / (filters + 1));
    points.push(Math.floor(((fftSize + 1) * hz) / sampleRate));
  }
  const bank: MelBank = [];
  for (let i = 0; i < filters; i++) bank.push({ start: points[i], peak: points[i + 1], end: points[i + 2] });
  return bank;
}

/** In-place iterative radix-2 FFT over separate real/imaginary arrays. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/**
 * Compute MFCCs (without the energy coefficient c0) for frames that start every `hopMs`.
 * Frame `i` starts at sample `i * hop`, matching `computeFrameEnergies` for the same hop.
 */
export function computeMfcc(
  pcm: Float32Array,
  sampleRate: number = AUDIO_CONSTANTS.SAMPLE_RATE,
  hopMs: number = 20,
): Float64Array[] {
  const hop = Math.floor((sampleRate * hopMs) / 1000);
  if (!Number.isFinite(sampleRate) || !Number.isFinite(hopMs) || sampleRate <= 0 || hop < 1) {
    throw new Error("sampleRate and frameMs must produce a positive frame size");
  }
  const { FFT_SIZE, MEL_FILTERS, COEFFICIENTS, WINDOW_MS } = SPECTRAL_CONSTANTS;
  const windowSize = Math.min(FFT_SIZE, Math.max(hop, Math.floor((sampleRate * WINDOW_MS) / 1000)));
  const hann = new Float64Array(windowSize);
  for (let i = 0; i < windowSize; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (windowSize - 1 || 1));
  const bank = createMelBank(MEL_FILTERS, FFT_SIZE, sampleRate);
  const dct: Float64Array[] = [];
  for (let c = 1; c <= COEFFICIENTS; c++) {
    const row = new Float64Array(MEL_FILTERS);
    for (let m = 0; m < MEL_FILTERS; m++) row[m] = Math.cos((Math.PI * c * (m + 0.5)) / MEL_FILTERS);
    dct.push(row);
  }

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const power = new Float64Array(FFT_SIZE / 2 + 1);
  const mel = new Float64Array(MEL_FILTERS);
  const result: Float64Array[] = [];
  // Frame count matches computeFrameEnergies so indices line up.
  for (let offset = 0; offset + hop <= pcm.length; offset += hop) {
    re.fill(0);
    im.fill(0);
    let previous = offset > 0 ? pcm[offset - 1] : 0;
    for (let i = 0; i < windowSize && offset + i < pcm.length; i++) {
      const sample = pcm[offset + i];
      re[i] = (sample - 0.97 * previous) * hann[i]; // pre-emphasis
      previous = sample;
    }
    fft(re, im);
    for (let k = 0; k < power.length; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < MEL_FILTERS; m++) {
      const { start, peak, end } = bank[m];
      let sum = 0;
      for (let k = start; k < peak; k++) sum += power[k] * ((k - start) / (peak - start || 1));
      for (let k = peak; k < end; k++) sum += power[k] * ((end - k) / (end - peak || 1));
      mel[m] = Math.log(sum + 1e-10);
    }
    const coefficients = new Float64Array(COEFFICIENTS);
    for (let c = 0; c < COEFFICIENTS; c++) {
      let sum = 0;
      for (let m = 0; m < MEL_FILTERS; m++) sum += dct[c][m] * mel[m];
      coefficients[c] = sum;
    }
    result.push(coefficients);
  }
  return result;
}
