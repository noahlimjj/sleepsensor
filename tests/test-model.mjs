// Validates the trained model shipped in js/model-weights.js by replaying a
// held-out slice of the real training features through the SAME inference code
// the browser runs (Classifier._infer). Guards against a regressed / corrupt
// weights file and against the snoring<->bruxism confusion the model exists to fix.
import { readFileSync, existsSync } from 'fs';
import { section, ok, pass, eq } from './lib.mjs';
import { Classifier } from '../js/classifier.js';
import { MODEL } from '../js/model-weights.js';

const FEATURES = new URL('../training/features.json', import.meta.url);

export function run() {
  section('model-weights.js — trained classifier');

  ok(MODEL && Array.isArray(MODEL.w1), 'model weights load');
  eq(MODEL.classes.join(','), 'quiet,snoring,bruxism,noise', 'expected class order');
  eq(MODEL.w1[0].length, MODEL.featureNames.length, 'w1 input width == feature count');
  eq(MODEL.w2.length, MODEL.classes.length, 'w2 output width == class count');
  ok(MODEL.metrics.valAccuracy > 0.85, `reported val accuracy > 85% (${(MODEL.metrics.valAccuracy * 100).toFixed(1)}%)`);

  const c = new Classifier();
  ok(c.usingModel, 'Classifier picks up the trained model');

  if (!existsSync(FEATURES)) {
    console.log('  (training/features.json absent — skipping replay; run npm run train:data)');
    pass('model weights structurally valid');
    return;
  }

  const data = JSON.parse(readFileSync(FEATURES));
  // deterministic held-out slice: every 5th sample
  const holdout = data.samples.filter((_, i) => i % 5 === 0);
  const K = MODEL.classes.length;
  const conf = Array.from({ length: K }, () => new Array(K).fill(0));

  // drive the exact runtime path: build a fake spectrogram is not needed — call
  // the private _infer with the stored feature vector (that is what extractFeatures
  // would have produced).
  for (const s of holdout) {
    const idx = MODEL.classes.indexOf(s.label);
    if (idx < 0) continue;
    const probs = c._infer(Float32Array.from(s.f));
    let arg = 0;
    for (let k = 1; k < K; k++) if (probs[k] > probs[arg]) arg = k;
    conf[idx][arg]++;
  }

  let correct = 0;
  let total = 0;
  conf.forEach((row, i) => {
    row.forEach((v, j) => {
      total += v;
      if (i === j) correct += v;
    });
  });
  const acc = correct / total;
  console.log('  holdout confusion (truth \\ pred):', JSON.stringify(MODEL.classes));
  conf.forEach((row, i) => console.log(`    ${MODEL.classes[i].padStart(8)} ${JSON.stringify(row)}`));

  ok(acc > 0.85, `holdout accuracy > 85% (${(acc * 100).toFixed(1)}%)`);

  const si = MODEL.classes.indexOf('snoring');
  const bi = MODEL.classes.indexOf('bruxism');
  const snoreTotal = conf[si].reduce((a, b) => a + b, 0) || 1;
  const bruxTotal = conf[bi].reduce((a, b) => a + b, 0) || 1;
  ok(conf[si][si] / snoreTotal > 0.8, `snoring recall > 80% (${((conf[si][si] / snoreTotal) * 100).toFixed(0)}%)`);
  ok(conf[bi][bi] / bruxTotal > 0.8, `bruxism recall > 80% (${((conf[bi][bi] / bruxTotal) * 100).toFixed(0)}%)`);
  // the whole point: snoring and bruxism must not be confused with each other
  ok(conf[si][bi] / snoreTotal < 0.08, `snoring mislabelled as bruxism < 8% (${((conf[si][bi] / snoreTotal) * 100).toFixed(1)}%)`);
  ok(conf[bi][si] / bruxTotal < 0.08, `bruxism mislabelled as snoring < 8% (${((conf[bi][si] / bruxTotal) * 100).toFixed(1)}%)`);

  pass('trained model classifies snoring vs bruxism reliably');
}
