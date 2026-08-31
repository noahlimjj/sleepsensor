// Classifier heuristics against synthetic snoring / bruxism / silence windows.
import { section, ok, eq, pass } from './lib.mjs';
import { sineWithBreathing, highFreqNoise, nearSilence } from './lib.mjs';
import { Classifier } from '../js/classifier.js';
import { dsp } from './load-worklet.mjs';

const SR = 16000;

function spec(samples) {
  return dsp.melSpectrogram(samples, {
    fftSize: 512,
    hop: 256,
    numMel: 128,
    timeSteps: 64,
    sampleRate: SR,
  });
}

// mirrors what the worklet passes to classify(): spectrogram + window RMS
function windowOf(samples) {
  return [spec(samples), { rms: dsp.rms(samples) }];
}

export async function run() {
  section('classifier.js — heuristic classification');

  const c = new Classifier();
  await c.load();
  ok(c.ready, 'classifier.load() resolves and marks ready');

  // --- snoring: low-frequency, tonal, amplitude-modulated ---
  {
    let hits = 0;
    const N = 8;
    for (let i = 0; i < N; i++) {
      const r = c.classify(spec(sineWithBreathing(SR, 2, 90 + i * 15, 0.3 + i * 0.03)));
      if (r.type === 'snoring') hits++;
    }
    ok(hits >= 6, `snoring detected in ${hits}/${N} synthetic snore windows`);
  }

  // --- bruxism: high-frequency broadband noise, steady ---
  {
    let hits = 0;
    const N = 8;
    for (let i = 0; i < N; i++) {
      const r = c.classify(spec(highFreqNoise(SR, 2, 1200 + i * 120, 4000 + i * 150)));
      if (r.type === 'bruxism') hits++;
    }
    ok(hits >= 6, `bruxism detected in ${hits}/${N} synthetic grinding windows`);
  }

  // --- snoring is not misfiled as bruxism and vice versa ---
  {
    const snore = c.classify(spec(sineWithBreathing(SR, 2, 110, 0.33)));
    const brux = c.classify(spec(highFreqNoise(SR, 2)));
    ok(snore.type !== 'bruxism', 'snoring window is never labelled bruxism');
    ok(brux.type !== 'snoring', 'grinding window is never labelled snoring');
  }

  // --- silence (worklet passes the raw RMS alongside the spectrogram) ---
  {
    const r = c.classify(...windowOf(nearSilence(SR, 2)));
    eq(r.type, 'silence', 'near-silent window -> silence when RMS is provided');
  }

  // --- confidence + severity contract ---
  {
    const r = c.classify(spec(sineWithBreathing(SR, 2, 100, 0.33)));
    ok(r.confidence >= 0 && r.confidence <= 1, 'confidence within [0,1]');
    eq(Classifier.severityFor(0.3), 'mild', 'severity: <0.5 -> mild');
    eq(Classifier.severityFor(0.6), 'moderate', 'severity: 0.5–0.75 -> moderate');
    eq(Classifier.severityFor(0.9), 'severe', 'severity: >0.75 -> severe');
  }

  // --- robustness: bad input doesn't throw ---
  {
    ok(c.classify(new Float32Array(0)).type === 'other', 'empty input -> other, no throw');
    ok(c.classify(null).type === 'other', 'null input -> other, no throw');
  }

  c.dispose();
  pass('classifier heuristics behave correctly');
}
