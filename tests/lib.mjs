// Minimal test helpers — no framework.
let passed = 0;
let failed = 0;
const failures = [];

export function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

export function eq(a, b, msg) {
  ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

export function approx(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, `${msg} (expected ~${b} ±${tol}, got ${a})`);
}

export function section(name) {
  console.log(`\n▸ ${name}`);
}

export function pass(msg) {
  passed++;
  console.log(`  ✓ ${msg}`);
}

export function summary() {
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

// ---- synthetic audio generators (mono, Float32Array) ----
export function sineWithBreathing(sampleRate, seconds, freq = 120, breathHz = 0.35) {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // amplitude modulation mimics inspiration/expiration cycle
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * breathHz * t - Math.PI / 2);
    // a couple of harmonics -> tonal, low-frequency
    const s =
      Math.sin(2 * Math.PI * freq * t) +
      0.5 * Math.sin(2 * Math.PI * 2 * freq * t) +
      0.25 * Math.sin(2 * Math.PI * 3 * freq * t);
    out[i] = 0.3 * env * s;
  }
  return out;
}

export function highFreqNoise(sampleRate, seconds, loHz = 1500, hiHz = 4500) {
  // steady broadband noise, crudely band-limited by a one-pole high-pass +
  // low-pass cascade -> spectrally flat-ish in the grinding band
  const n = Math.round(sampleRate * seconds);
  const white = new Float32Array(n);
  for (let i = 0; i < n; i++) white[i] = Math.random() * 2 - 1;
  const hpAlpha = Math.exp((-2 * Math.PI * loHz) / sampleRate);
  const lpAlpha = Math.exp((-2 * Math.PI * hiHz) / sampleRate);
  const out = new Float32Array(n);
  let hpPrevIn = 0;
  let hpPrevOut = 0;
  let lpPrev = 0;
  for (let i = 0; i < n; i++) {
    const hp = hpAlpha * (hpPrevOut + white[i] - hpPrevIn);
    hpPrevIn = white[i];
    hpPrevOut = hp;
    const lp = (1 - lpAlpha) * hp + lpAlpha * lpPrev;
    lpPrev = lp;
    out[i] = 0.35 * lp;
  }
  return out;
}

export function nearSilence(sampleRate, seconds, level = 1e-4) {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * level;
  return out;
}
