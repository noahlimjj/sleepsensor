// Builds training/features.json from the local audio corpus.
//
//   node training/extract-features.mjs            # base features
//   node training/extract-features.mjs --aug 3    # + 3 augmented variants/window
//
// Each sample: { label, f:[...46], src:'<fileId>', aug:<0|n> }
//   `src` groups windows from the same recording so the trainer can split by
//   file (no leakage). `aug` > 0 marks synthetic variants (train-only).
import { readdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { readWavMono, resample } from './wav.mjs';
import { extractFeatures, FEATURE_NAMES } from '../js/features.js';
import { dsp } from '../tests/load-worklet.mjs';
import { synthBruxism, synthSnoring, synthGrindingBandNoise } from './synth.mjs';

const AUG = (() => {
  const i = process.argv.indexOf('--aug');
  return i >= 0 ? Math.max(0, parseInt(process.argv[i + 1] || '0', 10)) : 0;
})();

const SR = 16000;
const WIN = SR * 2;
const HOP = Math.round(SR * 1.5); // 1.5 s hop
const EDGE_TRIM = SR * 2; // skip 2 s at each end of long files (intros/outros)
const MAX_WIN_PER_FILE = 45; // cap long recordings (~70 s) for balance + speed
const HERE = new URL('.', import.meta.url).pathname;
const DS = join(HERE, '_snoredet/Snoring_Dataset_@16000');
const YT = join(HERE, 'audio');
const melOpts = { fftSize: 512, hop: 256, numMel: 128, timeSteps: 64, sampleRate: SR };

let _seed = 12345;
const rnd = () => ((_seed = (_seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

const samples = [];
const noisePool = []; // small bank of "other" snippets for mix augmentation

function melFeat(win) {
  const rms = dsp.rms(win);
  const peak = dsp.peakAbs(win);
  const zcr = dsp.zcr(win);
  let spec = dsp.melSpectrogram(win, melOpts);
  return { f: Array.from(extractFeatures(spec, { rms, peak, zcr })), rms };
}

function specAugment(win) {
  // waveform-domain: gain + gaussian noise + tiny speed change + optional mix
  const out = new Float32Array(win.length);
  const gain = Math.pow(10, (rnd() * 12 - 6) / 20); // ±6 dB
  const nAmp = dsp.rms(win) * (0.05 + rnd() * 0.25); // 12–26 dB SNR-ish
  const speed = 0.92 + rnd() * 0.16;
  let mix = null;
  if (noisePool.length && rnd() < 0.4) {
    mix = noisePool[(rnd() * noisePool.length) | 0];
  }
  for (let i = 0; i < win.length; i++) {
    const src = Math.min(win.length - 1, Math.floor(i * speed));
    let v = win[src] * gain + randn() * nAmp;
    if (mix) v += mix[i % mix.length] * (0.05 + rnd() * 0.15);
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

function windowsOf(sig, { trimEdges }) {
  const out = [];
  if (sig.length <= WIN) {
    // extend a short clip (Kaggle 1 s) to 2 s by reflection — keeps energy and
    // continuity, without the fake exact-period repeat that plain tiling creates.
    const w = new Float32Array(WIN);
    for (let i = 0; i < WIN; i++) {
      const period = 2 * sig.length;
      let p = i % period;
      w[i] = p < sig.length ? sig[p] : sig[period - 1 - p];
    }
    out.push(w);
    return out;
  }
  const start = trimEdges ? EDGE_TRIM : 0;
  const end = trimEdges ? sig.length - EDGE_TRIM : sig.length;
  for (let s = start; s + WIN <= end && out.length < MAX_WIN_PER_FILE; s += HOP) {
    out.push(sig.subarray(s, s + WIN));
  }
  return out;
}

function loadSig(path) {
  const a = readWavMono(path);
  let s = a.samples;
  if (a.sampleRate !== SR) s = resample(s, a.sampleRate, SR);
  return s;
}

function ingest(dir, { label, trimEdges = true, gate = 0.01, cap = Infinity, stride = 1, aug = AUG, recurse = false }) {
  if (!existsSync(dir)) {
    console.warn('  (missing)', dir);
    return;
  }
  let files = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        if (recurse) walk(p);
      } else if (e.endsWith('.wav')) files.push(p);
    }
  };
  walk(dir);

  let used = 0;
  for (let fi = 0; fi < files.length && used < cap; fi += stride) {
    const path = files[fi];
    const src = basename(path, '.wav');
    let sig;
    try {
      sig = loadSig(path);
    } catch {
      continue;
    }
    const wins = windowsOf(sig, { trimEdges });
    for (const w of wins) {
      const r = dsp.rms(w);
      const lbl = typeof label === 'function' ? label(r, w) : label;
      if (!lbl) continue;
      // activity gate for the active classes
      if ((lbl === 'snoring' || lbl === 'bruxism') && r < gate) continue;
      if (r < 1e-4) continue; // dead window

      samples.push({ label: lbl, f: melFeat(w).f, src, aug: 0 });
      used++;

      if (noisePool.length < 60 && lbl === 'noise' && rnd() < 0.15) {
        noisePool.push(Float32Array.from(w));
      }
      for (let a = 1; a <= aug; a++) {
        samples.push({ label: lbl, f: melFeat(specAugment(w)).f, src, aug: a });
      }
      if (used >= cap) break;
    }
  }
  console.log(`  ${dir.replace(HERE, '')}  ->  ${used} base windows${aug ? ` (+${aug}x aug)` : ''}`);
}

console.log(`extracting features${AUG ? ` with ${AUG}x augmentation` : ''} ...`);

// ---- snoring ----
ingest(join(DS, 'snoring'), { label: 'snoring', trimEdges: false, gate: 0.006 });
ingest(join(YT, 'snoring'), { label: (r) => (r > 0.01 ? 'snoring' : null), recurse: true });

// ---- bruxism ----
ingest(join(YT, 'bruxism'), { label: (r) => (r > 0.008 ? 'bruxism' : null), recurse: true, aug: AUG + 1 });

// ---- noise (loud non-snore) ----
ingest(join(DS, 'no_snoring'), { label: (r) => (r > 0.012 ? 'noise' : 'quiet'), trimEdges: false });
ingest(join(YT, 'other'), { label: (r) => (r > 0.02 ? 'noise' : 'quiet'), recurse: true });
for (const word of ['house', 'learn', 'left', 'marvin', 'one', 'off']) {
  ingest(join(DS, word), { label: 'noise', trimEdges: false, cap: 90, stride: 14, aug: 0 });
}

// ---- quiet / ambient ----
ingest(join(DS, '_background_noise_'), { label: (r) => (r < 0.03 ? 'quiet' : 'noise'), trimEdges: false });
for (let i = 0; i < 250; i++) {
  const w = new Float32Array(WIN);
  const lvl = 1e-4 + rnd() * 4e-3;
  for (let j = 0; j < WIN; j++) w[j] = randn() * lvl;
  samples.push({ label: 'quiet', f: melFeat(w).f, src: `synthquiet${i % 20}`, aug: 0 });
}

// ---- physically-modelled synthetic supplements ----
// Real bruxism recordings are scarce; these give the model clean, highly-varied
// examples of the target signature. Kept a minority + heavily randomised.
for (let i = 0; i < 380; i++) {
  samples.push({ label: 'bruxism', f: melFeat(synthBruxism(2)).f, src: `synbrux${i % 36}`, aug: i % 2 === 0 ? 0 : 1 });
}
// steady grinding-band noise -> NOISE (hard negative: no jaw modulation)
for (let i = 0; i < 320; i++) {
  samples.push({ label: 'noise', f: melFeat(synthGrindingBandNoise(2)).f, src: `syngbn${i % 24}`, aug: 0 });
}
for (let i = 0; i < 240; i++) {
  samples.push({ label: 'snoring', f: melFeat(synthSnoring(2)).f, src: `synsnore${i % 20}`, aug: i % 2 === 0 ? 0 : 1 });
}
// hard negatives for "noise": steady broadband hiss / rumble that could be
// mistaken for grinding — teaches the model that grinding needs jaw modulation.
for (let i = 0; i < 380; i++) {
  const w = new Float32Array(WIN);
  const type = i % 3;
  let hp = 0;
  let prev = 0;
  const a = 0.9 + rnd() * 0.09;
  for (let j = 0; j < WIN; j++) {
    let n = randn();
    if (type === 0) n = a * (prev + n - hp), (hp = randn()), (prev = n); // hiss-ish
    else if (type === 1) n = 0.2 * n + 0.8 * prev, (prev = n); // low rumble
    w[j] = n * (0.02 + rnd() * 0.08);
  }
  samples.push({ label: 'noise', f: melFeat(w).f, src: `synhiss${i % 24}`, aug: 0 });
}

// ---- report ----
const byLabel = {};
const byLabelBase = {};
const groups = new Set();
for (const s of samples) {
  byLabel[s.label] = (byLabel[s.label] || 0) + 1;
  if (!s.aug) byLabelBase[s.label] = (byLabelBase[s.label] || 0) + 1;
  groups.add(s.src);
}
console.log('\nbase windows:', byLabelBase);
console.log('total (with aug):', byLabel);
console.log('source files:', groups.size);

writeFileSync(
  join(HERE, 'features.json'),
  JSON.stringify({ featureNames: FEATURE_NAMES, sampleRate: SR, aug: AUG, samples })
);
console.log(`\nwrote training/features.json  (${samples.length} samples)`);
