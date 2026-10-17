// apnea-detector.js — snore → pause → arousal state machine and AHI metrics.
import { section, ok, eq, approx } from './lib.mjs';
import { ApneaDetector, classifyArousalAcoustics } from '../js/apnea-detector.js';

// feed a scripted night: each step is [type, rms, zcr?]; windows are 2 s apart
function play(det, steps, t0 = 0) {
  const out = [];
  let wall = t0;
  for (const [type, rms, zcr = 0.05] of steps) {
    wall += 2000;
    const conf = type === 'snoring' || type === 'noise' ? 0.8 : type === 'quiet' ? 0.9 : 1;
    const ev = det.feed({ type, confidence: conf }, { rms, peak: rms * 2, zcr }, wall);
    if (ev) out.push(ev);
  }
  return out;
}
const rep = (n, step) => Array.from({ length: n }, () => step);
const SNORE = ['snoring', 0.1];
const SILENT = ['silence', 0.0008];

export function run() {
  section('apnea-detector.js — breathing pauses & estimated AHI');

  // --- classic cycle: snoring, 14 s pause, loud snort ---
  {
    const det = new ApneaDetector();
    const evs = play(det, [...rep(4, SNORE), ...rep(7, SILENT), ['snoring', 0.15], SNORE]);
    eq(evs.length, 1, 'one apnea detected for snore → 14 s pause → snort');
    const e = evs[0];
    eq(e.type, 'apnea', 'event type apnea');
    eq(e.duration, 14, 'pause duration measured from last snore to resumption');
    eq(e.startTime, 8000, 'pause starts when snoring stops');
    eq(e.endTime, 22000, 'pause ends when the snort begins');
    eq(e.arousal, 'snort', 'resumption by snoring is a snort');
    ok(e.confidence > 0.5 && e.confidence <= 0.95, `confidence in range (${e.confidence})`);
    eq(e.severity, 'mild', '14 s pause is mild');
  }

  // --- a gasp (broadband noise) also ends a pause ---
  {
    const det = new ApneaDetector();
    const evs = play(det, [...rep(5, SNORE), ...rep(10, SILENT), ['noise', 0.2, 0.3]]);
    eq(evs.length, 1, 'gasp-terminated pause detected');
    eq(evs[0].arousal, 'gasp', 'high-ZCR resumption classified as gasp');
    eq(evs[0].duration, 20, '20 s pause');
    eq(evs[0].severity, 'moderate', '20 s pause is moderate');
  }

  // --- pauses shorter than 10 s are normal breathing between snores ---
  {
    const det = new ApneaDetector();
    const evs = play(det, [...rep(4, SNORE), ...rep(4, SILENT), ...rep(3, SNORE), ...rep(2, SILENT), SNORE]);
    eq(evs.length, 0, '8 s and 4 s gaps are not apneas');
    eq(det.state, 'snoring', 'the snore run continues through short gaps');
  }

  // --- no preceding snoring → no apnea ---
  {
    const det = new ApneaDetector();
    const evs = play(det, [...rep(10, SILENT), ['snoring', 0.15], SNORE]);
    eq(evs.length, 0, 'silence then snoring alone is not an apnea');
  }

  // --- a single snore window is too short a run ---
  {
    const det = new ApneaDetector();
    const evs = play(det, [SNORE, ...rep(8, SILENT), ['snoring', 0.15]]);
    eq(evs.length, 0, 'a 2 s snore does not arm the detector');
  }

  // --- quiet stretches longer than 90 s are quiet sleep, not a pause ---
  {
    const det = new ApneaDetector();
    const evs = play(det, [...rep(4, SNORE), ...rep(50, SILENT), ['snoring', 0.15]]);
    eq(evs.length, 0, '100 s of silence is not counted as an apnea');
  }

  // --- a soft resumption (no arousal) is not counted ---
  {
    const det = new ApneaDetector();
    const evs = play(det, [...rep(4, SNORE), ...rep(7, ['silence', 0.004]), ['noise', 0.008]]);
    eq(evs.length, 0, 'a faint rustle after silence is not an arousal');
  }

  // --- talking interrupts the cycle ---
  {
    const det = new ApneaDetector();
    const evs = play(det, [...rep(4, SNORE), ['noise', 0.1], ...rep(7, SILENT), ['snoring', 0.15]]);
    eq(evs.length, 0, 'loud non-snore sound right after snoring resets the cycle');
  }

  // --- cyclic pattern: repeated events, events list kept, reset clears ---
  {
    const det = new ApneaDetector();
    const cycle = [...rep(4, SNORE), ...rep(6, SILENT), ['snoring', 0.15]];
    const evs = play(det, [...cycle, ...cycle, ...cycle]);
    eq(evs.length, 3, 'three cycles → three apneas');
    eq(det.events.length, 3, 'detector keeps the night list');
    det.reset();
    eq(det.events.length, 0, 'reset clears events');
    eq(det.state, 'idle', 'reset returns to idle');
  }

  // --- arousal acoustics ---
  {
    const a = classifyArousalAcoustics({ rms: 0.1, zcr: 0.3, type: 'noise', confidence: 0.7 }, 0.001, 0.1);
    ok(a.isArousal && a.kind === 'gasp', 'wideband loud burst → gasp');
    approx(a.jumpDb, 40, 0.1, 'jump measured against the pause floor');
    const b = classifyArousalAcoustics({ rms: 0.02, zcr: 0.05, type: 'other' }, 0.001, 0.1);
    ok(!b.isArousal, 'a jump that stays well below the snoring level is not an arousal');
    const c = classifyArousalAcoustics({ rms: 0.1, type: 'noise' }, 0.05, 0.1);
    ok(!c.isArousal, 'a < 10 dB jump is not an arousal');
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
