// audio-engine.js — event debounce, noise fallback, loudest-moment highlights,
// dB reporting and the sensitivity helper. No real audio graph.
import { section, ok, eq, pass } from './lib.mjs';
import { AudioEngine, float32ToWav, sensitivityToThreshold } from '../js/audio-engine.js';

function makeEngine() {
  const calls = { events: [], added: [], updated: [], clips: [], highlights: [], clipReq: [], energy: [] };
  const storage = {
    async createSession(s) { return { id: 'sess-1', startTime: s.startTime, endTime: null }; },
    async updateSession(id, u) { return { id, ...u }; },
    async addEvent(e) { calls.added.push(e); return e; },
    async updateEvent(id, u) { calls.updated.push({ id, ...u }); return { id, ...u }; },
    async saveClip(c) { calls.clips.push(c); return c; },
    async saveHighlight(h) { calls.highlights.push(h); return h; },
    async updateHighlight(id, u) { return { id, ...u }; },
    async deleteHighlight() {},
    async getClipsBySession() { return calls.clips; },
    async getHighlightsBySession() { return calls.highlights; },
    async setSetting() {},
  };
  const classifier = { minConfidence: 0.35, ready: true, async load() {}, classify: () => ({ type: 'other', confidence: 0 }) };
  const engine = new AudioEngine({
    storage,
    classifier,
    onEnergy: (rms, db) => calls.energy.push({ rms, db }),
    onEvent: (e) => calls.events.push(e),
    onStatusChange: () => {},
  });
  engine.session = { id: 'sess-1', startTime: 0 };
  engine.startWallTime = 0;
  engine.ctxStartTime = 0;
  engine._recording = true;
  engine.audioContext = { sampleRate: 16000 };
  engine.workletNode = {
    port: { postMessage: (m) => m.command === 'extract-clip' && calls.clipReq.push(m) },
  };
  return { engine, calls };
}

// worklet-style spectrogram message
const W = (type, conf, t, rms = 0.2, peak = 0.3) => [
  { type, confidence: conf },
  { type: 'spectrogram', timestamp: t, rms, peak, data: new Float32Array(8) },
];
const QUIET = (t) => [
  { type: 'silence', confidence: 0 },
  { type: 'silence', timestamp: t, rms: 0.0005, peak: 0.001 },
];

export async function run() {
  section('audio-engine.js — debounce, noise, highlights, dB');

  // --- 2 consecutive smoothed positives confirm exactly one event ---
  {
    const { engine, calls } = makeEngine();
    engine._handleClassification(...W('snoring', 0.7, 2));
    eq(calls.events.length, 0, 'no event after 1 positive');
    engine._handleClassification(...W('snoring', 0.7, 4));
    eq(calls.events.length, 1, 'event confirmed on the 2nd consecutive positive');
    engine._handleClassification(...W('snoring', 0.7, 6));
    eq(calls.events.length, 1, 'still one event while it continues');
    eq(calls.events[0].type, 'snoring', 'type snoring');
    ok(typeof calls.events[0].peakDb === 'number' && calls.events[0].peakDb < 0, 'event carries a peak dBFS');
    ok(calls.events[0].severity === 'moderate', 'confidence 0.7 -> moderate');
  }

  // --- a loud but unclassified window becomes a generic "noise" event ---
  {
    const { engine, calls } = makeEngine();
    for (const t of [2, 4, 6]) engine._handleClassification(...W('other', 0, t, 0.08, 0.15));
    eq(calls.events.length, 1, 'loud unrecognised sound -> one event');
    eq(calls.events[0].type, 'noise', 'event type is noise');
    eq(engine._tally.noiseEpisodes, 1, 'noise episode counted');
  }

  // --- soft speech (rms ~0.015) still registers as noise ---
  {
    const { engine, calls } = makeEngine();
    for (const t of [2, 4, 6]) engine._handleClassification(...W('other', 0, t, 0.015, 0.03));
    eq(calls.events.length, 1, 'soft sound above the ambient floor is still logged');
    eq(calls.events[0].type, 'noise', 'soft sound -> noise event');
  }

  // --- genuinely quiet windows never create an event ---
  {
    const { engine, calls } = makeEngine();
    for (const t of [2, 4, 6, 8]) engine._handleClassification(...QUIET(t));
    eq(calls.events.length, 0, 'silence produces no events');
  }

  // --- event ends after 2 negatives -> clip requested, duration tallied ---
  {
    const { engine, calls } = makeEngine();
    for (const t of [2, 4, 6, 8, 10]) engine._handleClassification(...W('bruxism', 0.8, t));
    engine._handleClassification(...QUIET(12));
    engine._handleClassification(...QUIET(14));
    ok(calls.clipReq.some((r) => r.startTime < 6 && r.endTime > 10), 'an event clip spanning the bout was requested');
    ok(engine._tally.bruxismDuration > 0, 'bruxism duration tallied');
  }

  // --- loudest-moment highlights: top-N by peak, clip + row persisted ---
  {
    const { engine, calls } = makeEngine();
    let t = 2;
    for (const peak of [0.2, 0.9, 0.3, 0.5, 0.95, 0.1]) {
      engine._considerHighlight({ type: 'spectrogram', timestamp: t, rms: peak * 0.6, peak }, { type: 'noise', confidence: 0.6 });
      t += 40; // spread out so they don't collapse
    }
    ok(calls.highlights.length >= 2, `highlights persisted (${calls.highlights.length})`);
    ok(engine._highlights[0].peak >= engine._highlights[engine._highlights.length - 1].peak, 'highlights kept sorted loudest-first');
    ok(calls.clipReq.some((r) => r.command === 'extract-clip'), 'highlight clip extraction requested');
    ok(engine._tally.loudestDb > -20, 'loudest dB tracked near full scale');
  }

  // --- highlights collapse repeats of the same loud bout ---
  {
    const { engine } = makeEngine();
    engine._considerHighlight({ type: 'spectrogram', timestamp: 10, rms: 0.3, peak: 0.5 }, { type: 'noise', confidence: 0.5 });
    engine._considerHighlight({ type: 'spectrogram', timestamp: 12, rms: 0.3, peak: 0.6 }, { type: 'noise', confidence: 0.5 });
    eq(engine._highlights.length, 1, 'two windows 2s apart collapse into one highlight');
    ok(engine._highlights[0].peak === 0.6, 'collapsed highlight keeps the louder peak');
  }

  // --- a loud TRANSIENT (high peak, low average) is still captured, even
  //     when the classifier has no idea what it is ---
  {
    const { engine, calls } = makeEngine();
    // e.g. a door slam: 0.4 peak, but the 2s window RMS is only ~0.006
    engine._considerHighlight(
      { type: 'silence', timestamp: 30, rms: 0.006, peak: 0.4 },
      { type: 'other', confidence: 0.1 }
    );
    eq(engine._highlights.length, 1, 'loud transient captured despite low window RMS');
    eq(calls.highlights[0].classifiedAs, 'unknown', 'unclassified loud sound is tagged "unknown"');
    ok(calls.clipReq.length >= 1, 'a clip is pulled for the transient');
    ok(engine._tally.loudestDb > -12, `loudest dB reflects the peak (${engine._tally.loudestDb.toFixed(1)})`);
  }

  // --- a genuinely quiet window creates no highlight but still updates loudestDb ---
  {
    const { engine, calls } = makeEngine();
    engine._considerHighlight({ type: 'silence', timestamp: 5, rms: 0.0008, peak: 0.002 }, { type: 'silence', confidence: 0 });
    eq(engine._highlights.length, 0, 'quiet window is not a highlight');
    eq(calls.highlights.length, 0, 'nothing persisted for a quiet window');
    ok(engine._tally.loudestDb < -40, 'loudestDb still tracks the (quiet) peak');
  }

  // --- clip routing: highlight clips flagged, event clips flag the event ---
  {
    const { engine, calls } = makeEngine();
    for (const t of [2, 4, 6, 8]) engine._handleClassification(...W('bruxism', 0.9, t));
    engine._handleClassification(...QUIET(10));
    engine._handleClassification(...QUIET(12));
    await engine._handleClip({ type: 'audio-clip', buffer: new Float32Array(16000), startTime: 0, endTime: 1 });
    eq(calls.clips.length, 1, 'clip saved');
    eq(calls.clips[0].clipType, 'event', 'event clip tagged clipType=event');
    ok(calls.updated.some((u) => u.hasClip === true), 'event flagged hasClip');
  }

  // --- HMM smoothing: routed through _onWorkletMessage, one spurious window
  //     must not create an event; a sustained stream must ---
  {
    const { engine, calls } = makeEngine();
    let next = { quiet: 0.9, noise: 0.1 };
    let rms = 0.001;
    engine.classifier.classify = () => ({ type: 'quiet', confidence: 0.9, scores: next });
    const send = () =>
      engine._onWorkletMessage({
        data: { data: new Float32Array(8), type: 'spectrogram', timestamp: (engine._t = (engine._t || 0) + 2), rms, peak: rms * 1.5 },
      });

    for (let i = 0; i < 4; i++) send();
    next = { bruxism: 0.6, snoring: 0.2, noise: 0.2 }; // one odd window
    rms = 0.2;
    send();
    next = { quiet: 0.9, noise: 0.1 };
    rms = 0.001;
    for (let i = 0; i < 3; i++) send();
    eq(calls.events.length, 0, 'one spurious classification does not survive smoothing');

    next = { snoring: 0.85, noise: 0.15 };
    rms = 0.15;
    for (let i = 0; i < 6; i++) send();
    eq(calls.events.length, 1, 'a sustained snoring stream produces one event');
    eq(calls.events[0].type, 'snoring', 'smoothed event type is snoring');
  }

  // --- live dB meter ---
  {
    const { engine, calls } = makeEngine();
    engine._onWorkletMessage({ data: { type: 'energy', rms: 0.05, peak: 0.1 } });
    eq(calls.energy.length, 1, 'onEnergy called for an energy message');
    ok(calls.energy[0].db < 0 && calls.energy[0].db > -60, `onEnergy passes a dBFS value (${calls.energy[0].db})`);
    const lvl = engine.getLevel();
    ok(lvl.dbFS < 0 && lvl.spl > 0, 'getLevel() returns dBFS and an SPL estimate');
  }

  // --- sensitivity helper ---
  {
    const { engine } = makeEngine();
    ok(sensitivityToThreshold(0) > sensitivityToThreshold(0.5), 'higher sensitivity lowers the gate');
    ok(sensitivityToThreshold(1) < 0.001, 'max sensitivity gate is very low');
    const d = engine.describeSensitivity(0.5);
    ok(d.label && d.detail && typeof d.thresholdDbFS === 'number', 'describeSensitivity returns label/detail/threshold');
    ok(engine.describeSensitivity(0.9).label === 'Maximum', 'high value -> "Maximum"');
  }

  // --- WAV encoding still intact ---
  {
    const blob = float32ToWav(new Float32Array(16000), 16000);
    eq(blob.type, 'audio/wav', 'wav blob mime type');
    eq(blob.size, 44 + 32000, 'wav blob size');
  }

  pass('audio-engine behaves correctly');
}
