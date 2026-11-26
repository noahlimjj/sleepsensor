/*
 * resp-rate.js — SleepSensor
 *
 * Breathing rate from sound. The worklet already reports the 1-4 kHz band level
 * every 100 ms (the band where breath noise lives; see createBreathMeter). Over
 * a 60 s span that envelope rises and falls with each breath, so its
 * autocorrelation peaks at the breath period. One estimate every 30 s; the
 * night gets a median, a low/high (10th/90th percentile) and a trend.
 *
 * Minutes without a clear rhythm (silence, talking, movement, a fan drowning
 * the breath) are skipped rather than guessed.
 */

const FS = 10; // envelope frames per second
const MIN_BPM = 8; // slower is rare in sleeping adults; below it, room hum/drift fakes a rhythm
const MAX_BPM = 30;
export const MIN_QUALITY = 0.4;
const MIN_SWING_DB = 1.5; // breath must move the band level this much (std, dB) to be heard at all
export let DOUBLE_RATIO = 1.3;
export let FUNDAMENTAL_SHARE = 0.7;
export function _setShare(v) { FUNDAMENTAL_SHARE = v; }
export function _setDoubleRatio(v) { DOUBLE_RATIO = v; }

function movingMean(x, w) {
  const out = new Float64Array(x.length);
  let acc = 0;
  const h = w >> 1;
  const cs = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cs[i + 1] = cs[i] + x[i];
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - h);
    const b = Math.min(x.length, i + h + 1);
    out[i] = (cs[b] - cs[a]) / (b - a);
  }
  void acc;
  return out;
}

/**
 * @param {ArrayLike<number>} db  band level per 100 ms (dB), ~60 s
 * @returns {{ bpm: number, q: number } | null}
 */
export function estimateRate(db, fs = FS) {
  const n = db.length;
  if (n < fs * 30) return null;
  const sorted = Array.from(db).sort((a, b) => a - b);
  const med = sorted[n >> 1];
  const lo = sorted[Math.floor(n * 0.05)];
  // tame clicks/bangs and dropouts so one sound can't dominate the rhythm
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.max(lo, Math.min(db[i], med + 12));
  const trend = movingMean(x, Math.round(fs * 10));
  const sm = movingMean(x, 3); // ~0.3 s smoothing
  for (let i = 0; i < n; i++) x[i] = sm[i] - trend[i];
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += x[i] * x[i];
  if (e0 <= 1e-9) return null;
  if (Math.sqrt(e0 / n) < MIN_SWING_DB) return null; // breathing not audible
  const minLag = Math.round((60 / MAX_BPM) * fs);
  const maxLag = Math.round((60 / MIN_BPM) * fs);
  const r = new Float64Array(maxLag + 2);
  for (let L = 1; L <= maxLag + 1; L++) {
    let acc = 0;
    for (let i = 0; i + L < n; i++) acc += x[i] * x[i + L];
    r[L] = (acc / e0) * (n / (n - L)); // unbiased
  }
  // the breath period is the shortest lag whose peak is nearly as strong as the
  // strongest: longer peaks at 2x, 3x the period are its echoes (half-rate errors)
  const peaks = [];
  for (let L = minLag; L <= maxLag; L++) if (r[L] >= r[L - 1] && r[L] >= r[L + 1] && r[L] > 0) peaks.push(L);
  if (!peaks.length) return null;
  const rmax = Math.max(...peaks.map((L) => r[L]));
  let best = peaks.find((L) => r[L] >= FUNDAMENTAL_SHARE * rmax);
  // inhale and exhale can each make a burst: if the lag one period later is as
  // strong and the half-period trough is shallow, the true breath is the longer one
  const dbl = best * 2;
  if (dbl <= maxLag) {
    let pk = dbl;
    for (let L = Math.max(minLag, dbl - 3); L <= Math.min(maxLag, dbl + 3); L++) if (r[L] > r[pk]) pk = L;
    if (r[pk] > r[best] * DOUBLE_RATIO) best = pk;
  }
  // parabolic refinement of the peak
  const a = r[best - 1], b = r[best], c = r[best + 1];
  const den = a - 2 * b + c;
  const off = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  const period = (best + off) / fs;
  return { bpm: Math.round((600 / period)) / 10, q: Math.round(b * 1000) / 1000 };
}

/** Streams worklet breath frames; emits an estimate every `everySec`. */
export class RespRateTracker {
  constructor({ spanSec = 60, everySec = 30 } = {}) {
    this.span = spanSec * FS;
    this.every = everySec * FS;
    this.reset();
  }

  reset() {
    this.buf = [];
    this.sinceLast = 0;
    this.points = []; // { t, bpm, q }
  }

  /** @param {number[]} frames dB per 100 ms; @param {number} wallEnd ms of the last frame */
  push(frames, wallEnd) {
    if (!frames || !frames.length) return null;
    for (const f of frames) this.buf.push(Number.isFinite(f) ? f : -120);
    if (this.buf.length > this.span) this.buf.splice(0, this.buf.length - this.span);
    this.sinceLast += frames.length;
    if (this.buf.length < this.span || this.sinceLast < this.every) return null;
    this.sinceLast = 0;
    const est = estimateRate(this.buf);
    if (!est || est.q < MIN_QUALITY) return null;
    const p = { t: wallEnd, bpm: est.bpm, q: est.q };
    this.points.push(p);
    if (this.points.length > 2400) this.points.shift();
    return p;
  }

  /** Night summary: median and 10th/90th percentile of the valid estimates. */
  summary() {
    return summarizeRates(this.points);
  }
}

export function summarizeRates(points) {
  const v = points.map((p) => p.bpm).sort((a, b) => a - b);
  if (v.length < 3) return { avg: null, min: null, max: null, n: v.length };
  const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * q)))];
  return { avg: Math.round(at(0.5) * 10) / 10, min: Math.round(at(0.1) * 10) / 10, max: Math.round(at(0.9) * 10) / 10, n: v.length };
}
