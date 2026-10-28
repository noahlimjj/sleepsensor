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
    disconnect: () => {},
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
// a session starts with the room's background, which seeds the ambient floor
const prime = (engine) => engine._handleClassification(...QUIET(0));

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
    prime(engine);
    for (const t of [2, 4, 6]) engine._handleClassification(...W('other', 0, t, 0.08, 0.15));
    eq(calls.events.length, 1, 'loud unrecognised sound -> one event');
    eq(calls.events[0].type, 'noise', 'event type is noise');
    eq(engine._tally.noiseEpisodes, 1, 'noise episode counted');
  }

  // --- soft speech (rms ~0.015) still registers as noise ---
  {
    const { engine, calls } = makeEngine();
    prime(engine);
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
    // below the default noise gate (~-68 dBFS), i.e. a silent room
    engine._considerHighlight({ type: 'silence', timestamp: 5, rms: 0.0002, peak: 0.0004 }, { type: 'silence', confidence: 0 });
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
    // (the very loud window itself is still logged as a generic sound)
    eq(calls.events.filter((e) => e.type !== 'noise').length, 0, 'one spurious classification does not survive smoothing');
    const before = calls.events.length;

    next = { snoring: 0.85, noise: 0.15 };
    rms = 0.15;
    for (let i = 0; i < 6; i++) send();
    eq(calls.events.length - before, 1, 'a sustained snoring stream produces one event');
    eq(calls.events[calls.events.length - 1].type, 'snoring', 'smoothed event type is snoring');
  }

  // --- breathing pause: snoring → silence → snort produces an apnea event,
  //     stored, tallied, emitted, with a clip covering the pause ---
  {
    const { engine, calls } = makeEngine();
    let verdict = { type: 'snoring', confidence: 0.8, scores: { snoring: 0.8, noise: 0.2 } };
    let t = 0;
    const spec = (rms) =>
      engine._onWorkletMessage({ data: { type: 'spectrogram', data: new Float32Array(8), timestamp: (t += 2), rms, peak: rms * 2 } });
    const silent = () => engine._onWorkletMessage({ data: { type: 'silence', timestamp: (t += 2), rms: 0.0008, peak: 0.002 } });
    engine.classifier.classify = () => verdict;

    for (let i = 0; i < 4; i++) spec(0.1);
    for (let i = 0; i < 7; i++) silent();
    calls.clipReq.length = 0;
    spec(0.15); // snort

    const apnea = calls.events.find((e) => e.type === 'apnea');
    ok(apnea, 'apnea event emitted through onEvent');
    eq(apnea && apnea.duration, 14, 'emitted pause duration');
    ok(calls.added.some((e) => e.type === 'apnea' && e.sessionId === 'sess-1' && e.endTime > e.startTime), 'apnea event stored');
    eq(engine._tally.apneaEvents, 1, 'apnea tallied');
    eq(engine._tally.apneaDuration, 14, 'pause seconds tallied');
    const req = calls.clipReq.at(-1); // the snort may also request a loudest-moment clip first
    ok(req && req.endTime - req.startTime === 16, 'clip spans the pause tail and the arousal');
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

  // --- adaptive floor: in a quiet room a soft sound well under the old fixed
  //     -38 dBFS bar is still logged; a steady fan at the same level is not ---
  {
    const { engine, calls } = makeEngine();
    let t = 0;
    for (let i = 0; i < 20; i++) engine._handleClassification(...W('other', 0, (t += 2), 0.0015, 0.003));
    eq(calls.events.length, 0, 'steady quiet background produces no events');
    for (let i = 0; i < 3; i++) engine._handleClassification(...W('other', 0, (t += 2), 0.005, 0.01));
    eq(calls.events.length, 1, 'soft sound ~10 dB above a quiet floor is logged (-46 dBFS)');

    const fan = makeEngine();
    t = 0;
    for (let i = 0; i < 60; i++) fan.engine._handleClassification(...W('other', 0, (t += 2), 0.005, 0.01));
    ok(fan.calls.events.length <= 1, 'a constant fan logs at most once while the floor is learned');
    eq(fan.engine._pending, null, 'and stops registering once learned');
    ok(fan.engine.ambientFloor() > 0.004, 'floor converges on the fan level');
  }

  // --- a brief sound inside an otherwise quiet window (activeRms) ---
  {
    const { engine, calls } = makeEngine();
    let t = 0;
    for (let i = 0; i < 10; i++) engine._handleClassification(...QUIET((t += 2)));
    const msg = { type: 'spectrogram', timestamp: (t += 2), rms: 0.003, activeRms: 0.03, peak: 0.06 };
    engine._handleClassification({ type: 'other', confidence: 0 }, msg);
    eq(calls.events.length, 1, 'a short cough diluted in a 2 s average still logs on its own');
  }

  // --- confident raw snore is not swallowed by the HMM at high sensitivity ---
  {
    const { engine, calls } = makeEngine();
    engine.setSensitivity(0.7);
    const quietSmoothed = { type: 'quiet', confidence: 0.7 };
    const m = (ts) => ({ type: 'spectrogram', timestamp: ts, rms: 0.004, peak: 0.01 });
    engine._handleClassification(quietSmoothed, m(2), { type: 'snoring', confidence: 0.75 });
    engine._handleClassification(quietSmoothed, m(4), { type: 'snoring', confidence: 0.75 });
    eq(calls.events.length, 1, 'two confident raw snore windows log despite HMM lag');
    eq(calls.events[0].type, 'snoring', 'logged as snoring');
  }

  // --- worklet gate uses the loudest short slice ---
  {
    const { dsp } = await import('./load-worklet.mjs');
    const buf = new Float32Array(32000);
    for (let i = 10000; i < 11600; i++) buf[i] = 0.1 * Math.sin(i / 3);
    ok(dsp.maxFrameRms(buf) > 0.05 && dsp.rms(buf) < 0.02, 'maxFrameRms sees a 100 ms burst the 2 s RMS hides');
    ok(dsp.quietFrameRms(buf) < 0.001, 'quietFrameRms ignores the burst');
  }

  // --- a bout that starts as generic noise is upgraded once snoring shows ---
  {
    const { engine, calls } = makeEngine();
    prime(engine);
    engine._handleClassification(...W('other', 0, 2, 0.05, 0.1)); // loud -> noise, confirmed at once
    eq(calls.events.length, 1, 'loud first window logged immediately');
    eq(calls.events[0].type, 'noise', 'as noise');
    engine._handleClassification(...W('snoring', 0.8, 4));
    engine._handleClassification(...W('snoring', 0.8, 6));
    const last = calls.events[calls.events.length - 1];
    eq(last.type, 'snoring', 'upgraded to snoring');
    eq(last.upgradedFrom, 'noise', 'upgrade notice names the old type');
    eq(last.eventId, calls.events[0].eventId, 'same event, not a new one');
    eq(engine._tally.noiseEpisodes, 0, 'noise tally moved');
    eq(engine._tally.snoringEpisodes, 1, 'to snoring');
    ok(calls.updated.some((u) => u.type === 'snoring'), 'stored event retyped');
  }

  // --- a lone loud window the model calls snoring is kept, as a sound ---
  {
    const { engine, calls } = makeEngine();
    prime(engine);
    engine._handleClassification(...W('snoring', 0.7, 2, 0.05, 0.1));
    engine._handleClassification(...QUIET(4));
    engine._handleClassification(...QUIET(6));
    eq(calls.events.length, 1, 'one-off loud "snore" (a cough) is not dropped');
    eq(calls.events[0].type, 'noise', 'logged as a generic sound');
  }

  // --- a long bout does not get absorbed into the floor ---
  {
    const { engine, calls } = makeEngine();
    prime(engine);
    let t = 0;
    for (let i = 0; i < 150; i++) {
      const msg = { type: 'spectrogram', timestamp: (t += 2), rms: 0.004, activeRms: 0.006, quietRms: 0.0006, peak: 0.01 };
      engine._handleClassification({ type: 'other', confidence: 0 }, msg);
    }
    ok(engine._pending && engine._pending.emitted, 'still inside one event after 5 minutes');
    eq(calls.events.length, 1, 'one continuous event');
    ok(engine.ambientFloor() < 0.001, 'floor follows the gaps, not the sound');
  }

  // --- dB: A-weighting matches IEC 61672 at the reference frequencies ---
  {
    const { dsp } = await import('./load-worklet.mjs');
    const expected = { 31.5: -39.4, 100: -19.1, 1000: 0, 4000: 1.0, 8000: -1.1 };
    for (const fs of [44100, 48000]) {
      for (const [f, want] of Object.entries(expected)) {
        const m = dsp.createLevelMeter(fs);
        const b = new Float32Array(fs * 2);
        for (let i = 0; i < b.length; i++) b[i] = Math.sin((2 * Math.PI * Number(f) * i) / fs);
        m.process(b.subarray(0, fs)); // settle
        const r = m.process(b.subarray(fs));
        const got = 10 * Math.log10(r.sumSq / r.n / 0.5);
        ok(Math.abs(got - want) <= 1.0, `A-weighting @${f} Hz/${fs}: ${got.toFixed(1)} dB (IEC ${want})`);
      }
    }
    // Fast (125 ms) time weighting: a tone burst reaches ~full level within ~0.5 s
    const fs = 48000, m = dsp.createLevelMeter(fs);
    const b = new Float32Array(fs / 2);
    for (let i = 0; i < b.length; i++) b[i] = Math.sin((2 * Math.PI * 1000 * i) / fs);
    const r = m.process(b);
    ok(Math.abs(10 * Math.log10(r.fastSq / 0.5)) < 0.5, 'Fast-weighted level settles to the tone level');
  }

  // --- dB: calibration maps the current level onto the reference reading ---
  {
    const { engine } = makeEngine();
    ok(engine.dbCalibrated === false, 'uncalibrated by default');
    eq(engine.calibrateTo(50), null, 'cannot calibrate before the mic is heard');
    for (let i = 0; i < 2000; i++) engine._onWorkletMessage({ data: { type: 'energy', rms: 0.01, peak: 0.02, laf: 0.001 } });
    const off = engine.calibrateTo(52);
    ok(Math.abs(off - 112) < 0.2, `offset = 52 - (-60 dBFS) = 112 (${off})`);
    eq(engine.getLevel().dbA, 52, 'meter now reads the reference level');
    ok(engine.getLevel().calibrated, 'marked calibrated');
    engine.resetDbCalibration();
    ok(!engine.dbCalibrated && engine.dbOffset === 105, 'reset restores the default');
  }

  // --- dB: events and the night carry A-weighted levels ---
  {
    const { engine, calls } = makeEngine();
    engine.setDbCalibration(100, true);
    prime(engine);
    const msg = (t, laeq, lafMax) => ({ type: 'spectrogram', timestamp: t, rms: 0.05, peak: 0.1, laeq, lafMax });
    engine._onWorkletMessage({ data: { ...msg(2, 0.01, 0.03), data: new Float32Array(8) } });
    engine.classifier.classify = () => ({ type: 'other', confidence: 0, scores: {} });
    engine._handleClassification({ type: 'other', confidence: 0 }, msg(4, 0.01, 0.03));
    const ev = calls.events[calls.events.length - 1];
    ok(ev && Math.abs(ev.peakDbA - 69.5) < 0.2, `event peak = LAFmax in dBA (${ev && ev.peakDbA})`);
    ok(ev && Math.abs(ev.laeqDbA - 60) < 0.2, `event average = LAeq in dBA (${ev && ev.laeqDbA})`);
    const night = engine._nightDbA();
    ok(Math.abs(night.loudestDbA - 69.5) < 0.2 && night.laeqDbA != null, 'night LAeq and loudest dBA tracked');
  }

  // --- WAV encoding still intact ---
  {
    const blob = float32ToWav(new Float32Array(16000), 16000);
    eq(blob.type, 'audio/wav', 'wav blob mime type');
    eq(blob.size, 44 + 32000, 'wav blob size');
  }

  // --- checkpointing persists running tallies to the session ---
  {
    const { engine, calls } = makeEngine();
    calls.sessionUpdates = [];
    engine.storage.updateSession = async (id, u) => {
      calls.sessionUpdates.push(u);
      return { id, ...u };
    };
    engine.startWallTime = Date.now();
    engine._tally.snoringEpisodes = 3;
    engine._tally.snoringDuration = 90;
    engine._checkpoint();
    const cp = calls.sessionUpdates.at(-1);
    ok(cp && typeof cp.lastCheckpoint === 'number', 'checkpoint writes lastCheckpoint');
    eq(cp.snoringEpisodes, 3, 'checkpoint persists running episode counts');
    eq(cp.snoringDuration, 90, 'checkpoint persists running durations');
  }

  // --- safety auto-stop after MAX_SESSION_MS ---
  {
    const { engine, calls } = makeEngine();
    let stoppedWith = null;
    engine.stop = async (r) => { stoppedWith = r; engine._recording = false; };
    engine.startWallTime = Date.now() - 15 * 60 * 60 * 1000; // 15h ago
    engine._checkpoint();
    eq(stoppedWith, 'max-duration', 'a 15h session auto-stops with reason "max-duration"');
  }

  // --- interruption: pause then auto-resume ---
  {
    const { engine, calls } = makeEngine();
    const statuses = [];
    engine.onStatusChange = (s) => statuses.push(s);
    engine.audioContext = { state: 'suspended', resume: async () => {} };
    engine._onInterruption(true);
    ok(statuses.includes('interrupted'), 'interruption -> "interrupted" status');
    engine._onInterruption(false);
    ok(statuses.at(-1) === 'recording', 'interruption end -> back to "recording"');
    eq(engine._interrupted, false, 'interrupted flag cleared');
  }

  // --- stop(reason) tags the summary ---
  {
    const { engine } = makeEngine();
    engine.startWallTime = Date.now() - 5000;
    engine._recording = true;
    const summary = await engine.stop('storage-full');
    eq(summary.stopReason, 'storage-full', 'stop(reason) is recorded on the summary');
  }

  pass('audio-engine behaves correctly');
}
