// night-export.js — native share-sheet export and the nightly Files copy.
import { section, ok, eq, pass } from './lib.mjs';
import { exportNight, autoSaveNight, nightFiles, nightStamp } from '../js/night-export.js';
import { float32ToWav } from '../js/audio-engine.js';

function fakeStorage() {
  const t0 = new Date(2026, 10, 23, 23, 40).getTime();
  const big = new Float32Array(16000 * 20).map((_, i) => Math.sin(i / 7) * 0.2); // 20 s => > 1 chunk
  const sessions = [
    { id: 'old', startTime: t0 - 86400000, listenGaps: [] },
    { id: 'last', startTime: t0, listenGaps: [{ start: t0 + 5.6 * 3600e3, end: t0 + 6 * 3600e3, sec: 1440, reason: 'mic-silent' }], trace: [{ m: 0, db: -60 }] },
  ];
  const clips = [
    { id: 'c1', sessionId: 'last', eventId: 'e1', clipType: 'event', timestamp: t0 + 3600e3, audioBlob: float32ToWav(big), format: 'wav' },
    { id: 'c2', sessionId: 'last', eventId: 'h1', clipType: 'highlight', timestamp: t0 + 3600e3, audioBlob: float32ToWav(big.subarray(0, 1600)), format: 'wav' },
  ];
  return {
    async getAllSessions() { return sessions; },
    async getEventsBySession(id) { return id === 'last' ? [{ id: 'e1', type: 'snoring' }] : []; },
    async getHighlightsBySession() { return []; },
    async getClipsBySession(id) { return clips.filter((c) => c.sessionId === id); },
  };
}

function fakeNative(existingDirs = []) {
  const fs = new Map(); // `${kind}/${dir}/${name}` -> Buffer
  const calls = { share: [], clear: [] };
  return {
    fs, calls, canWriteFiles: true,
    async writeFile({ kind, dir, name, data, append }) {
      const k = `${kind}/${dir || ''}/${name}`;
      const b = Buffer.from(data, 'base64');
      fs.set(k, append && fs.has(k) ? Buffer.concat([fs.get(k), b]) : b);
    },
    async clearFiles({ kind, dir }) { calls.clear.push(`${kind}/${dir || ''}`); for (const k of [...fs.keys()]) if (k.startsWith(`${kind}/${dir || ''}`)) fs.delete(k); },
    async listDirs() { return { dirs: [...existingDirs, ...new Set([...fs.keys()].filter((k) => k.startsWith('nights/')).map((k) => k.split('/')[1]))] }; },
    async shareFiles(o) { calls.share.push(o); return { completed: true }; },
  };
}

export async function run() {
  section('night-export.js — export button + nightly Files copy');
  const storage = fakeStorage();

  const files = await nightFiles(storage, (await storage.getAllSessions())[1]);
  eq(files.length, 3, 'log + 2 clips');
  ok(files[0].name.endsWith('log.json'), 'log first');
  ok(files[1].name !== files[2].name, 'clips at the same second get unique names');
  const log = JSON.parse(await files[0].blob.text());
  eq(log.session.listenGaps[0].reason, 'mic-silent', 'log carries listening gaps');
  eq(log.clips.length, 2, 'log lists the clip files');

  // native path: chunked writes, byte-exact, then the share sheet
  {
    const native = fakeNative();
    const r = await exportNight({ storage, native });
    eq(r.how, 'native', 'iOS app uses the native share sheet');
    eq(r.files, 3, 'three files shared');
    eq(native.calls.share.length, 1, 'share sheet shown once');
    eq(native.calls.share[0].names.length, 3, 'with every file');
    const wav = native.fs.get(`export//${files[1].name}`);
    const orig = Buffer.from(await files[1].blob.arrayBuffer());
    ok(wav && wav.length === orig.length && wav.equals(orig), `WAV written byte-exact across chunks (${orig.length} B)`);
    eq(wav.toString('ascii', 0, 4), 'RIFF', 'valid WAV header');
  }

  // no native, no share: browser downloads each file
  {
    const clicked = [];
    const doc = { body: { appendChild() {} }, createElement: () => ({ style: {}, click() { clicked.push(this.download); }, remove() {} }) };
    const r = await exportNight({ storage, native: null, nav: null, doc });
    eq(r.how, 'download', 'desktop browser downloads');
    eq(clicked.length, 3, 'one download per file');
  }

  // auto-save into Files, prune to 14 nights
  {
    const old = Array.from({ length: 16 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')} 2300`);
    const native = fakeNative(old);
    const r = await autoSaveNight({ storage, native, sessionId: 'last' });
    ok(r.ok, 'night saved');
    eq(r.dir, nightStamp((await storage.getAllSessions())[1].startTime), 'folder named by night start');
    ok([...native.fs.keys()].some((k) => k.startsWith(`nights/${r.dir}/`) && k.endsWith('log.json')), 'log in the night folder');
    const pruned = native.calls.clear.filter((c) => c.startsWith('nights/2026-10'));
    eq(pruned.length, 3, 'oldest nights pruned to keep 14');
    eq((await autoSaveNight({ storage, native: null, sessionId: 'last' })).ok, false, 'no-op outside the app');
  }

  pass('export + auto-save write the night, clips and log');
}
