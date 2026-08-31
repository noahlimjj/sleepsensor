// Trains the SleepSensor classifier with TensorFlow.js and writes plain weights
// to js/model-weights.js (pure-JS inference in the browser — no tf at runtime).
//
//   node training/train.mjs
//
// Split is BY SOURCE FILE (no window leakage). Reports per-window and per-file
// (episode-level) accuracy plus a confusion matrix.
import { readFileSync, writeFileSync } from 'fs';
import tf from '@tensorflow/tfjs-node';
import { HmmSmoother } from '../js/smoothing.js';

const HERE = new URL('.', import.meta.url).pathname;
const CLASSES = ['quiet', 'snoring', 'bruxism', 'noise'];
const K = CLASSES.length;
const HIDDEN = [96, 48];
const DROPOUT = 0.5;
const L2 = 5e-4;
const MAX_EPOCHS = 300;
const PATIENCE = 45;
const BATCH = 64;
const LR = 4e-4;
const LABEL_SMOOTH = 0.06;
const SEED = 7;

tf.util.seed = tf.util.seed || (() => {});
let _s = SEED;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---- load ----
const raw = JSON.parse(readFileSync(HERE + 'features.json'));
const FN = raw.featureNames;
const D = FN.length;
const all = raw.samples.filter((s) => CLASSES.includes(s.label));
console.log(`${all.length} samples, ${D} features, aug=${raw.aug || 0}`);

// ---- group split by source file ----
const fileLabel = {};
const fileCount = {};
for (const s of all) {
  fileCount[s.src] = fileCount[s.src] || {};
  fileCount[s.src][s.label] = (fileCount[s.src][s.label] || 0) + 1;
}
for (const f in fileCount) {
  fileLabel[f] = Object.entries(fileCount[f]).sort((a, b) => b[1] - a[1])[0][0];
}
const filesByLabel = {};
for (const f in fileLabel) (filesByLabel[fileLabel[f]] ||= []).push(f);

const trainFiles = new Set();
const valFiles = new Set();
const testFiles = new Set();
for (const lbl of CLASSES) {
  const fs = shuffle((filesByLabel[lbl] || []).slice());
  const nTest = Math.max(1, Math.round(fs.length * 0.15));
  const nVal = Math.max(1, Math.round(fs.length * 0.15));
  fs.forEach((f, i) => {
    if (i < nTest) testFiles.add(f);
    else if (i < nTest + nVal) valFiles.add(f);
    else trainFiles.add(f);
  });
}

const inSplit = (set, allowAug) => all.filter((s) => set.has(s.src) && (allowAug || !s.aug));
const trainRows = shuffle(inSplit(trainFiles, true));
const valRows = inSplit(valFiles, false);
const testRows = inSplit(testFiles, false);
console.log(`split: train ${trainRows.length} (files ${trainFiles.size}), val ${valRows.length} (${valFiles.size}), test ${testRows.length} (${testFiles.size})`);

// ---- standardise on train ----
const mean = new Array(D).fill(0);
const std = new Array(D).fill(0);
for (const s of trainRows) for (let k = 0; k < D; k++) mean[k] += s.f[k];
for (let k = 0; k < D; k++) mean[k] /= trainRows.length;
for (const s of trainRows) for (let k = 0; k < D; k++) std[k] += (s.f[k] - mean[k]) ** 2;
for (let k = 0; k < D; k++) std[k] = Math.sqrt(std[k] / trainRows.length) || 1;

const X = (rows) => rows.map((s) => s.f.map((v, k) => (v - mean[k]) / std[k]));
const Y = (rows) => rows.map((s) => CLASSES.indexOf(s.label));

const xTrain = tf.tensor2d(X(trainRows));
// one-hot with label smoothing on the training targets
const yTrain = tf.oneHot(tf.tensor1d(Y(trainRows), 'int32'), K)
  .mul(1 - LABEL_SMOOTH)
  .add(LABEL_SMOOTH / K);
const xVal = tf.tensor2d(X(valRows));
const yVal = tf.oneHot(tf.tensor1d(Y(valRows), 'int32'), K);

// ---- class weights (inverse freq on train base rows) ----
const freq = new Array(K).fill(0);
trainRows.forEach((s) => freq[CLASSES.indexOf(s.label)]++);
const BOOST = { bruxism: 1.1, snoring: 1.1 };
const classWeight = {};
freq.forEach((f, i) => {
  classWeight[i] = (trainRows.length / (K * Math.max(1, f))) * (BOOST[CLASSES[i]] || 1);
});
console.log('class freq', freq, 'weights', Object.values(classWeight).map((v) => v.toFixed(2)));

// ---- model ----
const reg = tf.regularizers.l2({ l2: L2 });
const model = tf.sequential();
model.add(tf.layers.dense({ units: HIDDEN[0], activation: 'relu', inputShape: [D], kernelRegularizer: reg }));
model.add(tf.layers.dropout({ rate: DROPOUT }));
for (let i = 1; i < HIDDEN.length; i++) {
  model.add(tf.layers.dense({ units: HIDDEN[i], activation: 'relu', kernelRegularizer: reg }));
  model.add(tf.layers.dropout({ rate: DROPOUT }));
}
model.add(tf.layers.dense({ units: K, activation: 'softmax' }));
model.compile({ optimizer: tf.train.adam(LR), loss: 'categoricalCrossentropy', metrics: ['accuracy'] });

// ---- train w/ early stopping ----
let best = { loss: Infinity, weights: null, epoch: 0 };
let wait = 0;
for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
  const h = await model.fit(xTrain, yTrain, {
    epochs: 1,
    batchSize: BATCH,
    validationData: [xVal, yVal],
    classWeight,
    shuffle: true,
    verbose: 0,
  });
  const vl = h.history.val_loss[0];
  const va = h.history.val_acc?.[0] ?? h.history.val_accuracy?.[0];
  if (epoch % 20 === 0 || epoch === MAX_EPOCHS - 1) {
    console.log(`epoch ${String(epoch).padStart(3)}  val_loss ${vl.toFixed(4)}  val_acc ${(va * 100).toFixed(1)}%`);
  }
  if (vl < best.loss - 1e-4) {
    best = { loss: vl, epoch, weights: model.getWeights().map((w) => w.clone()) };
    wait = 0;
  } else if (++wait >= PATIENCE) {
    console.log(`early stop at epoch ${epoch} (best ${best.epoch}, val_loss ${best.loss.toFixed(4)})`);
    break;
  }
}
if (best.weights) model.setWeights(best.weights);

// ---- evaluate ----
function predictRows(rows) {
  const p = model.predict(tf.tensor2d(X(rows)));
  const arr = p.arraySync();
  p.dispose();
  return arr;
}
function confusion(rows, probs) {
  const c = Array.from({ length: K }, () => new Array(K).fill(0));
  rows.forEach((s, i) => {
    const t = CLASSES.indexOf(s.label);
    const a = probs[i].indexOf(Math.max(...probs[i]));
    c[t][a]++;
  });
  return c;
}
function printConf(c, title) {
  console.log(`\n${title} — rows=truth cols=pred`);
  console.log('           ' + CLASSES.map((x) => x.padStart(9)).join(''));
  let tot = 0;
  let cor = 0;
  c.forEach((row, i) => {
    const rt = row.reduce((a, b) => a + b, 0) || 1;
    tot += rt;
    cor += row[i];
    console.log(CLASSES[i].padStart(10) + ' ' + row.map((v) => String(v).padStart(9)).join('') + `   rec ${((row[i] / rt) * 100).toFixed(1)}%`);
  });
  for (let j = 0; j < K; j++) {
    let col = 0;
    for (let i = 0; i < K; i++) col += c[i][j];
    console.log(`  prec ${CLASSES[j].padStart(8)} ${((c[j][j] / (col || 1)) * 100).toFixed(1)}%`);
  }
  console.log(`  overall ${((cor / tot) * 100).toFixed(2)}%`);
  return cor / tot;
}

const testProbs = predictRows(testRows);
const winAcc = printConf(confusion(testRows, testProbs), 'TEST per-window');

// per-file (episode-level): average probs across a file's windows
const fileAgg = {};
testRows.forEach((s, i) => {
  (fileAgg[s.src] ||= { label: s.label, sum: new Array(K).fill(0), n: 0 });
  testProbs[i].forEach((v, k) => (fileAgg[s.src].sum[k] += v));
  fileAgg[s.src].n++;
});
let fCor = 0;
let fTot = 0;
const fConf = Array.from({ length: K }, () => new Array(K).fill(0));
for (const f in fileAgg) {
  const g = fileAgg[f];
  const avg = g.sum.map((v) => v / g.n);
  const pred = avg.indexOf(Math.max(...avg));
  const t = CLASSES.indexOf(g.label);
  fConf[t][pred]++;
  fTot++;
  if (pred === t) fCor++;
}
const fileAcc = printConf(fConf, 'TEST per-file (mean-prob)');

// episode-level via the SAME HmmSmoother the app runs
const order = {};
testRows.forEach((s, i) => ((order[s.src] ||= []).push({ i, s })));
let sCor = 0;
let sTot = 0;
const sConf = Array.from({ length: K }, () => new Array(K).fill(0));
for (const f in order) {
  const sm = new HmmSmoother({ classes: CLASSES });
  let last;
  for (const { i } of order[f]) {
    const scores = {};
    CLASSES.forEach((c, k) => (scores[c] = testProbs[i][k]));
    last = sm.push(scores);
  }
  const pred = CLASSES.indexOf(last.type);
  const t = CLASSES.indexOf(order[f][0].s.label);
  sConf[t][pred]++;
  sTot++;
  if (pred === t) sCor++;
}
const smoothAcc = printConf(sConf, 'TEST per-episode (HMM-smoothed, as shipped)');

// ---- export plain weights ----
const dense = model.layers.filter((l) => l.getClassName() === 'Dense');
const layers = dense.map((l) => {
  const [w, b] = l.getWeights();
  return {
    w: w.arraySync(), // [in][out]
    b: b.arraySync(),
    act: l.getConfig().activation,
  };
});
const round = (x) => Math.round(x * 1e6) / 1e6;
const model_out = {
  version: new Date().toISOString().slice(0, 10),
  classes: CLASSES,
  featureNames: FN,
  mean: mean.map(round),
  std: std.map(round),
  layers: layers.map((L) => ({
    w: L.w.map((row) => row.map(round)),
    b: L.b.map(round),
    act: L.act,
  })),
  metrics: {
    testWindowAccuracy: round(winAcc),
    testFileAccuracy: round(fileAcc),
    testEpisodeAccuracy: round(smoothAcc),
    testWindows: testRows.length,
    testFiles: fTot,
    trainedOn: all.length,
  },
};
writeFileSync(
  HERE + '../js/model-weights.js',
  `/* AUTO-GENERATED by training/train.mjs — do not edit by hand.\n` +
    ` * ${model_out.version}  per-window ${(winAcc * 100).toFixed(1)}%  per-episode(HMM) ${(smoothAcc * 100).toFixed(1)}%\n` +
    ` * (speaker/recording-independent test split)\n */\n` +
    `export const MODEL = ${JSON.stringify(model_out)};\nexport default MODEL;\n`
);
console.log(`\nwrote js/model-weights.js  (per-window ${(winAcc * 100).toFixed(1)}%, per-episode ${(smoothAcc * 100).toFixed(1)}%)`);
