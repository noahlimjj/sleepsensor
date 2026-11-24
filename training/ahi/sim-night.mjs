// Runs the shipped detection chain (worklet DSP -> AudioEngine -> Classifier)
// over a real recording and reports which events it logs. With a PSG-Audio
// patient id it also scores them against the technicians' Snore and
// obstructive/hypopnea annotations.
//
//   node sim-night.mjs <audio file> [--t0 <sec>] [--sens 0.7] [--json]
//   node sim-night.mjs --psg <id> [--seg 001]
import { readFileSync, readdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

const ROOT = process.env.PSG_AUDIO_DIR || `${process.env.HOME}/datasets/psg-audio`;
const SR = 16000;
const Q = 128;

export function decode(file, { start = 0, dur = null } = {}) {
  const args = ['-v', 'error', '-ss', String(start), '-i', file];
  if (dur) args.push('-t', String(dur));
  args.push('-ac', '1', '-ar', String(SR), '-f', 'f32le', '-');
  const buf = execFileSync('ffmpeg', args, { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

let Proc = null;
function loadWorklet() {
  if (Proc) return Proc;
  const src = readFileSync(new URL('../../js/audio-worklet-processor.js', import.meta.url), 'utf8');
  const g = { t: 0 };
  class AWP { constructor() { this.port = { postMessage: (m) => this.port._sink && this.port._sink(m), onmessage: null }; } }
  let reg = null;
  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', '__g', `
    Object.defineProperty(globalThis, 'currentTime', { get: () => __g.t, configurable: true });
    ${src}`)(AWP, (n, c) => (reg = c), SR, g);
  Proc = { cls: reg, g };
  return Proc;
}

export async function simulate(samples, { sensitivity = 0.7, onReopen = null } = {}) {
  const { AudioEngine } = await import('../../js/audio-engine.js');
  const { Classifier } = await import('../../js/classifier.js');
  const { cls, g } = loadWorklet();
  const store = new Map();
  const windows = [];
  const classifier = await new Classifier().load();
  const engine = new AudioEngine({ classifier, storage: mockStorage(store), onEvent: () => {}, onEnergy: () => {}, onStatusChange: () => {} });
  engine.session = { id: 's', startTime: 0 };
  engine.startWallTime = 0;
  engine.ctxStartTime = 0;
  engine._recording = true;
  engine.audioContext = { sampleRate: SR };
  engine.setSensitivity ? engine.setSensitivity(sensitivity) : (engine.sensitivity = sensitivity);
  const eff = engine._effectiveType.bind(engine);
  let lastEff = null, lastSm = null;
  engine._effectiveType = (res, msg, raw) => { lastSm = res; lastEff = eff(res, msg, raw); return lastEff; };
  const reopen = engine._reopenMic.bind(engine);
  engine._reopenMic = (why, o) => { if (onReopen) onReopen(why); return reopen(why, o); };
  const proc = new cls();
  engine.workletNode = { port: { postMessage: (m) => proc._onMessage(m) }, disconnect() {} };
  proc.threshold = engine.noiseGate;
  proc.port._sink = (m) => {
    if (m.type === 'spectrogram' || m.type === 'silence') {
      const before = engine._lastRaw;
      engine._onWorkletMessage({ data: m });
      const r = m.type === 'spectrogram' ? engine._lastRaw : null;
      windows.push({ t: m.timestamp, rms: m.rms, type: r && r !== before ? r.type : 'silence', scores: r && r !== before ? r.scores : null, thr: engine.loudThreshold(), floor: engine.ambientFloor(), eff: lastEff && lastEff.type, sm: lastSm && lastSm.type });
    } else if (m.type !== 'energy' && m.type !== 'audio-clip') engine._onWorkletMessage({ data: m });
  };
  const frame = new Float32Array(Q);
  for (let i = 0; i + Q <= samples.length; i += Q) {
    frame.set(samples.subarray(i, i + Q));
    g.t = (i + Q) / SR;
    proc.process([[frame]]);
  }
  engine._finalizePending && engine._finalizePending();
  await new Promise((r) => setTimeout(r, 0));
  return { events: [...store.values()].sort((a, b) => a.timestamp - b.timestamp), windows, engine };
}

function mockStorage(store) {
  const ok = async (x) => x;
  return {
    createSession: ok, updateSession: ok, setSetting: ok, saveClip: ok, saveHighlight: ok, updateHighlight: ok, deleteHighlight: ok,
    getClipsBySession: async () => [], getHighlightsBySession: async () => [],
    async addEvent(e) { store.set(e.id, { ...e }); return e; },
    async updateEvent(id, u) { if (store.has(id)) Object.assign(store.get(id), u); return u; },
  };
}

function parseRml(id) {
  const xml = readFileSync(join(ROOT, 'rml', `${id}.rml`), 'utf8');
  const re = /<Event Family="(\w+)" Type="(\w+)" Start="([\d.]+)" Duration="([\d.]+)"/g;
  const out = [];
  for (let m; (m = re.exec(xml)); ) out.push({ type: m[2], start: +m[3], dur: +m[4] });
  return out;
}

const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

export function score(events, ref, t0, t1) {
  const ev = events.map((e) => ({ type: e.type, s: t0 + e.timestamp / 1000, e: t0 + e.timestamp / 1000 + (e.duration || 0) }));
  const sn = ref.filter((r) => r.type === 'Snore' && r.start >= t0 && r.start < t1);
  const ob = ref.filter((r) => /Obstructive|Hypopnea|Mixed/.test(r.type) && r.start >= t0 && r.start < t1);
  const hit = (r, types) => ev.some((e) => types.includes(e.type) && overlaps(e.s - 2, e.e + 2, r.start, r.start + r.dur));
  return {
    snoreRef: sn.length,
    snoreAsSnoring: sn.filter((r) => hit(r, ['snoring'])).length,
    snoreAsAny: sn.filter((r) => hit(r, ['snoring', 'noise', 'bruxism'])).length,
    obstructRef: ob.length,
    obstructAsAny: ob.filter((r) => hit(r, ['snoring', 'noise', 'bruxism', 'apnea'])).length,
    events: Object.entries(events.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {})).map(([k, v]) => `${k}:${v}`).join(' '),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const sens = +opt('--sens', 0.7);
  if (a.includes('--psg')) {
    const ids = opt('--psg') === 'all' ? readdirSync(join(ROOT, 'audio')) : [opt('--psg')];
    const tot = {};
    for (const id of ids) {
      for (const f of readdirSync(join(ROOT, 'audio', id)).filter((x) => x.endsWith('.flac'))) {
        const seg = +f.slice(0, 3);
        const t0 = (seg - 1) * 3600;
        const dur = +opt('--dur', 3600);
        const s = decode(join(ROOT, 'audio', id, f), { dur });
        const { events } = await simulate(s, { sensitivity: sens });
        const r = score(events, parseRml(id), t0, t0 + s.length / SR);
        for (const k of Object.keys(r)) if (typeof r[k] === 'number') tot[k] = (tot[k] || 0) + r[k];
        console.log(id.slice(4, 8), f.slice(0, 3), JSON.stringify(r));
      }
    }
    console.log('TOTAL', JSON.stringify(tot));
  } else {
    const file = a[0];
    if (!file || !existsSync(file)) throw new Error('usage: sim-night.mjs <audio> | --psg <id|all>');
    const { events, windows } = await simulate(decode(file), { sensitivity: sens });
    const t0 = +opt('--t0', 0);
    for (const e of events) console.log(((t0 + e.timestamp / 1000) | 0) + 's', e.type, e.duration, e.confidence);
    if (a.includes('--windows')) for (const w of windows) console.log(w.t.toFixed(0), w.type, (20 * Math.log10(w.rms + 1e-9)).toFixed(1), (20 * Math.log10(w.thr)).toFixed(1), w.scores ? JSON.stringify(w.scores) : '');
  }
}
