/*
 * features.js — SleepSensor
 *
 * Shared audio-feature extraction. Turns one normalised log-mel spectrogram
 * (NUM_MEL x TIME_STEPS, mel-major, values in [0,1]) plus a few cheap scalar
 * hints from the worklet (rms, peak, zcr) into a fixed-length feature vector.
 *
 * The SAME code runs in the browser classifier and in the offline training
 * pipeline, so a model trained on these features behaves identically live.
 */

export const NUM_MEL = 128;
export const TIME_STEPS = 64;

// Mel-band split points for a 0–8 kHz range over 128 bands:
//   band ~27 ≈ 500 Hz, band ~45 ≈ 1 kHz, band ~78 ≈ 3 kHz
const LOW_HI = 30; // [0,30)   low  — snoring fundamental + first harmonics
const MID_HI = 60; // [30,60)  mid
// [60,128) high — teeth-grinding broadband hiss

export const FEATURE_NAMES = [
  'lowRatio', // fraction of spectral energy in low mel bands
  'midRatio',
  'highRatio', // fraction in high mel bands
  'centroid', // spectral centroid, 0..1 of band range
  'spread', // spectral spread / bandwidth, 0..1
  'rolloff85', // band holding 85% cumulative energy, 0..1
  'flatness', // spectral flatness (geo/arith mean) — noise-like → 1
  'crest', // peak-band / mean-band ratio — tonal → high
  'harmonicity', // harmonic-comb score — snoring → high
  'periodicity', // autocorrelation peak of the energy envelope
  'modDepth', // amplitude modulation depth of the envelope
  'flux', // mean frame-to-frame spectral change — grinding → high
  'zcr', // zero-crossing rate (from worklet, else estimated)
  'loudness', // log-scaled RMS, 0..1 (separates "noise" from "other")
];

export const FEATURE_COUNT = FEATURE_NAMES.length;

/**
 * @param {Float32Array} spec  length NUM_MEL*TIME_STEPS, mel-major, [0,1]
 * @param {{rms?:number, peak?:number, zcr?:number}} [hints]
 * @returns {Float32Array} length FEATURE_COUNT
 */
export function extractFeatures(spec, hints = {}) {
  const M = NUM_MEL;
  const T = TIME_STEPS;
  const out = new Float32Array(FEATURE_COUNT);
  if (!spec || spec.length < M) return out;

  // per-band mean over time, and per-frame energy envelope over bands
  const band = new Float32Array(M);
  const env = new Float32Array(T);
  let total = 0;
  for (let m = 0; m < M; m++) {
    let acc = 0;
    for (let t = 0; t < T; t++) {
      const v = spec[m * T + t];
      acc += v;
      env[t] += v;
    }
    band[m] = acc / T;
    total += band[m];
  }
  for (let t = 0; t < T; t++) env[t] /= M;
  const totalSafe = total || 1e-9;

  // --- band ratios ---
  let low = 0;
  let mid = 0;
  let high = 0;
  for (let m = 0; m < M; m++) {
    if (m < LOW_HI) low += band[m];
    else if (m < MID_HI) mid += band[m];
    else high += band[m];
  }
  out[0] = low / totalSafe;
  out[1] = mid / totalSafe;
  out[2] = high / totalSafe;

  // --- centroid + spread ---
  let cNum = 0;
  for (let m = 0; m < M; m++) cNum += m * band[m];
  const centroid = cNum / totalSafe; // band units
  out[3] = centroid / (M - 1);
  let sNum = 0;
  for (let m = 0; m < M; m++) sNum += band[m] * (m - centroid) * (m - centroid);
  out[4] = Math.min(1, Math.sqrt(sNum / totalSafe) / (M / 3));

  // --- rolloff (85% cumulative energy) ---
  let cum = 0;
  let roll = M - 1;
  const target = 0.85 * totalSafe;
  for (let m = 0; m < M; m++) {
    cum += band[m];
    if (cum >= target) {
      roll = m;
      break;
    }
  }
  out[5] = roll / (M - 1);

  // --- flatness + crest ---
  let logSum = 0;
  let arith = 0;
  let maxBand = 0;
  for (let m = 0; m < M; m++) {
    const v = band[m] + 1e-6;
    logSum += Math.log(v);
    arith += v;
    if (band[m] > maxBand) maxBand = band[m];
  }
  const geo = Math.exp(logSum / M);
  out[6] = clamp01(geo / (arith / M));
  out[7] = clamp01((maxBand / (arith / M)) / 12); // ~12x mean ≈ very tonal

  // --- harmonicity: does the band spectrum look like a harmonic comb? ---
  out[8] = harmonicity(band, totalSafe);

  // --- temporal: periodicity + modulation depth ---
  const envMean = mean(env);
  let envVar = 0;
  for (let t = 0; t < T; t++) envVar += (env[t] - envMean) ** 2;
  envVar /= T;
  out[10] = envMean > 1e-6 ? clamp01((Math.sqrt(envVar) / envMean) * 1.5) : 0;

  let acPeak = 0;
  for (let lag = 2; lag < Math.floor(T / 2); lag++) {
    let num = 0;
    let den = 0;
    for (let t = 0; t < T - lag; t++) {
      num += (env[t] - envMean) * (env[t + lag] - envMean);
      den += (env[t] - envMean) ** 2;
    }
    if (den > 1e-9) acPeak = Math.max(acPeak, num / den);
  }
  out[9] = clamp01(0.5 * out[10] + 0.5 * clamp01(acPeak));

  // --- spectral flux (frame-to-frame change) ---
  let flux = 0;
  let fluxN = 0;
  for (let t = 1; t < T; t++) {
    let d = 0;
    for (let m = 0; m < M; m++) {
      const a = spec[m * T + t];
      const b = spec[m * T + t - 1];
      const diff = a - b;
      d += diff * diff;
    }
    flux += Math.sqrt(d / M);
    fluxN++;
  }
  out[11] = clamp01((fluxN ? flux / fluxN : 0) * 6);

  // --- zcr (worklet-provided, else estimate from centroid) ---
  out[12] = clamp01(typeof hints.zcr === 'number' ? hints.zcr * 3 : centroid / (M - 1));

  // --- loudness (log RMS) ---
  const r = typeof hints.rms === 'number' ? hints.rms : 0;
  out[13] = clamp01((Math.log10(Math.max(r, 1e-5)) + 4) / 3.5); // ~1e-4→0, ~0.03→1

  return out;
}

// ---------------------------------------------------------------------------
function harmonicity(band, totalSafe) {
  // For a set of candidate fundamentals (in band units), sum energy that lands
  // on integer multiples and compare to total. Snoring (voiced, buzzy) scores
  // high; broadband grinding scores low.
  const M = band.length;
  let best = 0;
  for (let f0 = 3; f0 <= 22; f0++) {
    let hit = 0;
    let n = 0;
    for (let k = 1; k * f0 < M; k++) {
      const c = k * f0;
      // energy in a ±1 band window around the harmonic
      hit += band[c] + 0.5 * (band[c - 1] || 0) + 0.5 * (band[c + 1] || 0);
      n++;
    }
    if (n >= 3) best = Math.max(best, hit / totalSafe);
  }
  return clamp01(best * 1.6);
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function mean(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / (a.length || 1);
}
