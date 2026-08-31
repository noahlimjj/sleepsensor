// Validates the trained model in js/model-weights.js by replaying the held-out
// (recording-independent) feature split through the SAME inference code the
// browser runs. Guards against a regressed / corrupt weights file and against
// the snoring<->bruxism confusion the model exists to reduce.
import { readFileSync, existsSync } from 'fs';
import { section, ok, pass, eq } from './lib.mjs';
import { Classifier } from '../js/classifier.js';
import { MODEL } from '../js/model-weights.js';
import { HmmSmoother } from '../js/smoothing.js';

const FEATURES = new URL('../training/features.json', import.meta.url);

export function run() {
  section('model-weights.js — trained classifier');

  ok(MODEL && Array.isArray(MODEL.layers) && MODEL.layers.length >= 2, 'model has stacked dense layers');
  eq(MODEL.classes.join(','), 'quiet,snoring,bruxism,noise', 'expected class order');
  eq(MODEL.layers[0].w.length, MODEL.featureNames.length, 'first layer input width == feature count');
  eq(MODEL.layers[MODEL.layers.length - 1].b.length, MODEL.classes.length, 'last layer output width == class count');
  eq(MODEL.layers[MODEL.layers.length - 1].act, 'softmax', 'output activation is softmax');
  ok(MODEL.metrics.testWindowAccuracy > 0.75, `per-window test acc > 75% (${(MODEL.metrics.testWindowAccuracy * 100).toFixed(1)}%)`);
  ok((MODEL.metrics.testEpisodeAccuracy ?? MODEL.metrics.testFileAccuracy) > 0.85, `per-episode acc > 85% (${(((MODEL.metrics.testEpisodeAccuracy ?? MODEL.metrics.testFileAccuracy)) * 100).toFixed(1)}%)`);

  const c = new Classifier();
  ok(c.usingModel, 'Classifier picks up the trained model');

  if (!existsSync(FEATURES)) {
    console.log('  (training/features.json absent — skipping replay)');
    pass('model weights structurally valid');
    return;
  }

  const data = JSON.parse(readFileSync(FEATURES));
  const K = MODEL.classes.length;

  // recording-independent holdout: bucket files by a stable hash, take ~18%
  const fileHash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 100;
  };
  const holdout = data.samples.filter((s) => !s.aug && fileHash(s.src) < 18 && MODEL.classes.includes(s.label));
  ok(holdout.length > 100, `holdout has samples (${holdout.length})`);

  // per-window confusion
  const conf = Array.from({ length: K }, () => new Array(K).fill(0));
  const byFile = {};
  for (const s of holdout) {
    const t = MODEL.classes.indexOf(s.label);
    const p = c._infer(Float32Array.from(s.f));
    let arg = 0;
    for (let k = 1; k < K; k++) if (p[k] > p[arg]) arg = k;
    conf[t][arg]++;
    (byFile[s.src] ||= { t, sum: new Array(K).fill(0), n: 0 });
    p.forEach((v, k) => (byFile[s.src].sum[k] += v));
    byFile[s.src].n++;
  }
  const acc = diag(conf) / sum(conf);
  console.log('  per-window holdout confusion:', JSON.stringify(MODEL.classes));
  conf.forEach((r, i) => console.log(`    ${MODEL.classes[i].padStart(8)} ${JSON.stringify(r)}`));

  // per-file (episode) via averaged probs + HMM-style smoothing check
  let fCor = 0;
  let fTot = 0;
  for (const f in byFile) {
    const g = byFile[f];
    const avg = g.sum.map((v) => v / g.n);
    let arg = 0;
    for (let k = 1; k < K; k++) if (avg[k] > avg[arg]) arg = k;
    fTot++;
    if (arg === g.t) fCor++;
  }
  const fileAcc = fTot ? fCor / fTot : 0;
  console.log(`  per-window ${(acc * 100).toFixed(1)}%   per-file ${(fileAcc * 100).toFixed(1)}% (${fTot} files)`);

  ok(acc > 0.78, `per-window holdout accuracy > 78% (${(acc * 100).toFixed(1)}%)`);
  ok(fileAcc > 0.85, `per-file holdout accuracy > 85% (${(fileAcc * 100).toFixed(1)}%)`);

  const si = MODEL.classes.indexOf('snoring');
  const bi = MODEL.classes.indexOf('bruxism');
  const sTot = sum([conf[si]]) || 1;
  const bTot = sum([conf[bi]]) || 1;
  ok(conf[si][si] / sTot > 0.8, `snoring recall > 80% (${((conf[si][si] / sTot) * 100).toFixed(0)}%)`);
  ok(conf[bi][bi] / bTot > 0.65, `bruxism recall > 65% (${((conf[bi][bi] / bTot) * 100).toFixed(0)}%)`);
  ok(conf[si][bi] / sTot < 0.12, `snoring→bruxism < 12% (${((conf[si][bi] / sTot) * 100).toFixed(1)}%)`);
  ok(conf[bi][si] / bTot < 0.25, `bruxism→snoring < 25% (${((conf[bi][si] / bTot) * 100).toFixed(1)}%)`);

  // smoothing must not degrade a clean stream
  const sm = new HmmSmoother({ classes: MODEL.classes });
  let smOut;
  for (let i = 0; i < 6; i++) smOut = sm.push({ snoring: 0.8, noise: 0.2 });
  eq(smOut.type, 'snoring', 'smoother locks onto a steady snoring stream');

  pass('trained model + smoother classify reliably');
}

function diag(c) {
  let s = 0;
  for (let i = 0; i < c.length; i++) s += c[i][i];
  return s;
}
function sum(c) {
  let s = 0;
  for (const r of c) for (const v of r) s += v;
  return s;
}
