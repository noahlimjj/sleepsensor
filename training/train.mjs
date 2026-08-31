// Trains a tiny MLP (features -> 1 hidden layer -> softmax) on training/features.json
// and writes js/model-weights.js. Pure JS, no dependencies.
//
//   node training/train.mjs
import { readFileSync, writeFileSync } from 'fs';

const HERE = new URL('.', import.meta.url).pathname;
const CLASSES = ['quiet', 'snoring', 'bruxism', 'noise'];
const HIDDEN = 24;
const EPOCHS = 400;
const LR = 0.01;
const L2 = 1e-4;
const SEED = 42;
const VAL_FRAC = 0.2;

// ---- rng ----
let _s = SEED;
const rand = () => {
  _s = (_s * 1664525 + 1013904223) >>> 0;
  return _s / 4294967296;
};
const randn = () => {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// ---- data ----
const raw = JSON.parse(readFileSync(HERE + 'features.json'));
const FN = raw.featureNames;
const D = FN.length;
const all = raw.samples.filter((s) => CLASSES.includes(s.label));

// shuffle
for (let i = all.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [all[i], all[j]] = [all[j], all[i]];
}

// standardisation (fit on all)
const mean = new Array(D).fill(0);
const std = new Array(D).fill(0);
for (const s of all) for (let k = 0; k < D; k++) mean[k] += s.f[k];
for (let k = 0; k < D; k++) mean[k] /= all.length;
for (const s of all) for (let k = 0; k < D; k++) std[k] += (s.f[k] - mean[k]) ** 2;
for (let k = 0; k < D; k++) std[k] = Math.sqrt(std[k] / all.length) || 1;

const X = all.map((s) => s.f.map((v, k) => (v - mean[k]) / std[k]));
const y = all.map((s) => CLASSES.indexOf(s.label));

// stratified split
const idxByClass = CLASSES.map((_, c) => y.map((v, i) => (v === c ? i : -1)).filter((i) => i >= 0));
const trainIdx = [];
const valIdx = [];
for (const list of idxByClass) {
  const cut = Math.floor(list.length * (1 - VAL_FRAC));
  list.forEach((i, k) => (k < cut ? trainIdx : valIdx).push(i));
}

// class weights (inverse frequency, normalised)
const freq = new Array(CLASSES.length).fill(0);
trainIdx.forEach((i) => freq[y[i]]++);
const cw = freq.map((f) => trainIdx.length / (CLASSES.length * Math.max(1, f)));

// ---- params ----
const K = CLASSES.length;
let W1 = Array.from({ length: HIDDEN }, () => Array.from({ length: D }, () => randn() * Math.sqrt(2 / D)));
let b1 = new Array(HIDDEN).fill(0);
let W2 = Array.from({ length: K }, () => Array.from({ length: HIDDEN }, () => randn() * Math.sqrt(2 / HIDDEN)));
let b2 = new Array(K).fill(0);

// adam state
const mk = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));
const mW1 = mk(HIDDEN, D);
const vW1 = mk(HIDDEN, D);
const mb1 = new Array(HIDDEN).fill(0);
const vb1 = new Array(HIDDEN).fill(0);
const mW2 = mk(K, HIDDEN);
const vW2 = mk(K, HIDDEN);
const mb2 = new Array(K).fill(0);
const vb2 = new Array(K).fill(0);
const B1 = 0.9;
const B2 = 0.999;
const EPS = 1e-8;

function forward(x) {
  const h = new Array(HIDDEN);
  const hpre = new Array(HIDDEN);
  for (let j = 0; j < HIDDEN; j++) {
    let s = b1[j];
    const w = W1[j];
    for (let k = 0; k < D; k++) s += w[k] * x[k];
    hpre[j] = s;
    h[j] = s > 0 ? s : 0;
  }
  const logit = new Array(K);
  for (let c = 0; c < K; c++) {
    let s = b2[c];
    const w = W2[c];
    for (let j = 0; j < HIDDEN; j++) s += w[j] * h[j];
    logit[c] = s;
  }
  const mx = Math.max(...logit);
  let Z = 0;
  const p = logit.map((l) => {
    const e = Math.exp(l - mx);
    Z += e;
    return e;
  });
  for (let c = 0; c < K; c++) p[c] /= Z;
  return { h, hpre, p };
}

let t = 0;
function step(batch) {
  const gW1 = mk(HIDDEN, D);
  const gb1 = new Array(HIDDEN).fill(0);
  const gW2 = mk(K, HIDDEN);
  const gb2 = new Array(K).fill(0);
  let loss = 0;

  for (const i of batch) {
    const x = X[i];
    const target = y[i];
    const wgt = cw[target];
    const { h, hpre, p } = forward(x);
    loss -= wgt * Math.log(Math.max(p[target], 1e-12));

    const dlogit = p.slice();
    dlogit[target] -= 1;
    for (let c = 0; c < K; c++) dlogit[c] *= wgt;

    const dh = new Array(HIDDEN).fill(0);
    for (let c = 0; c < K; c++) {
      gb2[c] += dlogit[c];
      const w = W2[c];
      const g = gW2[c];
      for (let j = 0; j < HIDDEN; j++) {
        g[j] += dlogit[c] * h[j];
        dh[j] += dlogit[c] * w[j];
      }
    }
    for (let j = 0; j < HIDDEN; j++) {
      if (hpre[j] <= 0) continue;
      const d = dh[j];
      gb1[j] += d;
      const g = gW1[j];
      for (let k = 0; k < D; k++) g[k] += d * x[k];
    }
  }

  const n = batch.length;
  t++;
  const adam = (P, G, M, V, r, c) => {
    for (let a = 0; a < r; a++) {
      for (let bb = 0; bb < c; bb++) {
        let g = G[a][bb] / n + L2 * P[a][bb];
        M[a][bb] = B1 * M[a][bb] + (1 - B1) * g;
        V[a][bb] = B2 * V[a][bb] + (1 - B2) * g * g;
        const mh = M[a][bb] / (1 - B1 ** t);
        const vh = V[a][bb] / (1 - B2 ** t);
        P[a][bb] -= (LR * mh) / (Math.sqrt(vh) + EPS);
      }
    }
  };
  const adamV = (P, G, M, V) => {
    for (let a = 0; a < P.length; a++) {
      const g = G[a] / n;
      M[a] = B1 * M[a] + (1 - B1) * g;
      V[a] = B2 * V[a] + (1 - B2) * g * g;
      const mh = M[a] / (1 - B1 ** t);
      const vh = V[a] / (1 - B2 ** t);
      P[a] -= (LR * mh) / (Math.sqrt(vh) + EPS);
    }
  };
  adam(W1, gW1, mW1, vW1, HIDDEN, D);
  adamV(b1, gb1, mb1, vb1);
  adam(W2, gW2, mW2, vW2, K, HIDDEN);
  adamV(b2, gb2, mb2, vb2);
  return loss / n;
}

function evaluate(idx) {
  const conf = Array.from({ length: K }, () => new Array(K).fill(0));
  for (const i of idx) {
    const { p } = forward(X[i]);
    let arg = 0;
    for (let c = 1; c < K; c++) if (p[c] > p[arg]) arg = c;
    conf[y[i]][arg]++;
  }
  let correct = 0;
  let total = 0;
  for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
    if (a === b) correct += conf[a][b];
    total += conf[a][b];
  }
  return { conf, acc: correct / total };
}

// ---- train ----
const BATCH = 64;
let best = null;
for (let e = 0; e < EPOCHS; e++) {
  for (let i = trainIdx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [trainIdx[i], trainIdx[j]] = [trainIdx[j], trainIdx[i]];
  }
  let l = 0;
  let nb = 0;
  for (let s = 0; s < trainIdx.length; s += BATCH) {
    l += step(trainIdx.slice(s, s + BATCH));
    nb++;
  }
  if (e % 40 === 0 || e === EPOCHS - 1) {
    const tr = evaluate(trainIdx);
    const va = evaluate(valIdx);
    console.log(
      `epoch ${String(e).padStart(3)}  loss ${(l / nb).toFixed(3)}  train ${(tr.acc * 100).toFixed(1)}%  val ${(va.acc * 100).toFixed(1)}%`
    );
    if (!best || va.acc >= best.acc) {
      best = {
        acc: va.acc,
        conf: va.conf,
        W1: W1.map((r) => r.slice()),
        b1: b1.slice(),
        W2: W2.map((r) => r.slice()),
        b2: b2.slice(),
      };
    }
  }
}

// ---- report ----
const va = evaluate(valIdx);
const use = best && best.acc >= va.acc ? best : { ...va, W1, b1, W2, b2 };
console.log('\nconfusion matrix (val) — rows = truth, cols = predicted');
console.log('           ' + CLASSES.map((c) => c.padStart(8)).join(''));
use.conf.forEach((row, i) => {
  const tot = row.reduce((a, b) => a + b, 0) || 1;
  console.log(
    CLASSES[i].padStart(10) + ' ' + row.map((v) => String(v).padStart(8)).join('') +
      `   recall ${((row[i] / tot) * 100).toFixed(1)}%`
  );
});
for (let c = 0; c < K; c++) {
  let col = 0;
  for (let r = 0; r < K; r++) col += use.conf[r][c];
  console.log(`  precision ${CLASSES[c].padStart(8)}: ${((use.conf[c][c] / (col || 1)) * 100).toFixed(1)}%`);
}
console.log(`\noverall val accuracy: ${(use.acc * 100).toFixed(2)}%`);

// ---- emit js/model-weights.js ----
const round = (x) => Math.round(x * 1e6) / 1e6;
const model = {
  version: new Date().toISOString().slice(0, 10),
  classes: CLASSES,
  featureNames: FN,
  hidden: HIDDEN,
  mean: mean.map(round),
  std: std.map(round),
  w1: use.W1.map((r) => r.map(round)),
  b1: use.b1.map(round),
  w2: use.W2.map((r) => r.map(round)),
  b2: use.b2.map(round),
  metrics: {
    valAccuracy: round(use.acc),
    confusion: use.conf,
    trainedOn: raw.samples.length,
  },
};
writeFileSync(
  HERE + '../js/model-weights.js',
  `/* AUTO-GENERATED by training/train.mjs — do not edit by hand.\n` +
    ` * ${model.version}  val accuracy ${(use.acc * 100).toFixed(1)}%  (${raw.samples.length} windows)\n */\n` +
    `export const MODEL = ${JSON.stringify(model, null, 0)};\nexport default MODEL;\n`
);
console.log('\nwrote js/model-weights.js');
