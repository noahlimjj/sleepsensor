// Generates a 16 kHz mono WAV of synthetic snoring, for Chromium's
// --use-file-for-fake-audio-capture flag in the browser integration test.
import { writeFileSync, mkdirSync } from 'fs';
import { float32ToWav } from '../../js/audio-engine.js';
import { sineWithBreathing } from '../lib.mjs';

const SR = 16000;
const SECONDS = 12;

// continuous low-frequency, amplitude-modulated snore
const samples = sineWithBreathing(SR, SECONDS, 115, 0.3);

const blob = float32ToWav(samples, SR);
const buf = Buffer.from(await blob.arrayBuffer());

mkdirSync(new URL('.', import.meta.url), { recursive: true });
const out = new URL('snore.wav', import.meta.url);
writeFileSync(out, buf);
console.log(`wrote ${out.pathname} (${buf.length} bytes, ${SECONDS}s @ ${SR}Hz)`);
