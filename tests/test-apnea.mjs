// apnea-detector.js — breathing-band dip → recovery detector and AHI metrics.
import { section, ok, eq } from './lib.mjs';
import { ApneaDetector, BreathPauseTracker, breathProbability } from '../js/apnea-detector.js';

// --- synthetic breathing-band envelopes (dBFS per 100 ms) ---
const FLOOR = -70;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const quiet = (sec) => Array.from({ length: sec * 10 }, () => FLOOR + rnd() * 0.4);
// breaths: 1.2 s of sound every `period` s
function breathing(sec, level = -58, period = 4) {
  const out = quiet(sec);
  for (let t = 0; t + 1.2 <= sec; t += period) for (let i = 0; i < 12; i++) out[Math.round(t * 10) + i] = level + rnd();
  return out;
}
// one obstructive cycle: 30 s of breathing, a silent pause, three loud recovery breaths
const cycle = (pauseSec = 20) => [...breathing(30), ...quiet(pauseSec), ...breathing(9, -48, 3)];

// play an envelope through the detector as 2 s worklet windows
function play(det, env, { t0 = 0, type = 'other', typeAt = null } = {}) {
  const out = [];
  let wall = t0;
  for (let i = 0; i + 20 <= env.length; i += 20) {
    wall += 2000;
    const res = typeAt ? typeAt(wall - t0) : { type, confidence: 0.8 };
    const ev = det.feed(res, { breath: env.slice(i, i + 20), rms: 0.01, peak: 0.05, zcr: 0.05 }, wall);
    if (ev) out.push(ev);
  }
  return out;
}

export function run() {
  section('apnea-detector.js — breathing pauses & estimated AHI');

  // --- steady breathing all night long is not an apnea ---
  {
    const det = new ApneaDetector();
    eq(play(det, breathing(900)).length, 0, '15 min of regular breathing → no pauses');
    eq(det.state, 'listening', 'detector is listening once sound arrives');
  }

  // --- a silent room is not an apnea either ---
  {
    const det = new ApneaDetector();
    eq(play(det, quiet(900)).length, 0, '15 min of room noise → no pauses');
  }

  // --- repeated pause → recovery cycles are found, timed and described ---
  {
    const det = new ApneaDetector();
    const env = [...breathing(60), ...Array.from({ length: 8 }, () => cycle(20)).flat(), ...breathing(60)];
    const evs = play(det, env);
    ok(evs.length >= 6 && evs.length <= 9, `8 cycles → about 8 pauses (${evs.length})`);
    eq(det.events.length, evs.length, 'detector keeps the night list');
    const e = evs[1];
    eq(e.type, 'apnea', 'event type apnea');
    ok(e.duration >= 15 && e.duration <= 25, `20 s pause measured (${e.duration})`);
    eq(e.severity, 'moderate', '20 s pause is moderate');
    ok(e.confidence > 0.29 && e.confidence <= 0.95, `confidence in range (${e.confidence})`);
    ok(e.arousalJumpDb >= 4, `recovery jump reported (${e.arousalJumpDb} dB)`);
    // cycle k recovers at 60 + 59k + 50 s
    const expected = [1, 2, 3, 4, 5, 6, 7].map((k) => (60 + 59 * k + 50) * 1000);
    ok(expected.some((t) => Math.abs(e.endTime - t) <= 4000), `pause ends when breathing returns (${e.endTime})`);
    eq(e.endTime - e.startTime, e.duration * 1000, 'start/end consistent with duration');
    det.reset();
    eq(det.events.length, 0, 'reset clears events');
    eq(det.state, 'idle', 'reset returns to idle');
  }

  // --- the recovery sound is described from the classifier's verdict ---
  {
    const det = new ApneaDetector();
    const env = [...breathing(60), ...Array.from({ length: 4 }, () => cycle(20)).flat(), ...breathing(60)];
    const evs = play(det, env, { type: 'snoring' });
    ok(evs.length > 0 && evs.every((x) => x.arousal === 'snort'), 'snoring at the recovery → snort');
    const det2 = new ApneaDetector();
    const evs2 = play(det2, env, { type: 'other' });
    ok(evs2.length > 0 && evs2.every((x) => x.arousal === 'arousal'), 'unclassified recovery → plain arousal');
  }

  // --- short gaps between breaths are normal ---
  {
    const det = new ApneaDetector();
    const env = [...breathing(60), ...Array.from({ length: 12 }, () => [...breathing(30), ...quiet(6)]).flat()];
    eq(play(det, env).length, 0, 'a skipped breath (6 s more silence) is not counted');
  }

  // --- windows without the breathing band (older worklet) are ignored ---
  {
    const det = new ApneaDetector();
    eq(det.feed({ type: 'snoring', confidence: 0.9 }, { rms: 0.1 }, 2000), null, 'no breath frames → null');
    eq(det.state, 'idle', '... and the detector stays idle');
  }

  // --- a hole in the audio restarts listening instead of faking a pause ---
  {
    const det = new ApneaDetector();
    play(det, breathing(120));
    const evs = play(det, breathing(120, -48, 3), { t0: 120000 + 600000 });
    eq(evs.length, 0, 'louder breathing after a 10 min interruption is not a recovery');
  }

  // --- tracker bookkeeping stays bounded over a long night ---
  {
    const tr = new BreathPauseTracker();
    for (let i = 0; i < 40; i++) tr.push(breathing(60));
    ok(tr.pw.length <= 200 && tr.jumps.size <= 260, `rolling state stays small (${tr.pw.length} s, ${tr.jumps.size} rows)`);
  }

  // --- the scoring model prefers a long silent gap with a big recovery ---
  {
    const strong = { jump: 14, drop: 6, lPause: 0.2, near: 3, gap: 22, preAct: 9, postAct: 8 };
    const weak = { jump: 4.5, drop: 0, lPause: 4, near: 0, gap: 0, preAct: 25, postAct: 28 };
    ok(breathProbability(strong) > 0.6, `clear apnea shape scores high (${breathProbability(strong).toFixed(2)})`);
    ok(breathProbability(weak) < 0.2, `a blip in continuous sound scores low (${breathProbability(weak).toFixed(2)})`);
  }

  // --- AHI metrics, tiers and bruxism correlation ---
  {
    const H = 3600;
    const apneas = (n) =>
      Array.from({ length: n }, (_, i) => ({ type: 'apnea', startTime: i * 100000, endTime: i * 100000 + 15000, duration: 15 }));
    eq(ApneaDetector.calculateAhiMetrics([], 8 * H).severity, 'optimal', 'no events → optimal');
    eq(ApneaDetector.calculateAhiMetrics(apneas(16), 8 * H).estimatedAhi, 2, '16 events / 8 h = 2');
    eq(ApneaDetector.calculateAhiMetrics(apneas(40), 4 * H).severity, 'mild', 'AHI 10 → mild');
    eq(ApneaDetector.calculateAhiMetrics(apneas(80), 4 * H).severity, 'moderate', 'AHI 20 → moderate');
    eq(ApneaDetector.calculateAhiMetrics(apneas(60), 2 * H).severity, 'severe', 'AHI 30 → severe');
    eq(ApneaDetector.calculateAhiMetrics(apneas(5), 1 * H).severity, 'mild', 'AHI exactly 5 → mild');
    ok(!ApneaDetector.calculateAhiMetrics(apneas(2), 1 * H).reliable, 'a 1 h recording is flagged unreliable');
    eq(ApneaDetector.calculateAhiMetrics(apneas(3), 0).estimatedAhi, 0, 'zero-length recording does not divide by zero');

    const events = [
      { type: 'apnea', startTime: 0, endTime: 20000, duration: 20 },
      { type: 'apnea', startTime: 500000, endTime: 530000, duration: 30 },
      { type: 'bruxism', startTime: 50000, endTime: 80000 }, // 30 s after the first arousal → linked
      { type: 'bruxism', startTime: 300000, endTime: 320000 }, // far from any pause
      { type: 'snoring', startTime: 0, endTime: 10000 },
    ];
    const m = ApneaDetector.calculateAhiMetrics(events, 8 * H);
    eq(m.apneaEvents, 2, 'only apnea events counted');
    eq(m.avgPauseSec, 25, 'average pause');
    eq(m.longestPauseSec, 30, 'longest pause');
    eq(m.bruxismLinked, 1, 'one grinding episode linked to a pause');
    eq(m.bruxismLinkedPct, 50, 'linked percentage');

    const lines = ApneaDetector.describeMetrics(m);
    ok(lines.length >= 2 && lines.some((l) => /grinding/.test(l)), 'insights mention the grinding link');
    const sev = ApneaDetector.describeMetrics(ApneaDetector.calculateAhiMetrics(apneas(80), 4 * H));
    ok(sev.some((l) => /doctor/.test(l)), 'moderate/severe insight recommends a doctor');
    ok(/No breathing pauses/.test(ApneaDetector.describeMetrics(ApneaDetector.calculateAhiMetrics([], 8 * H))[0]), 'empty night insight');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { summary } = await import('./lib.mjs');
  run();
  summary();
}
