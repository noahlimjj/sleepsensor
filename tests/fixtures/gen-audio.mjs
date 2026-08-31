// Builds tests/fixtures/snore.wav — ~12 s of 16 kHz mono audio used as the fake
// microphone feed in the browser integration test. Prefers real snoring clips
// from the training corpus (so it exercises the trained model); falls back to a
// synthetic snore if the corpus isn't present.
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { float32ToWav } from '../../js/audio-engine.js';
import { sineWithBreathing } from '../lib.mjs';
import { readWavMono } from '../../training/wav.mjs';

const SR = 16000;
const SECONDS = 18;
const out = new URL('snore.wav', import.meta.url);
mkdirSync(new URL('.', import.meta.url), { recursive: true });

const corpus = new URL('../../training/_snoredet/Snoring_Dataset_@16000/snoring/', import.meta.url).pathname;

let samples;
let sourceKind;
if (existsSync(corpus)) {
  // one continuous snorer: pick a few clips and tile each for several seconds so
  // the pipeline sees sustained snoring (as it would on a real night), not a
  // rapid montage of different sleepers.
  const files = readdirSync(corpus).filter((f) => f.endsWith('.wav'));
  const clips = [];
  for (const f of files) {
    try {
      const { samples: s } = readWavMono(join(corpus, f));
      if (s.length > SR * 0.5 && dspPeak(s) > 0.05) clips.push(s);
    } catch (_) {
      /* skip */
    }
    if (clips.length >= 4) break;
  }
  samples = new Float32Array(SR * SECONDS);
  const segLen = Math.floor((SR * SECONDS) / clips.length);
  let o = 0;
  for (const c of clips) {
    for (let i = 0; i < segLen; i++) samples[o + i] = c[i % c.length];
    o += segLen;
  }
  let peak = dspPeak(samples);
  if (peak > 0) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] / peak) * 0.6;
  sourceKind = `${clips.length} real snoring clips, tiled`;
} else {
  samples = sineWithBreathing(SR, SECONDS, 115, 0.3);
  sourceKind = 'synthetic snore';
}

function dspPeak(a) {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m;
}

const buf = Buffer.from(await float32ToWav(samples, SR).arrayBuffer());
writeFileSync(out, buf);
console.log(`wrote ${out.pathname} (${buf.length} bytes, ~${(samples.length / SR).toFixed(1)}s, ${sourceKind})`);
