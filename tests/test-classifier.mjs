// classifier.js — public API contract + spot-checks on real audio clips.
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { section, ok, eq, pass } from './lib.mjs';
import { nearSilence } from './lib.mjs';
import { Classifier } from '../js/classifier.js';
import { dsp } from './load-worklet.mjs';
import { readWavMono } from '../training/wav.mjs';

const SR = 16000;
const DS = new URL('../training/_snoredet/Snoring_Dataset_@16000/', import.meta.url).pathname;
const YT = new URL('../training/audio/', import.meta.url).pathname;

function windowFrom(samples, at = 0) {
  const N = SR * 2;
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = samples[at + i] || samples[(at + i) % samples.length] || 0;
  return w;
}
function classifyClip(path, cls) {
  const { samples } = readWavMono(path);
  const w = windowFrom(samples, Math.floor(samples.length / 4));
  return cls.classify(dsp.melSpectrogram(w, { fftSize: 512, hop: 256, numMel: 128, timeSteps: 64, sampleRate: SR }), {
    rms: dsp.rms(w),
    peak: dsp.peakAbs(w),
    zcr: dsp.zcr(w),
  });
}
function majority(dir, cls, n = 20) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.wav')).slice(0, n);
  const tally = {};
  for (const f of files) {
    try {
      const t = classifyClip(join(dir, f), cls).type;
      tally[t] = (tally[t] || 0) + 1;
    } catch (_) {
      /* skip unreadable */
    }
  }
  return tally;
}

export async function run() {
  section('classifier.js — API + real-audio spot checks');

  const c = new Classifier();
  await c.load();
  ok(c.ready, 'load() resolves and marks ready');

  // --- API contract ---
  const r = c.classify(new Float32Array(128 * 64).fill(0.3), { rms: 0.1, peak: 0.2, zcr: 0.1 });
  ok(['silence', 'snoring', 'bruxism', 'noise', 'other'].includes(r.type), `type is a known label (${r.type})`);
  ok(r.confidence >= 0 && r.confidence <= 1, 'confidence in [0,1]');
  ok(r.scores && typeof r.scores === 'object', 'scores object returned');
  ok(typeof r.db === 'number', 'dBFS reported when rms provided');
  eq(c.classify(null).type, 'other', 'null input -> other, no throw');

  eq(Classifier.severityFor(0.3), 'mild', 'severity <0.5 -> mild');
  eq(Classifier.severityFor(0.6), 'moderate', 'severity 0.5–0.75 -> moderate');
  eq(Classifier.severityFor(0.9), 'severe', 'severity >0.75 -> severe');

  // --- silence via RMS floor ---
  {
    const s = nearSilence(SR, 2);
    const res = c.classify(dsp.melSpectrogram(s, { fftSize: 512, hop: 256, numMel: 128, timeSteps: 64, sampleRate: SR }), {
      rms: dsp.rms(s),
    });
    eq(res.type, 'silence', 'near-silent window -> silence');
  }

  // --- real audio, if the training corpus is present ---
  const snoreTally = majority(join(DS, 'snoring'), c, 25);
  const bruxTally = majority(join(YT, 'bruxism'), c, 25);
  if (snoreTally && Object.keys(snoreTally).length) {
    console.log('  snoring clips ->', JSON.stringify(snoreTally));
    const top = Object.entries(snoreTally).sort((a, b) => b[1] - a[1])[0][0];
    eq(top, 'snoring', 'most Kaggle snoring clips classify as snoring');
    ok((snoreTally.bruxism || 0) <= 3, 'few snoring clips leak into bruxism');
  } else {
    console.log('  (no training audio — skipping real-clip checks)');
  }
  if (bruxTally && Object.keys(bruxTally).length) {
    console.log('  grinding clips ->', JSON.stringify(bruxTally));
    const top = Object.entries(bruxTally).sort((a, b) => b[1] - a[1])[0][0];
    eq(top, 'bruxism', 'most grinding clips classify as bruxism');
    ok((bruxTally.snoring || 0) <= 3, 'few grinding clips leak into snoring');
  }

  c.dispose();
  pass('classifier behaves correctly');
}
