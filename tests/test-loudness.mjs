// loudness.js — BS.1770 loudness, normalise to -16 LUFS with a -1 dBFS limiter.
import { readFileSync } from 'fs';
import { section, ok, eq, approx, pass } from './lib.mjs';
import { integratedLoudness, normalizeSamples, normalizeWavBlob, decodeWav, encodeWav, peakDb } from '../js/loudness.js';

export async function run() {
  section('loudness.js — LUFS + limiter for playback/export');
  const buf = readFileSync(new URL('./fixtures/psg-snore-room.wav', import.meta.url));
  const { samples, sampleRate } = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  eq(sampleRate, 16000, 'decodes the fixture');

  // ffmpeg ebur128 measures this file at -41.9 LUFS
  approx(integratedLoudness(samples, 16000), -41.9, 0.3, 'integrated loudness matches ffmpeg ebur128');

  // a quiet nightstand recording comes out at about -16 LUFS, under -1 dBFS
  const quiet = samples.map((x) => x * 0.25); // ~ -54 LUFS
  const before = quiet.slice();
  const r = normalizeSamples(quiet, 16000);
  approx(r.lufsOut, -16, 1.0, `normalised to ~-16 LUFS (${r.lufsOut.toFixed(1)})`);
  ok(r.peakDb <= -1 + 1e-6, `peak under -1 dBFS (${r.peakDb.toFixed(2)})`);
  ok(r.gainDb > 30, `big gain for a quiet clip (+${r.gainDb.toFixed(1)} dB)`);
  ok(quiet.every((v, i) => v === before[i]), 'input samples untouched');

  // a loud transient on a quiet bed is limited, not clipped
  const spike = new Float32Array(32000).map((_, i) => (Math.random() * 2 - 1) * 0.002 + (i > 16000 && i < 16100 ? 0.9 * Math.sin(i) : 0));
  const s2 = normalizeSamples(spike, 16000);
  ok(peakDb(s2.samples) <= -1 + 1e-6, `transient limited to -1 dBFS (${peakDb(s2.samples).toFixed(2)})`);

  // silence stays silence (no NaN, no gain)
  const z = normalizeSamples(new Float32Array(16000), 16000);
  eq(z.gainDb, 0, 'silence: no gain');
  ok(z.samples.every((v) => v === 0), 'silence stays zero');

  // blob in, louder blob out, original blob unchanged
  const orig = encodeWav(quiet, 16000);
  const origBytes = Buffer.from(await orig.arrayBuffer());
  const out = await normalizeWavBlob(orig);
  ok(out.blob.size === orig.size, 'same length WAV');
  ok(Buffer.from(await orig.arrayBuffer()).equals(origBytes), 'original blob untouched');
  const back = decodeWav(await out.blob.arrayBuffer());
  approx(integratedLoudness(back.samples, 16000), -16, 1.0, 'exported WAV measures ~-16 LUFS');

  pass('clips are brought to -16 LUFS with a -1 dBFS ceiling');
}
