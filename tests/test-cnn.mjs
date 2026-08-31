// Validates the CNN in js/model-cnn/ (if present) — loads it with tfjs-node,
// runs it on real snoring / grinding clips, checks the two are not confused.
// Skips cleanly when the model dir or tfjs-node is absent.
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { section, ok, eq, pass } from './lib.mjs';
import { dsp } from './load-worklet.mjs';
import { readWavMono } from '../training/wav.mjs';

const CNN_DIR = new URL('../js/model-cnn/', import.meta.url).pathname;
const DS = new URL('../training/_snoredet/Snoring_Dataset_@16000/', import.meta.url).pathname;
const YT = new URL('../training/audio/', import.meta.url).pathname;
const SR = 16000;

export async function run() {
  section('model-cnn — spectrogram CNN');

  if (!existsSync(join(CNN_DIR, 'model.json'))) {
    console.log('  (no js/model-cnn/ — CNN path disabled, feature MLP in use)');
    pass('CNN optional — skipped');
    return;
  }

  const meta = JSON.parse(readFileSync(join(CNN_DIR, 'meta.json')));
  eq(meta.classes.join(','), 'quiet,snoring,bruxism,noise', 'CNN class order');
  ok(meta.metrics.testFileAccuracy >= 0.85, `CNN reports per-file acc ≥ 85% (${(meta.metrics.testFileAccuracy * 100).toFixed(1)}%)`);

  let tf;
  try {
    tf = (await import('@tensorflow/tfjs-node')).default;
  } catch {
    console.log('  (@tensorflow/tfjs-node not installed — skipping live inference)');
    pass('CNN metrics valid');
    return;
  }

  const model = await tf.loadLayersModel('file://' + join(CNN_DIR, 'model.json'));
  const { mels, frames } = meta;
  const melOpts = { fftSize: 512, hop: 256, numMel: mels, timeSteps: frames, sampleRate: SR };

  const predictClip = (path) => {
    const { samples } = readWavMono(path);
    const N = SR * 2;
    const w = new Float32Array(N);
    const at = Math.floor(samples.length / 3);
    for (let i = 0; i < N; i++) w[i] = samples[at + i] ?? samples[(at + i) % samples.length] ?? 0;
    const spec = dsp.melSpectrogram(w, melOpts);
    return tf.tidy(() => {
      const x = tf.tensor4d(spec, [1, mels, frames, 1]);
      return Array.from(model.predict(x).dataSync());
    });
  };
  const tally = (dir, n) => {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith('.wav')).slice(0, n);
    const t = {};
    for (const f of files) {
      const p = predictClip(join(dir, f));
      const arg = p.indexOf(Math.max(...p));
      t[meta.classes[arg]] = (t[meta.classes[arg]] || 0) + 1;
    }
    return t;
  };

  const snore = tally(join(DS, 'snoring'), 30);
  const grind = tally(join(YT, 'bruxism'), 25);
  if (snore) {
    console.log('  snoring clips ->', JSON.stringify(snore));
    ok((snore.snoring || 0) >= (snore.bruxism || 0) + (snore.noise || 0), 'snoring clips mostly classify as snoring');
    ok((snore.bruxism || 0) / 30 < 0.15, 'few snoring clips leak to bruxism');
  }
  if (grind) {
    console.log('  grinding clips ->', JSON.stringify(grind));
    ok((grind.bruxism || 0) >= 8, `a solid share of grinding clips classify as bruxism (${grind.bruxism || 0}/25)`);
    ok((grind.snoring || 0) / 25 < 0.2, 'few grinding clips leak to snoring');
  }

  pass('CNN classifies snoring vs bruxism without cross-confusion');
}
