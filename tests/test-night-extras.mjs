// Clicks / breathing rate / movement + buzz labels: detectors and panel.
import { section, ok, eq, approx, pass } from './lib.mjs';
import { dsp } from './load-worklet.mjs';
import { estimateRate, RespRateTracker } from '../js/resp-rate.js';
import { soundShape, labelNoise } from '../js/sound-shape.js';
import { buildNightModel, renderNightClips, kindOf } from '../js/night-clips.js';

const SR = 16000;
const g = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); };
const bg = (n, l = 0.002) => Float32Array.from({ length: n }, () => g() * l);

export async function run() {
  section('clicks, breathing rate, sound labels, panel');
  // clicks: a sharp snap is found; slow loud breathing never is
  const w = bg(32000);
  for (let i = 0; i < 48; i++) w[16000 + i] += 0.06 * Math.exp(-i / 8) * g();
  const c = dsp.detectClicks(w, SR, 0.0004);
  eq(c.length, 1, 'one snap -> one click');
  approx(c[0].t, 1.0, 0.01, 'click timed within 10 ms');
  let fp = 0;
  for (let k = 0; k < 10; k++) {
    const b = bg(32000);
    for (let i = 0; i < 32000; i++) b[i] += g() * 0.02 * Math.max(0, Math.sin((2 * Math.PI * i) / (SR * 3)));
    fp += dsp.detectClicks(b, SR, 0.0004).length;
  }
  eq(fp, 0, 'loud breathing gives no clicks');

  // breathing rate from a 15 bpm envelope with noise; a 7.5 bpm half-rate trap is avoided
  const env = Array.from({ length: 600 }, (_, i) => -60 + 10 * Math.max(0, Math.sin((2 * Math.PI * i) / 40)) + g());
  approx(estimateRate(env).bpm, 15, 0.8, `15 bpm envelope -> ${estimateRate(env).bpm}`);
  const flat = Array.from({ length: 600 }, () => -60 + g());
  const r = estimateRate(flat);
  ok(!r || r.q < 0.3, 'no rhythm -> no estimate');
  const tr = new RespRateTracker();
  let got = 0;
  for (let k = 0; k < 300; k++) if (tr.push(env.slice((k * 20) % 580, ((k * 20) % 580) + 20), k * 2000)) got++;
  ok(got >= 15 && Math.abs(tr.summary().avg - 15) < 1, `tracker: ${got} estimates, night avg ${tr.summary().avg}`);

  // labels: steady tone = buzz, bursts of broadband = movement, breathing = other
  const fb = dsp.buildMelFilterbank(128, 512, SR);
  const spec = (x) => dsp.melSpectrogram(x, { fftSize: 512, hop: 256, numMel: 128, timeSteps: 64, sampleRate: SR, melFb: fb });
  const buzz = bg(32000, 0.001);
  for (let i = 0; i < 32000; i++) { let s = 0; for (let h = 1; h < 6; h++) s += Math.sin((2 * Math.PI * 170 * h * i) / SR) / h; buzz[i] += 0.02 * s; }
  eq(labelNoise(soundShape(spec(buzz)), 4), 'buzz', 'phone-vibration hum -> buzz');
  // deterministic rustle (seeded), several bursts
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rg = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const rus = Float32Array.from({ length: 32000 }, () => rg() * 0.001);
  let e = 0, lp = 0, pv = 0;
  for (let i = 0; i < 32000; i++) { if (i % 4000 === 0) e = 0.03 + rnd() * 0.04; e *= 0.9993; lp += 0.5 * (rg() - lp); rus[i] += e * (lp - pv); pv = lp; }
  eq(labelNoise(soundShape(spec(rus)), 6), 'movement', 'rustling bursts -> movement');
  eq(kindOf('noise', 'movement'), 'movement', 'noise/movement shown as Movement');
  eq(kindOf('click'), 'click', 'click kind');

  // panel: clicks + TMJ + breathing rate in the summary, click lane + rate trend in the chart
  const t0 = new Date(2026, 10, 24, 23, 0).getTime();
  const session = { id: 'n', startTime: t0, endTime: t0 + 7 * 3600e3, respRate: { avg: 14.6, min: 12.2, max: 17.1, n: 300 },
    clicks: { count: 40, nearGrind: 12, times: Array.from({ length: 40 }, (_, i) => 3600e3 * 4 + i * 20000) },
    trace: Array.from({ length: 400 }, (_, m) => ({ m, rr: 14 + (m % 7) / 3 })) };
  const events = [
    { id: 'g', type: 'bruxism', timestamp: t0 + 4.1 * 3600e3, duration: 60 },
    { id: 'k1', type: 'click', timestamp: t0 + 4 * 3600e3, duration: 8, count: 6, nearGrind: true },
    { id: 'k2', type: 'click', timestamp: t0 + 4.3 * 3600e3, duration: 4, count: 3 },
    { id: 'm', type: 'noise', subtype: 'movement', timestamp: t0 + 2 * 3600e3, duration: 10 },
  ];
  const clips = events.map((x) => ({ id: 'c' + x.id, eventId: x.id, clipType: 'event', timestamp: x.timestamp, duration: 10 }));
  const m = buildNightModel({ session, events, highlights: [], clips });
  eq(m.groups.map((x) => x.key).join(','), 'grind,click,movement', 'groups: grinding, clicks, movement');
  const html = renderNightClips(m);
  ok(html.includes('15<small>/min</small>') && html.includes('breathing 12–17'), 'summary: breathing rate with range');
  ok(html.includes('<span class="nc-stat-v">40</span><span class="nc-stat-l">clicks</span>'), 'summary: click count');
  ok(html.includes('possible TMJ / bruxism-related'), 'TMJ line');
  ok(html.includes('most around 03:00'), 'click timing');
  ok(html.includes('near grinding') && html.includes('6 clicks'), 'click row shows count + near grinding');
  ok(html.includes('nc-rr-line'), 'breathing-rate trend line');
  pass('clicks, breathing rate and sound labels work end to end');
}
