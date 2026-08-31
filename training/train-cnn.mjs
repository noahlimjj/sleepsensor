// Trains a small CNN on log-mel spectrograms and exports a TF.js LayersModel to
// js/model-cnn/ (loaded in the browser with tf.loadLayersModel — tf.js is
// already on the page). This is the high-accuracy path; the feature MLP in
// model-weights.js stays as a fallback.
//
//   node --max-old-space-size=4096 training/train-cnn.mjs [--aug 2]
import { readdirSync, existsSync, statSync, rmSync } from 'fs';
import { join, basename } from 'path';
import tf from '@tensorflow/tfjs-node';
import { readWavMono, resample } from './wav.mjs';
import { dsp } from '../tests/load-worklet.mjs';
import { synthBruxism, synthSnoring } from './synth.mjs';

const AUG = argNum('--aug', 2);
const SR = 16000;
const WIN = SR * 2;
const HOP = Math.round(SR * 1.5);
const MELS = 48;
const FRAMES = 48;
const EDGE = SR * 2;
const MAX_WIN = 22;
const EPOCHS = argNum('--epochs', 90);
const PATIENCE = argNum('--patience', 14);
const CLASSES = ['quiet', 'snoring', 'bruxism', 'noise'];
const K = CLASSES.length;
const HERE = new URL('.', import.meta.url).pathname;
const DS = join(HERE, '_snoredet/Snoring_Dataset_@16000');
const YT = join(HERE, 'audio');
const OUT = join(HERE, '../js/model-cnn');
const melOpts = { fftSize: 512, hop: 256, numMel: MELS, timeSteps: FRAMES, sampleRate: SR };

let _s = 7;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const randn = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
function argNum(f, d) {
  const i = process.argv.indexOf(f);
  return i >= 0 ? parseFloat(process.argv[i + 1]) : d;
}

// ---------- collect windows: { mel, label, group, aug } ----------
const rows = [];
const melOf = (win) => dsp.melSpectrogram(win, melOpts); // log + normalised [0,1]

function augWave(w) {
  const out = new Float32Array(w.length);
  const gain = Math.pow(10, (rnd() * 10 - 5) / 20);
  const nAmp = dsp.rms(w) * (0.03 + rnd() * 0.18);
  const shift = ((rnd() * 0.2 - 0.1) * w.length) | 0;
  for (let i = 0; i < w.length; i++) {
    const j = i + shift;
    out[i] = (j >= 0 && j < w.length ? w[j] : 0) * gain + randn() * nAmp;
  }
  return out;
}
function specMask(m) {
  const out = Float32Array.from(m);
  const fW = (rnd() * 12) | 0;
  const f0 = (rnd() * (MELS - fW)) | 0;
  for (let f = f0; f < f0 + fW; f++) for (let t = 0; t < FRAMES; t++) out[f * FRAMES + t] = 0;
  const tW = (rnd() * 12) | 0;
  const t0 = (rnd() * (FRAMES - tW)) | 0;
  for (let t = t0; t < t0 + tW; t++) for (let f = 0; f < MELS; f++) out[f * FRAMES + t] = 0;
  return out;
}
function add(win, label, group, augCount) {
  const li = CLASSES.indexOf(label);
  rows.push({ mel: melOf(win), y: li, g: group, aug: 0 });
  for (let a = 1; a <= augCount; a++) rows.push({ mel: specMask(melOf(augWave(win))), y: li, g: group, aug: a });
}
function windowsOf(sig, trim) {
  if (sig.length <= WIN) {
    const w = new Float32Array(WIN);
    for (let i = 0; i < WIN; i++) {
      const p = i % (2 * sig.length);
      w[i] = p < sig.length ? sig[p] : sig[2 * sig.length - 1 - p];
    }
    return [w];
  }
  const out = [];
  const s0 = trim ? EDGE : 0;
  const s1 = trim ? sig.length - EDGE : sig.length;
  for (let s = s0; s + WIN <= s1 && out.length < MAX_WIN; s += HOP) out.push(sig.subarray(s, s + WIN));
  return out;
}
function ingest(dir, labeller, { trim = true, gate = 0.008, aug = AUG, cap = Infinity, stride = 1 } = {}) {
  if (!existsSync(dir)) return;
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.wav')) files.push(p);
    }
  })(dir);
  let used = 0;
  for (let i = 0; i < files.length && used < cap; i += stride) {
    let sig;
    try {
      const a = readWavMono(files[i]);
      sig = a.sampleRate === SR ? a.samples : resample(a.samples, a.sampleRate, SR);
    } catch {
      continue;
    }
    const g = basename(files[i], '.wav');
    for (const w of windowsOf(sig, trim)) {
      const r = dsp.rms(w);
      const lbl = typeof labeller === 'function' ? labeller(r) : labeller;
      if (!lbl || r < 1e-4) continue;
      if ((lbl === 'snoring' || lbl === 'bruxism') && r < gate) continue;
      add(w, lbl, g, aug);
      if (++used >= cap) break;
    }
  }
  console.log(`  ${dir.replace(HERE, '')} -> ${used}`);
}

console.log(`building mel dataset (aug=${AUG}) ...`);
ingest(join(DS, 'snoring'), 'snoring', { trim: false, gate: 0.005 });
ingest(join(YT, 'snoring'), (r) => (r > 0.01 ? 'snoring' : null));
ingest(join(YT, 'bruxism'), (r) => (r > 0.008 ? 'bruxism' : null), { aug: AUG + 1 });
ingest(join(DS, 'no_snoring'), (r) => (r > 0.012 ? 'noise' : 'quiet'), { trim: false });
ingest(join(YT, 'other'), (r) => (r > 0.02 ? 'noise' : 'quiet'));
for (const wd of ['house', 'learn', 'left', 'marvin', 'one']) ingest(join(DS, wd), 'noise', { trim: false, cap: 60, stride: 20, aug: 0 });
ingest(join(DS, '_background_noise_'), (r) => (r < 0.03 ? 'quiet' : 'noise'), { trim: false });

for (let i = 0; i < 300; i++) add(synthBruxism(2), 'bruxism', `synbrux${i % 30}`, 1);
for (let i = 0; i < 160; i++) add(synthSnoring(2), 'snoring', `synsnore${i % 20}`, 1);
for (let i = 0; i < 220; i++) {
  const w = new Float32Array(WIN);
  const lvl = 1e-4 + rnd() * 3e-3;
  for (let j = 0; j < WIN; j++) w[j] = randn() * lvl;
  add(w, 'quiet', `synq${i % 15}`, 0);
}

const cnt = {};
rows.forEach((r) => (cnt[CLASSES[r.y]] = (cnt[CLASSES[r.y]] || 0) + 1));
console.log(`\n${rows.length} windows`, cnt);

// ---------- group split ----------
const gl = {};
rows.forEach((r) => ((gl[r.g] ||= {}), (gl[r.g][r.y] = (gl[r.g][r.y] || 0) + 1)));
const gMaj = {};
for (const g in gl) gMaj[g] = +Object.entries(gl[g]).sort((a, b) => b[1] - a[1])[0][0];
const byLbl = {};
for (const g in gMaj) (byLbl[gMaj[g]] ||= []).push(g);
const testG = new Set();
const valG = new Set();
for (const l in byLbl) {
  const gs = byLbl[l].slice();
  for (let i = gs.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [gs[i], gs[j]] = [gs[j], gs[i]];
  }
  const nt = Math.max(1, Math.round(gs.length * 0.16));
  const nv = Math.max(1, Math.round(gs.length * 0.16));
  gs.forEach((g, i) => (i < nt ? testG.add(g) : i < nt + nv ? valG.add(g) : null));
}
const split = (pred) => rows.filter(pred);
const trainRows = split((r) => !testG.has(r.g) && !valG.has(r.g));
const valRows = split((r) => valG.has(r.g) && !r.aug);
const testRows = split((r) => testG.has(r.g) && !r.aug);
console.log(`split: train ${trainRows.length}  val ${valRows.length}  test ${testRows.length}`);

const stack = (list) => {
  const x = new Float32Array(list.length * MELS * FRAMES);
  const y = new Int32Array(list.length);
  list.forEach((r, k) => {
    x.set(r.mel, k * MELS * FRAMES);
    y[k] = r.y;
  });
  return { x: tf.tensor4d(x, [list.length, MELS, FRAMES, 1]), y: tf.oneHot(tf.tensor1d(y, 'int32'), K) };
};
const tr = stack(trainRows);
const va = stack(valRows);

// ---------- class weights ----------
const freq = new Array(K).fill(0);
trainRows.forEach((r) => freq[r.y]++);
const BOOST = { bruxism: 1.5, snoring: 1.1 };
const classWeight = {};
freq.forEach((f, i) => (classWeight[i] = (trainRows.length / (K * Math.max(1, f))) * (BOOST[CLASSES[i]] || 1)));
console.log('freq', freq, 'w', Object.values(classWeight).map((v) => v.toFixed(2)));

// ---------- model ----------
const L2 = tf.regularizers.l2({ l2: 2e-4 });
const conv = (f) => ({ filters: f, kernelSize: 3, padding: 'same', kernelRegularizer: L2 });
const m = tf.sequential();
m.add(tf.layers.conv2d({ ...conv(12), inputShape: [MELS, FRAMES, 1] }));
m.add(tf.layers.batchNormalization());
m.add(tf.layers.reLU());
m.add(tf.layers.maxPooling2d({ poolSize: 2 }));
m.add(tf.layers.conv2d(conv(24)));
m.add(tf.layers.batchNormalization());
m.add(tf.layers.reLU());
m.add(tf.layers.maxPooling2d({ poolSize: 2 }));
m.add(tf.layers.conv2d(conv(32)));
m.add(tf.layers.batchNormalization());
m.add(tf.layers.reLU());
m.add(tf.layers.globalAveragePooling2d({}));
m.add(tf.layers.dropout({ rate: 0.45 }));
m.add(tf.layers.dense({ units: 32, activation: 'relu', kernelRegularizer: L2 }));
m.add(tf.layers.dropout({ rate: 0.45 }));
m.add(tf.layers.dense({ units: K, activation: 'softmax' }));
m.compile({ optimizer: tf.train.adam(1.2e-3), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });
console.log('params', m.countParams());

// ---------- train ----------
let best = { loss: Infinity, w: null, epoch: 0 };
let wait = 0;
for (let e = 0; e < EPOCHS; e++) {
  const h = await m.fit(tr.x, tr.y, { epochs: 1, batchSize: 64, validationData: [va.x, va.y], classWeight, shuffle: true, verbose: 0 });
  const vl = h.history.val_loss[0];
  const vacc = h.history.val_acc?.[0] ?? h.history.val_accuracy?.[0];
  if (e % 5 === 0) console.log(`epoch ${String(e).padStart(3)}  val_loss ${vl.toFixed(4)}  val_acc ${(vacc * 100).toFixed(1)}%`);
  if (vl < best.loss - 1e-4) {
    best = { loss: vl, epoch: e, w: m.getWeights().map((t) => t.clone()) };
    wait = 0;
  } else if (++wait >= PATIENCE) {
    console.log(`early stop @${e} (best ${best.epoch})`);
    break;
  }
}
if (best.w) m.setWeights(best.w);

// ---------- evaluate ----------
function evalRows(list, title) {
  const { x } = stack(list);
  const p = m.predict(x).arraySync();
  x.dispose();
  const c = Array.from({ length: K }, () => new Array(K).fill(0));
  list.forEach((r, i) => {
    let a = 0;
    for (let k = 1; k < K; k++) if (p[i][k] > p[i][a]) a = k;
    c[r.y][a]++;
  });
  console.log(`\n${title} — rows=truth cols=pred  ${JSON.stringify(CLASSES)}`);
  let tot = 0;
  let cor = 0;
  c.forEach((row, i) => {
    const rt = row.reduce((s, v) => s + v, 0) || 1;
    tot += rt;
    cor += row[i];
    console.log(`  ${CLASSES[i].padStart(8)} ${row.map((v) => String(v).padStart(6)).join('')}  rec ${((row[i] / rt) * 100).toFixed(1)}%`);
  });
  for (let j = 0; j < K; j++) {
    let col = 0;
    for (let i = 0; i < K; i++) col += c[i][j];
    console.log(`    prec ${CLASSES[j].padStart(8)} ${((c[j][j] / (col || 1)) * 100).toFixed(1)}%`);
  }
  console.log(`  overall ${((cor / tot) * 100).toFixed(2)}%`);
  return { acc: cor / tot, probs: p, conf: c };
}
const test = evalRows(testRows, 'TEST per-window');

// per-file
const fa = {};
testRows.forEach((r, i) => {
  (fa[r.g] ||= { y: r.y, s: new Array(K).fill(0), n: 0 });
  test.probs[i].forEach((v, k) => (fa[r.g].s[k] += v));
  fa[r.g].n++;
});
let fc = 0;
let ft = 0;
const fConf = Array.from({ length: K }, () => new Array(K).fill(0));
for (const g in fa) {
  const o = fa[g];
  const avg = o.s.map((v) => v / o.n);
  let a = 0;
  for (let k = 1; k < K; k++) if (avg[k] > avg[a]) a = k;
  fConf[o.y][a]++;
  ft++;
  if (a === o.y) fc++;
}
console.log('\nTEST per-file confusion:');
fConf.forEach((row, i) => console.log(`  ${CLASSES[i].padStart(8)} ${JSON.stringify(row)}`));
const fileAcc = fc / ft;
console.log(`per-file accuracy ${(fileAcc * 100).toFixed(1)}% (${ft} files)`);

// ---------- export ----------
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
await m.save('file://' + OUT);
const fs = await import('fs');
fs.writeFileSync(
  join(OUT, 'meta.json'),
  JSON.stringify({
    classes: CLASSES,
    mels: MELS,
    frames: FRAMES,
    version: new Date().toISOString().slice(0, 10),
    metrics: { testWindowAccuracy: round(test.acc), testFileAccuracy: round(fileAcc), testFiles: ft, trainedOn: rows.length },
  })
);
console.log(`\nsaved js/model-cnn/  (per-window ${(test.acc * 100).toFixed(1)}%, per-file ${(fileAcc * 100).toFixed(1)}%)`);
function round(x) {
  return Math.round(x * 1e4) / 1e4;
}
