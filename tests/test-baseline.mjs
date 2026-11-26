// The owner's junk night: every breath of quiet breathing (~30 dBA) logged as
// "Noise · Soft". A generic sound must now deviate from the night's baseline;
// a real one-off sound (cough, bang, talking) is still logged; clicks cluster.
import { section, ok, eq, pass } from './lib.mjs';

export async function run(AudioEngineImpl) {
  const { AudioEngine } = AudioEngineImpl ? { AudioEngine: AudioEngineImpl } : await import('../js/audio-engine.js');
  section('night baseline — no clips for quiet breathing; real sounds + clicks kept');
  const make = () => {
    const events = [];
    const storage = {
      async createSession(s) { return { id: 's', ...s }; }, async updateSession() {}, async setSetting() {},
      async addEvent(e) { events.push(e); return e; }, async updateEvent(id, u) { const e = events.find((x) => x.id === id); if (e) Object.assign(e, u); },
      async saveClip() {}, async saveHighlight() {}, async updateHighlight() {}, async deleteHighlight() {},
      async getClipsBySession() { return []; }, async getHighlightsBySession() { return []; },
      async deleteEventsAndClips(ids) { for (const id of ids) { const i = events.findIndex((e) => e.id === id); if (i >= 0) events.splice(i, 1); } },
    };
    const engine = new AudioEngine({ storage, classifier: { minConfidence: 0.35, ready: true, async load() {}, classify: () => ({}) }, onEvent() {}, onEnergy() {}, onStatusChange() {} });
    Object.assign(engine, { session: { id: 's', startTime: 0 }, startWallTime: 0, ctxStartTime: 0, _recording: true, audioContext: { sampleRate: 16000 }, settleMs: 0 });
    engine.workletNode = { port: { postMessage() {} }, disconnect() {} };
    return { engine, events };
  };
  const noiseRaw = { type: 'noise', confidence: 0.5, scores: { quiet: 0.3, snoring: 0.1, bruxism: 0.1, noise: 0.5 } };
  // soft breathing: every window holds part of a breath (+5 dB over the gaps)
  // ~15 breaths/min: two windows with a breath, one gap window
  const breath = (t, k) => (k % 3 === 2
    ? { type: 'spectrogram', timestamp: t, rms: 0.0008, activeRms: 0.0009, quietRms: 0.0007, peak: 0.002 }
    : { type: 'spectrogram', timestamp: t, rms: 0.0011, activeRms: k % 3 ? 0.0019 : 0.0016, quietRms: 0.0007, peak: 0.004 });
  const feed = (engine, raw, msg) => engine._handleClassification(raw, msg, raw);

  // 10 minutes of quiet breathing
  const { engine, events } = make();
  let t = 0;
  for (let k = 0; k < 300; k++) feed(engine, noiseRaw, breath((t += 2), k));
  const junk = events.filter((e) => e.type === 'noise').length;
  eq(junk, 0, `quiet breathing for 10 min -> no "Noise" events (got ${junk})`);

  // a cough well above the night (+12 dB) is still logged
  feed(engine, noiseRaw, { type: 'spectrogram', timestamp: (t += 2), rms: 0.005, activeRms: 0.009, quietRms: 0.0008, peak: 0.03 });
  feed(engine, noiseRaw, { type: 'spectrogram', timestamp: (t += 2), rms: 0.004, activeRms: 0.008, quietRms: 0.0008, peak: 0.02 });
  for (let k = 0; k < 4; k++) feed(engine, noiseRaw, breath((t += 2), k));
  ok(events.some((e) => e.type === 'noise'), 'a clear sound above the baseline is logged');
  if (AudioEngineImpl) return junk;

  // clicks: two bursts near a grinding episode -> click events flagged TMJ; a lone click is only counted
  {
    const { engine: e2, events: ev2 } = make();
    let t2 = 0;
    const win = (clicks) => ({ type: 'silence', timestamp: (t2 += 2), rms: 0.0008, activeRms: 0.0009, quietRms: 0.0007, peak: 0.003, clicks });
    for (let k = 0; k < 20; k++) e2._feedClicks(win([]));
    e2._feedClicks(win([{ t: 0.3, db: -30 }, { t: 1.1, db: -28 }]));
    e2._feedClicks(win([{ t: 0.5, db: -31 }]));
    for (let k = 0; k < 8; k++) e2._feedClicks(win([]));
    e2._feedClicks(win([{ t: 1.0, db: -35 }])); // lone click
    for (let k = 0; k < 8; k++) e2._feedClicks(win([]));
    e2._noteGrind((t2 + 30) * 1000, (t2 + 60) * 1000); // grinding starts 30 s later
    e2._finalizeClicks();
    const clicks = ev2.filter((e) => e.type === 'click');
    eq(clicks.length, 1, 'clicks within 10 s form one event; a lone click is not an event');
    eq(clicks[0].count, 3, 'click count on the event');
    eq(e2._clicks.count, 4, 'every click counted');
    eq(e2._clickTimes.length, 4, 'every click timed');
    ok(clicks[0].nearGrind, 'clicks within 2 min of grinding flagged possible TMJ/bruxism');
    eq(e2._clicks.nearGrind, 3, 'TMJ-flagged click count');
  }

  // breathing rate reaches the session
  {
    const { engine: e3 } = make();
    let t3 = 0;
    for (let k = 0; k < 60; k++) {
      const frames = Array.from({ length: 20 }, (_, i) => -60 + 12 * Math.max(0, Math.sin((2 * Math.PI * ((k * 20 + i) / 10)) / 4))); // 15 bpm
      e3._feedRespRate({ timestamp: (t3 += 2), breath: frames });
    }
    const rr = e3._listeningPatch().respRate;
    ok(rr && Math.abs(rr.avg - 15) < 1, `breathing rate on the session (${rr && rr.avg} bpm)`);
  }
  // breathing pauses need audible breathing just before them; long "pauses" are silence
  {
    const { engine: e4, events: ev4 } = make();
    const fakeEv = (t, dur) => ({ type: 'apnea', startTime: t, endTime: t + dur * 1000, duration: dur, confidence: 0.7, severity: 'mild', peakDb: -40 });
    let next = null;
    e4.apneaDetector = { feed: () => { const v = next; next = null; return v; }, events: [], reset() {} };
    const msgAt = (sec) => ({ type: 'silence', timestamp: sec });
    next = fakeEv(600000, 20); e4._feedApnea({ type: 'silence' }, msgAt(620));
    eq(ev4.filter((e) => e.type === 'apnea').length, 0, 'no audible breathing before -> pause not logged');
    e4._rr.points.push({ t: 1150000, bpm: 14, q: 0.6 });
    next = fakeEv(1200000, 20); e4._feedApnea({ type: 'silence' }, msgAt(1220));
    eq(ev4.filter((e) => e.type === 'apnea').length, 1, 'audible breathing within 3 min -> pause logged');
    next = fakeEv(1250000, 90); e4._feedApnea({ type: 'silence' }, msgAt(1340));
    eq(ev4.filter((e) => e.type === 'apnea').length, 1, '90 s "pause" (unresolvable silence) dropped');
    eq(e4._tally.apneaUnheard, 2, 'dropped candidates counted');
    e4.startWallTime = Date.now() - 3600e3;
    const sum = await e4.stop('user');
    eq(sum.estimatedAhi, null, 'under 30 min of audible breathing -> no AHI estimate');
    eq(sum.breathAudibleSec, 30, 'audible-breathing time on the session');
  }

  // phone handling: clicks in the first 60 s are ignored; sounds in the last 90 s are dropped on stop
  {
    const { engine: e5, events: ev5 } = make();
    e5.settleMs = 60000;
    let t5 = 0;
    const win = (clicks) => ({ type: 'silence', timestamp: (t5 += 2), rms: 0.0008, activeRms: 0.0009, quietRms: 0.0007, peak: 0.003, clicks });
    e5._feedClicks(win([{ t: 0.2, db: -30 }, { t: 0.9, db: -30 }, { t: 1.5, db: -30 }]));
    for (let k = 0; k < 10; k++) e5._feedClicks(win([]));
    eq(e5._clicks.count, 0, 'clicks while putting the phone down are ignored');
    // now a click burst right before stopping
    e5.startWallTime = Date.now() - 3600e3;
    e5.ctxStartTime = 0;
    t5 = 3600 - 30;
    e5._feedClicks(win([{ t: 0.2, db: -30 }, { t: 0.9, db: -30 }]));
    e5._finalizeClicks();
    const before = ev5.filter((e) => e.type === 'click').length;
    await e5.stop('user');
    eq(before, 1, 'click burst logged while recording');
    eq(ev5.filter((e) => e.type === 'click' && !e.filtered).length, 0, 'burst in the last 90 s (picking the phone up) hidden on stop');
    eq(ev5.filter((e) => e.filtered === 'handling').length, 1, '... but kept (filtered: handling), not deleted');
  }

  // room hum is not "buzzing"
  {
    const { labelNoise } = await import('../js/sound-shape.js');
    eq(labelNoise({ tonal: 0.65, stable: 0.9, burst: 0.05, band: 3 }, 10), 'other', '~80 Hz hum -> not buzz');
    eq(labelNoise({ tonal: 0.65, stable: 0.9, burst: 0.05, band: 14 }, 10), 'buzz', '~200 Hz steady tone -> buzz');
  }
  pass('only deviating sounds are logged; clicks counted + flagged; breathing rate stored');
}
