/*
 * features.js — SleepSensor
 *
 * Shared audio-feature extraction. Turns one normalised log-mel spectrogram
 * (NUM_MEL x TIME_STEPS, mel-major, values in [0,1]) plus a few cheap scalar
 * hints from the worklet (rms, peak, zcr) into a fixed-length feature vector.
 *
 * The SAME code runs in the browser classifier and the offline trainer, so a
 * model trained on these features behaves identically live.
 *
 * Layout: 14 hand-designed descriptors + 13 MFCC means + 6 MFCC temporal
 * deltas + 6 MFCC temporal std + 7 spectral-contrast bands = 46 features.
 */

export const NUM_MEL = 128;
export const TIME_STEPS = 64;

const LOW_HI = 30; // [0,30)   low  — snoring fundamental + first harmonics (~<500 Hz)
const MID_HI = 60; // [30,60)  mid
// [60,128) high — teeth-grinding broadband hiss (~>1 kHz)

const N_MFCC = 13;
const N_MFCC_DYN = 6; // how many MFCCs get delta / std features
const N_CONTRAST = 7;

export const FEATURE_NAMES = [
  // --- hand-designed descriptors ---
  'lowRatio', 'midRatio', 'highRatio',
  'centroid', 'spread', 'rolloff85',
  'flatness', 'crest', 'harmonicity',
  'periodicity', 'modDepth', 'flux', 'zcr', 'loudness',
  // --- MFCC means (spectral envelope shape) ---
  ...Array.from({ length: N_MFCC }, (_, i) => `mfcc${i + 1}`),
  // --- MFCC temporal deltas (how fast the timbre changes) ---
  ...Array.from({ length: N_MFCC_DYN }, (_, i) => `dmfcc${i + 1}`),
  // --- MFCC temporal std (timbre stability) ---
  ...Array.from({ length: N_MFCC_DYN }, (_, i) => `smfcc${i + 1}`),
  // --- spectral contrast per sub-band (peak-to-valley) ---
  ...Array.from({ length: N_CONTRAST }, (_, i) => `contrast${i + 1}`),
];

export const FEATURE_COUNT = FEATURE_NAMES.length;

// precomputed DCT-II basis: [coeff][mel]
const DCT = (() => {
  const M = NUM_MEL;
  const rows = N_MFCC;
  const basis = [];
  for (let k = 0; k < rows; k++) {
    const row = new Float32Array(M);
    const scale = Math.sqrt(2 / M);
    for (let n = 0; n < M; n++) row[n] = scale * Math.cos((Math.PI * (n + 0.5) * k) / M);
    basis.push(row);
  }
  return basis;
})();

// log-spaced contrast band edges over the 128 mel bins
const CONTRAST_EDGES = (() => {
  const edges = [0];
  for (let i = 1; i <= N_CONTRAST; i++) {
    edges.push(Math.round(Math.pow(NUM_MEL, i / N_CONTRAST)));
  }
  edges[N_CONTRAST] = NUM_MEL;
  return edges;
})();

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

  // per-band mean over time + per-frame energy envelope over bands
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

  // ---- band ratios ----
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

  // ---- centroid + spread ----
  let cNum = 0;
  for (let m = 0; m < M; m++) cNum += m * band[m];
  const centroid = cNum / totalSafe;
  out[3] = centroid / (M - 1);
  let sNum = 0;
  for (let m = 0; m < M; m++) sNum += band[m] * (m - centroid) * (m - centroid);
  out[4] = Math.min(1, Math.sqrt(sNum / totalSafe) / (M / 3));

  // ---- rolloff (85% cumulative energy) ----
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

  // ---- flatness + crest ----
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
  out[7] = clamp01((maxBand / (arith / M)) / 12);

  // ---- harmonicity ----
  out[8] = harmonicity(band, totalSafe);

  // ---- temporal: modulation + periodicity ----
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

  // ---- spectral flux ----
  let flux = 0;
  for (let t = 1; t < T; t++) {
    let d = 0;
    for (let m = 0; m < M; m++) {
      const diff = spec[m * T + t] - spec[m * T + t - 1];
      d += diff * diff;
    }
    flux += Math.sqrt(d / M);
  }
  out[11] = clamp01((flux / (T - 1)) * 6);

  // ---- zcr + loudness ----
  out[12] = clamp01(typeof hints.zcr === 'number' ? hints.zcr * 3 : centroid / (M - 1));
  const r = typeof hints.rms === 'number' ? hints.rms : 0;
  out[13] = clamp01((Math.log10(Math.max(r, 1e-5)) + 4) / 3.5);

  // ---- MFCCs: DCT-II of each time frame's log-mel column ----
  // frames use the (already log+normalised) spectrogram columns.
  const mfPer = new Array(N_MFCC); // [coeff] -> Float32Array(T)
  for (let k = 0; k < N_MFCC; k++) mfPer[k] = new Float32Array(T);
  const col = new Float32Array(M);
  for (let t = 0; t < T; t++) {
    for (let m = 0; m < M; m++) col[m] = spec[m * T + t];
    for (let k = 0; k < N_MFCC; k++) {
      const b = DCT[k];
      let s = 0;
      for (let m = 0; m < M; m++) s += b[m] * col[m];
      mfPer[k][t] = s;
    }
  }
  let oi = 14;
  for (let k = 0; k < N_MFCC; k++) out[oi++] = squash(mean(mfPer[k]), 4);
  for (let k = 0; k < N_MFCC_DYN; k++) {
    let d = 0;
    for (let t = 1; t < T; t++) d += Math.abs(mfPer[k][t] - mfPer[k][t - 1]);
    out[oi++] = squash(d / (T - 1), 2);
  }
  for (let k = 0; k < N_MFCC_DYN; k++) {
    const mu = mean(mfPer[k]);
    let v = 0;
    for (let t = 0; t < T; t++) v += (mfPer[k][t] - mu) ** 2;
    out[oi++] = squash(Math.sqrt(v / T), 2);
  }

  // ---- spectral contrast per sub-band ----
  for (let bnd = 0; bnd < N_CONTRAST; bnd++) {
    const lo = CONTRAST_EDGES[bnd];
    const hi = Math.max(lo + 1, CONTRAST_EDGES[bnd + 1]);
    let pk = -Infinity;
    let vl = Infinity;
    for (let m = lo; m < hi; m++) {
      if (band[m] > pk) pk = band[m];
      if (band[m] < vl) vl = band[m];
    }
    out[oi++] = clamp01((pk - vl) * 2);
  }

  return out;
}

// ---------------------------------------------------------------------------
function harmonicity(band, totalSafe) {
  const M = band.length;
  let best = 0;
  for (let f0 = 3; f0 <= 22; f0++) {
    let hit = 0;
    let n = 0;
    for (let k = 1; k * f0 < M; k++) {
      const c = k * f0;
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
// map an unbounded value into ~[0,1] smoothly (tanh-ish), scale sets the knee
function squash(x, scale) {
  const y = x / scale;
  return 0.5 + 0.5 * (y / (1 + Math.abs(y)));
}
