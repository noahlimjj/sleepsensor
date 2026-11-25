/*
 * sound-shape.js — SleepSensor
 *
 * Tells generic sounds apart without a trained class for each: a buzz (phone
 * vibration, a mosquito, an appliance hum) is tonal (one band towers over the
 * rest) and that band holds still; movement (sheets, pillow, turning over) is
 * broadband and comes in bursts. Works on the worklet's normalised log-mel
 * spectrogram (mel-major, NUM_MEL x TIME, values 0..1).
 */

export function soundShape(spec, numMel = 128) {
  const T = Math.round(spec.length / numMel);
  if (!T || T < 4) return null;
  let tonalSum = 0;
  const peaks = [];
  const tonalAt = new Float32Array(T);
  const energy = new Float32Array(T);
  const col = new Float32Array(numMel);
  for (let t = 0; t < T; t++) {
    let mx = 0, arg = 0, sum = 0;
    for (let m = 0; m < numMel; m++) {
      const v = spec[m * T + t];
      col[m] = v;
      sum += v;
      if (v > mx) { mx = v; arg = m; }
    }
    const sorted = Array.from(col).sort((a, b) => a - b);
    tonalAt[t] = mx - sorted[numMel >> 1]; // peak above the median band
    tonalSum += tonalAt[t];
    peaks.push(arg);
    energy[t] = sum / numMel;
  }
  // judge tone + stability on the active half of the frames, so a pulsed buzz
  // (on/off vibration) is judged on its "on" frames
  const eSorted = Array.from(energy).sort((a, b) => a - b);
  const eMed = eSorted[T >> 1];
  const act = [];
  for (let t = 0; t < T; t++) if (energy[t] >= eMed) act.push(t);
  const hist = new Map();
  for (const t of act) hist.set(peaks[t], (hist.get(peaks[t]) || 0) + 1);
  let mode = peaks[act[0]], best = 0;
  for (const [p, c] of hist) if (c > best) { best = c; mode = p; }
  const stable = act.filter((t) => Math.abs(peaks[t] - mode) <= 2).length / act.length;
  let tonalAct = 0;
  for (const t of act) tonalAct += tonalAt[t];
  tonalSum = (tonalAct / act.length) * T;
  // burstiness: spread of frame energy relative to its mean
  let mean = 0;
  for (const e of energy) mean += e;
  mean /= T;
  let v = 0;
  for (const e of energy) v += (e - mean) * (e - mean);
  const burst = Math.sqrt(v / T) / (mean || 1);
  return { tonal: round3(tonalSum / T), stable: round3(stable), burst: round3(burst), band: mode };
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/** Label a generic sound bout from its mean shape. */
export function labelNoise(shape, durationSec) {
  if (!shape) return 'other';
  if (shape.tonal >= BUZZ_TONAL && shape.stable >= BUZZ_STABLE && shape.burst <= BUZZ_MAX_BURST && durationSec >= 2) return 'buzz';
  if (shape.tonal < MOVE_TONAL && shape.burst >= MOVE_BURST && durationSec <= 30) return 'movement';
  return 'other';
}
export const BUZZ_TONAL = 0.3;
export const BUZZ_STABLE = 0.7;
export const BUZZ_MAX_BURST = 0.16;
export const MOVE_TONAL = 0.25;
export const MOVE_BURST = 0.1;
