// Builds training/features.json from the local audio corpus.
//
// Sources:
//   _snoredet/Snoring_Dataset_@16000/snoring     -> snoring   (Kaggle, 1s clips)
//   _snoredet/Snoring_Dataset_@16000/no_snoring  -> noise     (baby/talk/TV/rain/…)
//   _snoredet/Snoring_Dataset_@16000/_background_noise_ -> quiet
//   audio/snoring/*                              -> snoring   (YouTube, long)
//   audio/bruxism/*                              -> bruxism   (YouTube, long)
//   audio/other/*                                -> noise / quiet (by loudness)
//   a sample of speech-command words             -> noise
//
// Each source file is sliced into 2 s windows; each window -> feature vector.
import { readdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { readWavMono, resample } from './wav.mjs';
import { extractFeatures, FEATURE_NAMES } from '../js/features.js';
import { dsp } from '../tests/load-worklet.mjs';

const SR = 16000;
const WIN = SR * 2;
const HOP = SR; // 1 s hop for long files
const HERE = new URL('.', import.meta.url).pathname;
const DS = join(HERE, '_snoredet/Snoring_Dataset_@16000');
const YT = join(HERE, 'audio');

const melOpts = { fftSize: 512, hop: 256, numMel: 128, timeSteps: 64, sampleRate: SR };

function windowsOf(samples) {
  const out = [];
  if (samples.length <= WIN) {
    // short clip (Kaggle 1 s): centre-pad to 2 s by mirroring
    const w = new Float32Array(WIN);
    w.set(samples, 0);
    for (let i = samples.length; i < WIN; i++) w[i] = samples[i - samples.length] || 0;
    out.push(w);
  } else {
    for (let s = 0; s + WIN <= samples.length; s += HOP) out.push(samples.subarray(s, s + WIN));
  }
  return out;
}

function featuresFor(win) {
  const rms = dsp.rms(win);
  const peak = dsp.peakAbs(win);
  const zcr = dsp.zcr(win);
  const spec = dsp.melSpectrogram(win, melOpts);
  return { f: Array.from(extractFeatures(spec, { rms, peak, zcr })), rms };
}

const samples = [];
let skipped = 0;

function ingest(dir, labeler, cap = Infinity, stridePick = 1) {
  if (!existsSync(dir)) {
    console.warn('  (missing)', dir);
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.wav'));
  let used = 0;
  for (let fi = 0; fi < files.length && used < cap; fi += stridePick) {
    const path = join(dir, files[fi]);
    let audio;
    try {
      audio = readWavMono(path);
    } catch (e) {
      skipped++;
      continue;
    }
    let sig = audio.samples;
    if (audio.sampleRate !== SR) sig = resample(sig, audio.sampleRate, SR);
    for (const w of windowsOf(sig)) {
      const { f, rms } = featuresFor(w);
      const label = labeler(rms);
      if (!label) continue;
      samples.push({ label, f });
      used++;
      if (used >= cap) break;
    }
  }
  console.log(`  ${dir.replace(HERE, '')}  ->  +${used} windows`);
}

console.log('extracting features...');

// --- snoring ---
ingest(join(DS, 'snoring'), () => 'snoring');
ingest(join(YT, 'snoring'), (rms) => (rms > 0.008 ? 'snoring' : null));

// --- bruxism (YouTube only) ---
ingest(join(YT, 'bruxism'), (rms) => (rms > 0.006 ? 'bruxism' : null));

// --- noise: loud non-snore sounds ---
ingest(join(DS, 'no_snoring'), (rms) => (rms > 0.01 ? 'noise' : 'quiet'));
ingest(join(YT, 'other'), (rms) => (rms > 0.02 ? 'noise' : 'quiet'));
// a sample of spoken words as "noise" (speech)
for (const word of ['house', 'learn', 'left', 'marvin', 'one', 'off']) {
  ingest(join(DS, word), () => 'noise', 120, 11);
}

// --- quiet / ambient ---
ingest(join(DS, '_background_noise_'), (rms) => (rms < 0.03 ? 'quiet' : 'noise'));

// synthetic near-silence so "quiet" is well represented
for (let i = 0; i < 200; i++) {
  const w = new Float32Array(WIN);
  for (let j = 0; j < WIN; j++) w[j] = (Math.random() * 2 - 1) * (1e-4 + Math.random() * 3e-3);
  samples.push({ label: 'quiet', f: featuresFor(w).f });
}

// --- report ---
const counts = {};
for (const s of samples) counts[s.label] = (counts[s.label] || 0) + 1;
console.log('\nclass counts:', counts, '\nskipped files:', skipped);

writeFileSync(
  join(HERE, 'features.json'),
  JSON.stringify({ featureNames: FEATURE_NAMES, sampleRate: SR, samples })
);
console.log(`wrote training/features.json  (${samples.length} samples)`);
