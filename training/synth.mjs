// Physically-motivated synthetic training clips. Used ONLY to supplement the
// minority classes (bruxism especially) — kept a minority of each class and
// heavily randomised. Real held-out recordings remain the only yardstick.
const SR = 16000;

let _s = 99;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const rng = (a, b) => a + (b - a) * rnd();
const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

function biquadBandpass(x, f0, Q) {
  const w0 = (2 * Math.PI * f0) / SR;
  const alpha = Math.sin(w0) / (2 * Q);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = (b0 / a0) * xi + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** Steady broadband noise in the grinding band but WITHOUT jaw modulation —
 *  a hard negative so the model learns grinding needs rhythmic AM. */
export function synthGrindingBandNoise(seconds = 2) {
  const n = SR * seconds;
  const white = new Float32Array(n);
  for (let i = 0; i < n; i++) white[i] = randn();
  let sig = new Float32Array(n);
  const bands = 1 + (rnd() * 2 | 0);
  for (let b = 0; b < bands; b++) {
    const f0 = rng(1000, 5000);
    const filt = biquadBandpass(white, f0, rng(1, 4));
    for (let i = 0; i < n; i++) sig[i] += filt[i];
  }
  // only a gentle, slow drift (not the fast jaw AM of real grinding)
  const driftHz = rng(0.03, 0.15);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    sig[i] *= 0.8 + 0.2 * Math.sin(2 * Math.PI * driftHz * (i / SR));
    peak = Math.max(peak, Math.abs(sig[i]));
  }
  const g = rng(0.05, 0.25) / (peak || 1);
  for (let i = 0; i < n; i++) sig[i] = Math.max(-1, Math.min(1, sig[i] * g));
  return sig;
}

/** Teeth grinding: rhythmic broadband friction, 1–5 kHz, jaw sweep 0.5–2 Hz. */
export function synthBruxism(seconds = 2) {
  const n = SR * seconds;
  const white = new Float32Array(n);
  for (let i = 0; i < n; i++) white[i] = randn();
  // 2–3 stacked bandpass bands for a gritty friction timbre
  let sig = new Float32Array(n);
  const bands = 2 + (rnd() < 0.5 ? 1 : 0);
  for (let b = 0; b < bands; b++) {
    const f0 = rng(1200, 4800);
    const filt = biquadBandpass(white, f0, rng(1.5, 5));
    for (let i = 0; i < n; i++) sig[i] += filt[i] * rng(0.5, 1);
  }
  // jaw back-and-forth amplitude modulation + a slow burst envelope
  const amHz = rng(0.5, 2.2);
  const amPhase = rnd() * 6.28;
  const amDepth = rng(0.4, 0.9);
  const burstOn = rnd() < 0.7;
  const burstStart = rng(0, 0.4) * seconds;
  const burstEnd = rng(0.6, 1) * seconds;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let env = 1 - amDepth + amDepth * (0.5 + 0.5 * Math.sin(2 * Math.PI * amHz * t + amPhase));
    // rough texture (micro-scrapes)
    env *= 0.7 + 0.3 * Math.abs(randn());
    if (burstOn && (t < burstStart || t > burstEnd)) env *= 0.08;
    sig[i] *= env;
    const a = Math.abs(sig[i]);
    if (a > peak) peak = a;
  }
  // occasional resonant "creak" chirp
  if (rnd() < 0.4) {
    const cs = (rng(0.1, 0.7) * n) | 0;
    const clen = (rng(0.05, 0.2) * SR) | 0;
    const f1 = rng(800, 1500);
    const f2 = rng(2500, 5000);
    for (let i = 0; i < clen && cs + i < n; i++) {
      const fr = f1 + (f2 - f1) * (i / clen);
      sig[cs + i] += 0.5 * Math.sin((2 * Math.PI * fr * i) / SR) * Math.exp(-3 * (i / clen));
    }
  }
  const g = rng(0.15, 0.5) / (peak || 1);
  for (let i = 0; i < n; i++) sig[i] = Math.max(-1, Math.min(1, sig[i] * g));
  return sig;
}

/** Snoring: low-frequency voiced buzz with harmonics, breath cycle 0.15–0.4 Hz. */
export function synthSnoring(seconds = 2) {
  const n = SR * seconds;
  const f0 = rng(55, 130);
  const breathHz = rng(0.15, 0.4);
  const breathPhase = rnd() * 6.28;
  const jitter = rng(0, 0.06);
  const nBands = 4 + (rnd() * 4 | 0);
  const sig = new Float32Array(n);
  let phase = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 * (1 + jitter * randn() * 0.1);
    phase += (2 * Math.PI * f) / SR;
    let s = 0;
    for (let h = 1; h <= nBands; h++) s += (1 / h) * Math.sin(h * phase);
    // inspiratory/expiratory envelope + a rattle
    let env = 0.5 + 0.5 * Math.sin(2 * Math.PI * breathHz * t + breathPhase);
    env = Math.pow(env, 1.5);
    env *= 0.85 + 0.15 * Math.sin(2 * Math.PI * rng(15, 45) * t); // uvular flutter
    s *= env;
    sig[i] = s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const g = rng(0.15, 0.45) / (peak || 1);
  for (let i = 0; i < n; i++) sig[i] = Math.max(-1, Math.min(1, sig[i] * g));
  return sig;
}
