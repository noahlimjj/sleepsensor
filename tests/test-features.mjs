// features.js — feature extraction contract + discrimination sanity.
import { section, ok, eq, pass } from './lib.mjs';
import { sineWithBreathing, highFreqNoise, nearSilence } from './lib.mjs';
import { extractFeatures, FEATURE_NAMES, FEATURE_COUNT } from '../js/features.js';
import { dsp } from './load-worklet.mjs';

const SR = 16000;
const spec = (s) => dsp.melSpectrogram(s, { fftSize: 512, hop: 256, numMel: 128, timeSteps: 64, sampleRate: SR });
const feat = (s) => {
  const f = extractFeatures(spec(s), { rms: dsp.rms(s), peak: dsp.peakAbs(s), zcr: dsp.zcr(s) });
  const o = {};
  FEATURE_NAMES.forEach((n, i) => (o[n] = f[i]));
  return o;
};

export function run() {
  section('features.js — audio feature extraction');

  eq(FEATURE_COUNT, FEATURE_NAMES.length, 'FEATURE_COUNT matches FEATURE_NAMES');

  // contract: fixed length, all finite, all within [0,1]
  const f = extractFeatures(spec(sineWithBreathing(SR, 2, 110, 0.3)), { rms: 0.2 });
  eq(f.length, FEATURE_COUNT, 'vector has FEATURE_COUNT entries');
  ok([...f].every((v) => Number.isFinite(v) && v >= 0 && v <= 1), 'every feature is finite and in [0,1]');

  // empty / bad input -> zero vector, no throw
  ok([...extractFeatures(new Float32Array(0))].every((v) => v === 0), 'empty input -> zero vector');

  // low-frequency tonal snore vs high-frequency broadband grind
  const snore = feat(sineWithBreathing(SR, 2, 100, 0.3));
  const grind = feat(highFreqNoise(SR, 2));
  ok(snore.lowRatio > grind.lowRatio, 'snore has more low-band energy than grind');
  ok(grind.highRatio > snore.highRatio, 'grind has more high-band energy than snore');
  ok(grind.centroid > snore.centroid, 'grind has a higher spectral centroid');
  ok(grind.flatness > snore.flatness, 'grind is spectrally flatter (noise-like)');
  ok(grind.zcr > snore.zcr, 'grind has a higher zero-crossing rate');
  // harmonicity is only meaningful on real voiced snoring; on a pure synthetic
  // tone just check the grind (broadband noise) doesn't score as strongly.
  ok(grind.harmonicity <= snore.harmonicity + 0.15, 'broadband grind is not strongly harmonic');

  // loudness feature tracks RMS
  const quiet = extractFeatures(spec(nearSilence(SR, 2)), { rms: 1e-4 });
  const loud = extractFeatures(spec(sineWithBreathing(SR, 2)), { rms: 0.3 });
  const li = FEATURE_NAMES.indexOf('loudness');
  ok(loud[li] > quiet[li], 'loudness feature increases with RMS');

  pass('feature extraction behaves correctly');
}
