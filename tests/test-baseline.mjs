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
    };
    const engine = new AudioEngine({ storage, classifier: { minConfidence: 0.35, ready: true, async load() {}, classify: () => ({}) }, onEvent() {}, onEnergy() {}, onStatusChange() {} });
    Object.assign(engine, { session: { id: 's', startTime: 0 }, startWallTime: 0, ctxStartTime: 0, _recording: true, audioContext: { sampleRate: 16000 } });
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
  pass('only deviating sounds are logged; clicks counted + flagged; breathing rate stored');
}
