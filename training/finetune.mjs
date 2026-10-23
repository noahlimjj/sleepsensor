// Fine-tunes the shipped feature MLP (js/model-weights.js) for real bedside
// conditions: sounds recorded quietly from across the bed and over fan / AC
// noise, which the original close-mic training data never covered.
//
//   node training/finetune.mjs <esc50-dir> [--write]
//
// <esc50-dir> holds ESC-50 clips named `<category>__f<fold>__<file>.wav`.
// Folds 1-3 train, fold 4 validates (early stopping), fold 5 is the held-out
// test. Features go through the exact app pipeline (worklet DSP ->
// extractFeatures with the engine's floor-relative loudness gain). Pure JS, no
// TensorFlow. Starts from the current weights with an L2 pull back towards
// them, and replays synthetic bruxism / snoring / grinding-band noise so the
// classes the ESC data lacks are not forgotten.
import { readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readWavMono, resample } from './wav.mjs';
import { extractFeatures } from '../js/features.js';
import { MODEL } from '../js/model-weights.js';
import { dsp } from '../tests/load-worklet.mjs';
import { synthBruxism, synthSnoring, synthGrindingBandNoise } from './synth.mjs';

const ESC = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!ESC) {
  console.error('usage: node training/finetune.mjs <esc50-dir> [--write]');
  process.exit(1);
}
const SR = 16000;
const WIN = SR * 2;
const CLASSES = MODEL.classes; // quiet, snoring, bruxism, noise
const melOpts = { fftSize: 512, hop: 256, numMel: 128, timeSteps: 64, sampleRate: SR };
const melFb = dsp.buildMelFilterbank(128, 512, SR);

// must match audio-engine.js
const CLASSIFY_FLOOR_DB = -50;
const MAX_LOUDNESS_GAIN_DB = 20;

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const fromDb = (d) => Math.pow(10, d / 20);
const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-9));

// ---- backgrounds: quiet room, fan, AC rumble ----
function background(kind, db) {
  const o = new Float32Array(WIN);
  let a = 0, b = 0;
  const hum = 50 + rnd() * 100;
  for (let i = 0; i < WIN; i++) {
    a += 0.08 * (randn() - a);
    b += 0.3 * (randn() - b);
    if (kind === 'quiet') o[i] = a;
    else if (kind === 'fan') o[i] = b * 0.7 + 0.3 * Math.sin((2 * Math.PI * hum * i) / SR);
    else o[i] = a * 0.8 + randn() * 0.05; // AC: rumble + a little hiss
  }
  const g = fromDb(db) / (dsp.rms(o) || 1);
  for (let i = 0; i < WIN; i++) o[i] *= g;
  return o;
}
function randomBackground() {
  const r = rnd();
  if (r < 0.5) return { kind: 'quiet', db: -74 + rnd() * 16 }; // -74..-58
  if (r < 0.8) return { kind: 'fan', db: -56 + rnd() * 14 }; // -56..-42
  return { kind: 'ac', db: -60 + rnd() * 16 };
}

function features(win, bgDb) {
  const spec = dsp.melSpectrogram(win, { ...melOpts, melFb });
  const lift = Math.min(MAX_LOUDNESS_GAIN_DB, Math.max(0, CLASSIFY_FLOOR_DB - bgDb));
  return Array.from(
    extractFeatures(spec, { rms: dsp.rms(win) * fromDb(lift), peak: dsp.peakAbs(win), zcr: dsp.zcr(win) })
  );
}

// mix a 2 s source window into a random background at a random SNR
function mixed(src, label) {
  const bg = randomBackground();
  const w = background(bg.kind, bg.db);
  if (src) {
    const loud = dsp.maxFrameRms(src) || 1e-6;
    const target = Math.min(-15, bg.db + 4 + rnd() * 34); // 4..38 dB over the floor
    const g = fromDb(target) / loud;
    for (let i = 0; i < WIN; i++) w[i] += src[i] * g;
  }
  return { f: features(w, bg.db - 1), y: CLASSES.indexOf(label) };
}

// ---- data ----
const clips = { 1: [], 2: [], 3: [], 4: [], 5: [] };
for (const f of readdirSync(ESC).filter((x) => x.endsWith('.wav'))) {
  const [cat, fold] = f.split('__');
  const { samples, sampleRate } = readWavMono(join(ESC, f));
  const s = sampleRate === SR ? samples : resample(samples, sampleRate, SR);
  clips[Number(fold.slice(1))].push({ cat, s });
}
function windowsOf(s) {
  const out = [];
  const peak = dsp.maxFrameRms(s);
  for (let off = 0; off + WIN <= s.length; off += SR) {
    const w = s.slice(off, off + WIN);
    if (dsp.maxFrameRms(w) >= peak * 0.25) out.push(w);
  }
  return out;
}
function build(folds, reps, synthN) {
  const rows = [];
  for (const fold of folds) {
    for (const { cat, s } of clips[fold]) {
      const label = cat === 'snoring' ? 'snoring' : 'noise';
      // snoring is the minority class here: see it more often
      const r = label === 'snoring' ? reps * 4 : reps;
      for (const w of windowsOf(s)) for (let k = 0; k < r; k++) rows.push(mixed(w, label));
    }
  }
  for (let i = 0; i < synthN; i++) {
    rows.push(mixed(null, 'quiet'));
    rows.push(mixed(synthBruxism(2), 'bruxism'));
    if (i % 2 === 0) rows.push(mixed(synthSnoring(2), 'snoring'));
    if (i % 2 === 1) rows.push(mixed(synthGrindingBandNoise(2), 'noise'));
  }
  return rows;
}

console.log('building features ...');
const train = build([1, 2, 3], 2, 900);
const val = build([4], 1, 200);
const test = build([5], 1, 200);
console.log(`train ${train.length}  val ${val.length}  test ${test.length}`);

// ---- MLP (same layout as the shipped model) ----
const { mean, std } = MODEL;
const norm = (f) => f.map((v, k) => (v - mean[k]) / (std[k] || 1));
const clone = (L) => L.map((l) => ({ w: l.w.map((r) => r.slice()), b: l.b.slice(), act: l.act }));
const anchor = clone(MODEL.layers);
let layers = clone(MODEL.layers);

function forward(L, x, keep) {
  const acts = [x];
  let a = x;
  for (const l of L) {
    const z = l.b.slice();
    for (let i = 0; i < l.w.length; i++) {
      const ai = a[i];
      if (ai === 0) continue;
      const wi = l.w[i];
      for (let o = 0; o < z.length; o++) z[o] += wi[o] * ai;
    }
    if (l.act === 'relu') for (let o = 0; o < z.length; o++) z[o] = z[o] > 0 ? z[o] : 0;
    else {
      const mx = Math.max(...z);
      let Z = 0;
      for (let o = 0; o < z.length; o++) Z += z[o] = Math.exp(z[o] - mx);
      for (let o = 0; o < z.length; o++) z[o] /= Z;
    }
    a = z;
    if (keep) acts.push(z);
  }
  return keep ? acts : a;
}

const LR = 1e-3, B1 = 0.9, B2 = 0.999, EPS = 1e-8;
const ANCHOR = 2e-3; // pull towards the shipped weights
const SMOOTH = 0.05;
const freq = new Array(CLASSES.length).fill(0);
for (const r of train) freq[r.y]++;
const cw = freq.map((f) => train.length / (CLASSES.length * Math.max(1, f)));
const m1 = layers.map((l) => ({ w: l.w.map((r) => r.map(() => 0)), b: l.b.map(() => 0) }));
const m2 = layers.map((l) => ({ w: l.w.map((r) => r.map(() => 0)), b: l.b.map(() => 0) }));
let step = 0;

function trainBatch(batch) {
  const g = layers.map((l) => ({ w: l.w.map((r) => r.map(() => 0)), b: l.b.map(() => 0) }));
  for (const { x, y } of batch) {
    const acts = forward(layers, x, true);
    const out = acts[acts.length - 1];
    let delta = out.map((p, k) => (p - ((k === y ? 1 - SMOOTH : 0) + SMOOTH / out.length)) * cw[y]);
    for (let li = layers.length - 1; li >= 0; li--) {
      const a = acts[li];
      const l = layers[li];
      for (let o = 0; o < delta.length; o++) g[li].b[o] += delta[o];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === 0) continue;
        for (let o = 0; o < delta.length; o++) g[li].w[i][o] += a[i] * delta[o];
      }
      if (li > 0) {
        const nd = new Array(a.length).fill(0);
        for (let i = 0; i < a.length; i++) {
          if (a[i] <= 0) continue; // relu'
          let s = 0;
          for (let o = 0; o < delta.length; o++) s += l.w[i][o] * delta[o];
          nd[i] = s;
        }
        delta = nd;
      }
    }
  }
  step++;
  const n = batch.length;
  const c1 = 1 - Math.pow(B1, step), c2 = 1 - Math.pow(B2, step);
  layers.forEach((l, li) => {
    const upd = (val, grad, mm1, mm2, anc) => {
      const gr = grad / n + ANCHOR * (val - anc);
      const a1 = B1 * mm1 + (1 - B1) * gr;
      const a2 = B2 * mm2 + (1 - B2) * gr * gr;
      return [val - (LR * (a1 / c1)) / (Math.sqrt(a2 / c2) + EPS), a1, a2];
    };
    for (let i = 0; i < l.w.length; i++)
      for (let o = 0; o < l.w[i].length; o++) {
        const [v, a, b] = upd(l.w[i][o], g[li].w[i][o], m1[li].w[i][o], m2[li].w[i][o], anchor[li].w[i][o]);
        l.w[i][o] = v; m1[li].w[i][o] = a; m2[li].w[i][o] = b;
      }
    for (let o = 0; o < l.b.length; o++) {
      const [v, a, b] = upd(l.b[o], g[li].b[o], m1[li].b[o], m2[li].b[o], anchor[li].b[o]);
      l.b[o] = v; m1[li].b[o] = a; m2[li].b[o] = b;
    }
  });
}

const prep = (rows) => rows.map((r) => ({ x: norm(r.f), y: r.y }));
const T = prep(train), V = prep(val), S = prep(test);

function evaluate(L, rows) {
  const K = CLASSES.length;
  const conf = Array.from({ length: K }, () => new Array(K).fill(0));
  let loss = 0;
  for (const { x, y } of rows) {
    const p = forward(L, x, false);
    loss -= Math.log(Math.max(p[y], 1e-9));
    let arg = 0;
    for (let k = 1; k < K; k++) if (p[k] > p[arg]) arg = k;
    conf[y][arg]++;
  }
  const recall = conf.map((r, i) => r[i] / Math.max(1, r.reduce((a, b) => a + b, 0)));
  const prec = conf.map((_, j) => conf[j][j] / Math.max(1, conf.reduce((a, r) => a + r[j], 0)));
  const bal = recall.reduce((a, b) => a + b, 0) / K;
  return { loss: loss / rows.length, recall, prec, bal, conf };
}
const show = (tag, e) =>
  console.log(
    `${tag.padEnd(14)} balanced acc ${(e.bal * 100).toFixed(1)}%  ` +
      CLASSES.map((c, i) => `${c} R${(e.recall[i] * 100).toFixed(0)}/P${(e.prec[i] * 100).toFixed(0)}`).join('  ')
  );

show('before (test)', evaluate(MODEL.layers, S));
let best = { loss: evaluate(layers, V).loss, layers: clone(layers), epoch: -1 };
const EPOCHS = 30, BATCH = 64, PATIENCE = 6;
for (let ep = 0; ep < EPOCHS; ep++) {
  for (let i = T.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [T[i], T[j]] = [T[j], T[i]];
  }
  for (let i = 0; i < T.length; i += BATCH) trainBatch(T.slice(i, i + BATCH));
  const ev = evaluate(layers, V);
  console.log(`epoch ${ep}  val loss ${ev.loss.toFixed(4)}  val bal ${(ev.bal * 100).toFixed(1)}%`);
  if (ev.loss < best.loss) best = { loss: ev.loss, layers: clone(layers), epoch: ep };
  else if (ep - best.epoch >= PATIENCE) break;
}
layers = best.layers;
const after = evaluate(layers, S);
show('after (test)', after);
console.log('confusion (rows=true, cols=pred)', CLASSES.join(','), JSON.stringify(after.conf));

if (WRITE) {
  const round = (x) => Math.round(x * 1e6) / 1e6;
  const out = {
    ...MODEL,
    version: new Date().toISOString().slice(0, 10),
    layers: layers.map((l) => ({ w: l.w.map((r) => r.map(round)), b: l.b.map(round), act: l.act })),
    metrics: {
      ...(MODEL.metrics || {}),
      finetune: {
        data: 'ESC-50 folds 1-3 + synthetic, mixed at bedside levels over quiet/fan/AC',
        heldOutBalancedAccuracy: round(after.bal),
        heldOutSnoringRecall: round(after.recall[1]),
        heldOutSnoringPrecision: round(after.prec[1]),
      },
    },
  };
  writeFileSync(
    new URL('../js/model-weights.js', import.meta.url),
    `/* AUTO-GENERATED by training/train.mjs + training/finetune.mjs — do not edit by hand.\n` +
      ` * ${out.version}  fine-tuned for bedside levels; held-out balanced acc ${(after.bal * 100).toFixed(1)}%\n */\n` +
      `export const MODEL = ${JSON.stringify(out)};\nexport default MODEL;\n`
  );
  console.log('wrote js/model-weights.js');
}
