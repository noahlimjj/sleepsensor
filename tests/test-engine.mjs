// AudioEngine event debounce / lifecycle logic (no real audio graph).
import { section, ok, eq, pass } from './lib.mjs';
import { AudioEngine } from '../js/audio-engine.js';

function makeEngine() {
  const calls = { events: [], added: [], updated: [], clips: [], clipRequests: [] };
  const storage = {
    async createSession(s) { return { id: 'sess-1', startTime: s.startTime, endTime: null }; },
    async updateSession(id, u) { return { id, ...u }; },
    async addEvent(e) { calls.added.push(e); return e; },
    async updateEvent(id, u) { calls.updated.push({ id, ...u }); return { id, ...u }; },
    async saveClip(c) { calls.clips.push(c); return c; },
    async getClipsBySession() { return calls.clips; },
    async setSetting() {},
  };
  const classifier = { minConfidence: 0.35, ready: true, async load() {}, classify() {} };
  const engine = new AudioEngine({
    storage,
    classifier,
    onEvent: (e) => calls.events.push(e),
    onStatusChange: () => {},
  });
  // wire minimal state as if start() had run
  engine.session = { id: 'sess-1', startTime: 0 };
  engine.startWallTime = 0;
  engine.ctxStartTime = 0;
  engine._recording = true;
  engine.workletNode = {
    port: { postMessage: (m) => { if (m.command === 'extract-clip') calls.clipRequests.push(m); } },
  };
  return { engine, calls };
}

const P = (type, confidence = 0.7) => ({ type, confidence });
const NEG = { type: 'silence', confidence: 0 };

export async function run() {
  section('audio-engine.js — event debounce & lifecycle');

  // --- 3 consecutive positives confirm exactly one event ---
  {
    const { engine, calls } = makeEngine();
    engine._handleClassification(P('snoring'), 2);
    engine._handleClassification(P('snoring'), 4);
    eq(calls.events.length, 0, 'no event after 2 positives');
    engine._handleClassification(P('snoring'), 6);
    eq(calls.events.length, 1, 'event confirmed on the 3rd consecutive positive');
    eq(calls.events[0].type, 'snoring', 'event type is snoring');
    eq(calls.added.length, 1, 'confirmed event written to storage');
    ok(calls.events[0].duration >= 2, 'event has a positive duration');
    ok(calls.events[0].severity === 'moderate', 'confidence 0.7 -> moderate severity');
  }

  // --- 2 positives then a gap: no event ---
  {
    const { engine, calls } = makeEngine();
    engine._handleClassification(P('bruxism'), 2);
    engine._handleClassification(P('bruxism'), 4);
    engine._handleClassification(NEG, 6);
    engine._handleClassification(NEG, 8);
    eq(calls.events.length, 0, 'interrupted run of 2 never becomes an event');
  }

  // --- event ends after 2 negatives -> clip requested, duration tallied ---
  {
    const { engine, calls } = makeEngine();
    for (const t of [2, 4, 6, 8, 10]) engine._handleClassification(P('snoring', 0.8), t);
    await engine._handleClassification(NEG, 12);
    await engine._handleClassification(NEG, 14);
    eq(calls.clipRequests.length, 1, 'clip extraction requested when event ends');
    const req = calls.clipRequests[0];
    ok(req.startTime < 6 && req.endTime > 10, 'clip range pads around the event (±5s)');
    ok(engine._tally.snoringDuration > 0, 'snoring duration accumulated into session tally');
    eq(engine._tally.snoringEpisodes, 1, 'one snoring episode counted');
  }

  // --- switching type finalises the first event and starts a second ---
  {
    const { engine, calls } = makeEngine();
    for (const t of [2, 4, 6]) engine._handleClassification(P('snoring'), t);
    for (const t of [8, 10, 12]) engine._handleClassification(P('bruxism'), t);
    eq(calls.events.length, 2, 'type switch produces a second confirmed event');
    eq(calls.events[1].type, 'bruxism', 'second event is bruxism');
  }

  // --- low-confidence positives are ignored ---
  {
    const { engine, calls } = makeEngine();
    for (const t of [2, 4, 6]) engine._handleClassification(P('snoring', 0.2), t);
    eq(calls.events.length, 0, 'positives below minConfidence do not confirm');
  }

  // --- clip received -> stored as WAV, event flagged ---
  {
    const { engine, calls } = makeEngine();
    for (const t of [2, 4, 6, 8]) engine._handleClassification(P('bruxism', 0.9), t);
    await engine._handleClassification(NEG, 10);
    await engine._handleClassification(NEG, 12);
    engine.audioContext = { sampleRate: 16000 };
    await engine._handleClip({ type: 'audio-clip', buffer: new Float32Array(16000), startTime: 0, endTime: 1 });
    eq(calls.clips.length, 1, 'received clip saved to storage');
    eq(calls.clips[0].format, 'wav', 'clip saved as wav');
    ok(calls.clips[0].audioBlob && calls.clips[0].audioBlob.size > 44, 'clip blob is a real WAV');
    ok(calls.updated.some((u) => u.hasClip === true), 'event marked hasClip after clip stored');
  }

  pass('audio-engine debounce & lifecycle behave correctly');
}
