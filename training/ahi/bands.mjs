// Band-limited 100 ms level envelopes for a patient's hours of audio. The
// hospital room has heavy low-frequency rumble, so breathing only shows up in
// band-passed levels. The last column is the app's own breathing meter. Output: feat/<id>.bands.json  { segments, bands, env: {seg: [[dB×10 per band] per frame]} }
//   node bands.mjs <patientId>
import { spawn } from 'child_process';
import { readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { dsp } from '../../tests/load-worklet.mjs';

const ROOT = process.env.PSG_AUDIO_DIR || `${process.env.HOME}/datasets/psg-audio`;
const id = process.argv[2];
const SR = 16000;
const FRAME = 1600;
export const BANDS = [[150, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 0]];

const bq = (t, fc, q = 0.7071) => {
  const w = (2 * Math.PI * fc) / SR, c = Math.cos(w), a = Math.sin(w) / (2 * q), a0 = 1 + a;
  const b = t === 'hp' ? [(1 + c) / 2, -(1 + c), (1 + c) / 2] : [(1 - c) / 2, 1 - c, (1 - c) / 2];
  return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * c) / a0, a2: (1 - a) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
};
const step = (f, x) => {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
  return y;
};
const chain = ([lo, hi]) => [bq('hp', lo), bq('hp', lo), ...(hi ? [bq('lp', hi), bq('lp', hi)] : [])];

const dir = join(ROOT, 'audio', id);
const segs = readdirSync(dir).filter((f) => /^\d+\.flac$/.test(f)).sort();
const env = {};
for (const seg of segs) {
  const chains = BANDS.map(chain);
  const acc = new Float64Array(BANDS.length);
  const meter = dsp.createBreathMeter(SR);
  const one = new Float32Array(1);
  let n = 0;
  const frames = [];
  await new Promise((res, rej) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', join(dir, seg), '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-']);
    let carry = Buffer.alloc(0);
    ff.stdout.on('data', (chunk) => {
      const b = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const cnt = b.length >> 2;
      for (let i = 0; i < cnt; i++) {
        const x = b.readFloatLE(i * 4);
        one[0] = x;
        meter.process(one);
        for (let k = 0; k < chains.length; k++) {
          let y = x;
          for (const f of chains[k]) y = step(f, y);
          acc[k] += y * y;
        }
        if (++n === FRAME) {
          frames.push([...Array.from(acc, (s) => Math.round(100 * Math.log10(Math.max(s / FRAME, 1e-18)))), Math.round(meter.take()[0] * 10)]);
          acc.fill(0);
          n = 0;
        }
      }
      carry = b.subarray(cnt * 4);
    });
    ff.on('close', (code) => (code ? rej(new Error(`ffmpeg ${code}`)) : res()));
  });
  env[parseInt(seg, 10)] = frames;
}
mkdirSync(join(ROOT, 'feat'), { recursive: true });
writeFileSync(join(ROOT, 'feat', `${id}.bands.json`), JSON.stringify({ id, bands: BANDS, segments: Object.keys(env).map(Number), env }));
console.log(`${id}: ${segs.length} segments`);
