// A muted / dead microphone must not pass for a quiet night: the engine spots
// dead air, reopens the mic, and logs the gap. Runs real audio through the
// shipped worklet -> engine -> classifier chain (training/ahi/sim-night.mjs).
import { section, ok, eq, pass } from './lib.mjs';
import { readWavMono } from '../training/wav.mjs';
import { simulate } from '../training/ahi/sim-night.mjs';
import { AudioEngine } from '../js/audio-engine.js';

const SR = 16000;
const fixture = new URL('./fixtures/psg-snore-room.wav', import.meta.url).pathname;

function night(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const room = (sec, level = 3e-4) => {
  const a = new Float32Array(sec * SR);
  for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 2 - 1) * level;
  return a;
};
const zeros = (sec) => new Float32Array(sec * SR);

export async function run() {
  section('listening — real snoring through the full chain, dead-mic recovery');
  const { samples, sampleRate } = readWavMono(fixture);
  eq(sampleRate, SR, 'fixture is 16 kHz');
  const snore = samples;

  // 1) real snoring after a quiet room is flagged as snoring
  {
    const { events, engine } = await simulate(night([room(20), snore, room(10)]));
    ok(events.some((e) => e.type === 'snoring'), `snoring logged (${events.map((e) => e.type).join(',') || 'nothing'})`);
    eq(engine._listeningPatch().listenGaps.length, 0, 'no listening gap on a live mic');
  }

  // 2) the mic goes dead mid-night (muted track => digital zeros), then snoring
  {
    const reopened = [];
    const { events, engine } = await simulate(night([room(20), zeros(30), room(5), snore, room(10)]), {
      onReopen: (why) => reopened.push(why),
    });
    ok(reopened.includes('mic-silent'), `dead air triggers a mic reopen (${reopened.join(',') || 'none'})`);
    const p = engine._listeningPatch();
    ok(p.listenGaps.length >= 1 && p.deafSec >= 4, `gap logged (${p.deafSec}s)`);
    eq(p.listenGaps[0].reason, 'mic-silent', 'gap reason');
    ok(p.trace.some((r) => r.z > 0), 'per-minute trace counts dead windows');
    ok(events.some((e) => e.type === 'snoring'), 'snoring after the gap is still caught');
  }

  // 3) reopen swaps in a fresh mic stream and releases the dead one
  {
    const track = (muted = false) => ({ muted, readyState: 'live', stopped: false, stop() { this.stopped = true; } });
    const deadTrack = track(true);
    const freshTrack = track();
    const connected = [];
    const g = globalThis;
    const hadNav = Object.getOwnPropertyDescriptor(g, 'navigator');
    Object.defineProperty(g, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [freshTrack], getTracks: () => [freshTrack] }) } } });
    try {
      const engine = new AudioEngine({ storage: null, onEvent() {}, onEnergy() {}, onStatusChange() {} });
      engine._recording = true;
      engine.session = { id: 's' };
      engine.mediaStream = { getAudioTracks: () => [deadTrack], getTracks: () => [deadTrack] };
      engine.workletNode = { port: { postMessage() {} } };
      engine.sourceNode = { disconnect() {} };
      engine.audioContext = { state: 'running', createMediaStreamSource: (st) => ({ connect: (n) => connected.push([st, n]), disconnect() {} }) };
      engine._checkMic('after-interruption');
      await new Promise((r) => setTimeout(r, 10));
      ok(deadTrack.stopped, 'dead (muted) track released');
      eq(engine._audioTrack(), freshTrack, 'fresh mic track in use');
      eq(connected.length, 1, 'fresh source wired into the worklet');
      eq(engine._micReopens, 1, 'reopen counted');
      engine._audioTrack().onmute();
      ok(engine._deafSince > 0, 'a muted track opens a listening gap');
    } finally {
      if (hadNav) Object.defineProperty(g, 'navigator', hadNav); else delete g.navigator;
    }
  }

  pass('dead mic is detected and logged; real snoring is caught');
}
