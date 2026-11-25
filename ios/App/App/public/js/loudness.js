/*
 * loudness.js — SleepSensor
 *
 * Makes quiet night clips audible. A phone on a nightstand records snoring and
 * grinding at -45 dBFS or lower, which is hard to hear on a phone speaker.
 * For playback and export each clip is brought to a target loudness
 * (ITU-R BS.1770 integrated loudness, -16 LUFS by default) and a look-ahead
 * peak limiter keeps it under -1 dBFS. The stored recording is never changed:
 * these functions return new samples / a new WAV blob.
 */

export const TARGET_LUFS = -16;
export const CEILING_DB = -1;
const MAX_GAIN_DB = 48; // a near-silent clip is not turned into pure hiss
const MIN_GAIN_DB = -12;

function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/** BS.1770 K-weighting (high shelf + high pass), coefficients for any rate. */
function kWeight(x, fs) {
  // stage 1: high shelf
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = biquad(x, (Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  // stage 2: high pass
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  return biquad(s1, 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
}

/** Integrated loudness in LUFS (gated, 400 ms blocks, 75 % overlap). -Infinity for silence. */
export function integratedLoudness(samples, fs = 16000) {
  if (!samples || samples.length === 0) return -Infinity;
  const y = kWeight(samples, fs);
  const block = Math.round(0.4 * fs);
  const hop = Math.round(0.1 * fs);
  const ms = [];
  if (y.length < block) {
    let s = 0;
    for (let i = 0; i < y.length; i++) s += y[i] * y[i];
    ms.push(s / y.length);
  } else {
    for (let start = 0; start + block <= y.length; start += hop) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += y[i] * y[i];
      ms.push(s / block);
    }
  }
  const lk = (z) => -0.691 + 10 * Math.log10(z);
  const abs = ms.filter((z) => z > 0 && lk(z) > -70);
  if (!abs.length) return -Infinity;
  const relGate = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((z) => lk(z) > relGate);
  return lk(rel.reduce((a, b) => a + b, 0) / rel.length);
}

export function peakDb(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > p) p = a;
  }
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}

/**
 * Gain to the target loudness, then a look-ahead limiter at the ceiling.
 * @returns {{ samples: Float32Array, gainDb: number, lufsIn: number, lufsOut: number, peakDb: number }}
 */
export function normalizeSamples(samples, fs = 16000, { targetLufs = TARGET_LUFS, ceilingDb = CEILING_DB } = {}) {
  const lufsIn = integratedLoudness(samples, fs);
  const gainDb = Number.isFinite(lufsIn) ? Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, targetLufs - lufsIn)) : 0;
  const g = Math.pow(10, gainDb / 20);
  const ceil = Math.pow(10, ceilingDb / 20);
  const n = samples.length;
  const out = new Float32Array(n);

  // gain each sample would need to stay under the ceiling
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i] * g);
    need[i] = a > ceil ? ceil / a : 1;
  }
  // look ahead 5 ms: the gain is already down when a peak arrives
  const look = Math.max(1, Math.round(0.005 * fs));
  const ahead = new Float32Array(n);
  const dq = []; // indices with increasing need (sliding-window minimum)
  for (let i = n - 1; i >= 0; i--) {
    while (dq.length && need[dq[dq.length - 1]] >= need[i]) dq.pop();
    dq.push(i);
    while (dq[0] > i + look) dq.shift();
    ahead[i] = need[dq[0]];
  }
  // fast attack ramp across the look-ahead, slow release (~100 ms)
  const attack = 1 - Math.exp(-1 / look);
  const release = 1 - Math.exp(-1 / (0.1 * fs));
  let env = 1;
  for (let i = 0; i < n; i++) {
    const t = ahead[i];
    env += (t - env) * (t < env ? attack : release);
    const v = samples[i] * g * Math.min(env, need[i]); // need[i] guarantees the ceiling
    out[i] = v;
  }
  return { samples: out, gainDb, lufsIn, lufsOut: integratedLoudness(out, fs), peakDb: peakDb(out) };
}

// ---- WAV in / out -------------------------------------------------------

/** Decode a PCM WAV (8/16/24/32-bit int or 32-bit float; first channel). */
export function decodeWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (v.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= v.byteLength) {
    const id = tag(pos);
    const size = v.getUint32(pos + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(pos + 8, true), channels: v.getUint16(pos + 10, true), rate: v.getUint32(pos + 12, true), bits: v.getUint16(pos + 22, true) };
    else if (id === 'data') data = { off: pos + 8, size: Math.min(size, v.byteLength - pos - 8) };
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data');
  const bps = fmt.bits / 8;
  const frame = bps * fmt.channels;
  const n = Math.floor(data.size / frame);
  const out = new Float32Array(n);
  const float = fmt.format === 3;
  for (let i = 0; i < n; i++) {
    const o = data.off + i * frame;
    let s;
    if (float) s = v.getFloat32(o, true);
    else if (fmt.bits === 16) s = v.getInt16(o, true) / 32768;
    else if (fmt.bits === 8) s = (v.getUint8(o) - 128) / 128;
    else if (fmt.bits === 24) s = ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608);
    else s = v.getInt32(o, true) / 2147483648;
    out[i] = s;
  }
  return { samples: out, sampleRate: fmt.rate };
}

export function encodeWav(samples, sampleRate = 16000) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) {
    const s = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([v], { type: 'audio/wav' });
}

/** A louder copy of a WAV blob. The original blob is untouched. */
export async function normalizeWavBlob(blob, opts) {
  const { samples, sampleRate } = decodeWav(await blob.arrayBuffer());
  const r = normalizeSamples(samples, sampleRate, opts);
  return { blob: encodeWav(r.samples, sampleRate), gainDb: r.gainDb, lufsIn: r.lufsIn, lufsOut: r.lufsOut, peakDb: r.peakDb };
}
