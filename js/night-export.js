/*
 * night-export.js — SleepSensor
 *
 * Packs a night (log JSON with events, highlights, listening gaps and the
 * per-minute trace, plus its audio clips as WAV files) and hands it over:
 *
 *   exportNight()   Settings → Export. In the iOS/Android app the files are
 *                   written natively and shown in the system share sheet
 *                   (AirDrop, Save to Files, Telegram …). WKWebView ignores
 *                   <a download>, and navigator.share loses the tap's user
 *                   activation after the IndexedDB reads, so the old export
 *                   silently did nothing on iPhone.
 *   autoSaveNight() After every night, a copy lands in the app's Documents
 *                   folder: Files → On My iPhone → Sleep Sensor. No button.
 *
 * Clips are exported loudness-normalised (-16 LUFS, peaks <= -1 dBFS, see
 * loudness.js) so they are easy to hear; the stored recordings are untouched
 * and the log records the gain applied to each file.
 *
 * Everything stays on the device unless the user shares it.
 */

import { normalizeWavBlob } from './loudness.js';
import { makeZip } from './zip.js';

const MAX_GENERIC_CLIPS = 40; // generic 'other' sounds: only the loudest go in an export
export const EXPORTS_DIR = 'Exports';
export const EXPORTS_PLACE = 'Files → On My iPhone → Sleep Sensor → Exports';

const KEEP_NIGHTS = 14;
const CHUNK = 384 * 1024; // bytes per bridge call (base64 ~512 KB)

const pad = (n) => String(n).padStart(2, '0');
export function nightStamp(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}
const clock = (ts) => {
  const d = new Date(ts || Date.now());
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

function bytesToBase64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** [{ name, blob }] for one session: log JSON first, then its clips by time. */
export async function nightFiles(storage, session, { clipIds = null, normalize = true, onProgress = null } = {}) {
  const [events, highlights, clips] = await Promise.all([
    storage.getEventsBySession(session.id).catch(() => []),
    storage.getHighlightsBySession(session.id).catch(() => []),
    storage.getClipsBySession(session.id).catch(() => []),
  ]);
  const stamp = nightStamp(session.startTime);
  const files = [];
  const used = new Set();
  const clipNames = [];
  const want = clipIds ? new Set(clipIds) : null;
  // old builds saved a clip for almost every breath: unless the user picked
  // clips, export every specific sound but only the loudest generic ones
  const evById = new Map(events.map((e) => [e.id, e]));
  const generic = (c) => { const e = evById.get(c.eventId); return !!e && e.type === 'noise' && (!e.subtype || e.subtype === 'other'); };
  const lv = (c) => { const e = evById.get(c.eventId) || {}; return e.peakDbA ?? e.peakDb ?? -99; };
  let pick = clips.filter((c) => c.audioBlob && (!want || want.has(c.id)));
  let skipped = 0;
  if (!want) {
    const gen = pick.filter(generic);
    if (gen.length > MAX_GENERIC_CLIPS) {
      const keep = new Set([...gen].sort((a, b) => lv(b) - lv(a)).slice(0, MAX_GENERIC_CLIPS).map((c) => c.id));
      skipped = gen.length - keep.size;
      pick = pick.filter((c) => !generic(c) || keep.has(c.id));
    }
  }
  let done = 0;
  for (const c of pick) {
    if (onProgress) onProgress(done++, pick.length);
    let name = `${stamp} ${clock(c.timestamp)} ${c.clipType || 'event'}.${c.format || 'wav'}`;
    for (let k = 2; used.has(name); k++) name = name.replace(/( \d+)?\.(\w+)$/, ` ${k}.$2`);
    used.add(name);
    let blob = c.audioBlob;
    let gainDb = 0;
    if (normalize) {
      try {
        const r = await normalizeWavBlob(c.audioBlob);
        blob = r.blob;
        gainDb = Math.round(r.gainDb * 10) / 10;
      } catch (_) {
        /* not a decodable WAV: export the original */
      }
    }
    files.push({ name, blob });
    clipNames.push({ file: name, eventId: c.eventId, clipType: c.clipType, timestamp: c.timestamp, duration: c.duration, gainDb });
  }
  const log = { app: 'SleepSensor', exportedAt: new Date().toISOString(), skippedGenericClips: skipped, audio: normalize ? 'clips normalised to -16 LUFS, peak -1 dBFS (gainDb per clip); originals unchanged on the phone' : 'original', session, events, highlights, clips: clipNames };
  files.unshift({ name: `${stamp} log.json`, blob: new Blob([JSON.stringify(log, null, 1)], { type: 'application/json' }) });
  return files;
}

async function writeNative(native, kind, dir, file, onProgress = null) {
  const u8 = new Uint8Array(await file.blob.arrayBuffer());
  if (u8.length === 0) return native.writeFile({ kind, dir, name: file.name, data: '', append: false });
  const total = Math.ceil(u8.length / CHUNK);
  for (let off = 0, i = 0; off < u8.length; off += CHUNK, i++) {
    await native.writeFile({ kind, dir, name: file.name, data: bytesToBase64(u8.subarray(off, off + CHUNK)), append: off > 0 });
    if (onProgress) onProgress(i + 1, total);
  }
}

/** Latest night (or a given one) → share sheet. Returns { ok, how, files }. */
/**
 * Latest night (or a given one) as ONE zip (log + clips): saved to
 * Files → On My iPhone → Sleep Sensor → Exports, then the share sheet opens.
 * onProgress({ stage: 'clips'|'zip'|'save'|'share', done, total })
 */
export async function exportNight({ storage, native, sessionId = null, clipIds = null, filesOnly = false, onProgress = null, nav = globalThis.navigator, doc = globalThis.document } = {}) {
  const sessions = await storage.getAllSessions();
  if (!sessions.length) return { ok: false, how: 'empty', files: 0 };
  const session = sessionId
    ? sessions.find((s) => s.id === sessionId)
    : sessions.reduce((a, b) => ((b.startTime || 0) > (a.startTime || 0) ? b : a));
  if (!session) return { ok: false, how: 'empty', files: 0 };
  const step = (stage, done = 0, total = 0) => onProgress && onProgress({ stage, done, total });
  const files = await nightFiles(storage, session, { clipIds, onProgress: (d, t) => step('clips', d, t) });
  if (filesOnly) return shareFilesOnly(files.filter((f) => !f.name.endsWith('log.json')), { native, nav, doc, step });
  step('zip', 0, files.length);
  const name = `SleepSensor ${nightStamp(session.startTime)}${clipIds ? ' selection' : ''}.zip`;
  const zip = await makeZip(files, (d, t) => step('zip', d, t));
  const info = { files: files.length, clips: files.length - 1, bytes: zip.size, name };

  if (native && native.canWriteFiles) {
    step('save');
    await writeNative(native, 'nights', EXPORTS_DIR, { name, blob: zip }, (d, t) => step('save', d, t));
    step('share');
    let completed = false;
    try {
      const r = await native.shareFiles({ kind: 'nights', dir: EXPORTS_DIR, names: [name] });
      completed = !!(r && r.completed);
    } catch (_) {
      /* share sheet dismissed or unavailable: the file is saved anyway */
    }
    return { ok: true, how: 'native', savedTo: EXPORTS_PLACE, completed, ...info };
  }

  if (nav && nav.canShare && typeof File !== 'undefined') {
    const file = new File([zip], name, { type: 'application/zip' });
    try {
      if (nav.canShare({ files: [file] })) {
        step('share');
        await nav.share({ title: 'SleepSensor night', files: [file] });
        return { ok: true, how: 'share', ...info };
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, how: 'cancelled', ...info };
    }
  }

  if (doc && typeof URL !== 'undefined' && URL.createObjectURL) {
    const url = URL.createObjectURL(zip);
    const a = doc.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    doc.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1500);
    return { ok: true, how: 'download', ...info };
  }
  return { ok: false, how: 'unsupported', ...info };
}

/** Selected clips as plain .wav files in the share sheet (no zip, no log). */
async function shareFilesOnly(wavs, { native, nav, doc, step }) {
  const info = { files: wavs.length, clips: wavs.length, bytes: wavs.reduce((a, f) => a + f.blob.size, 0), name: `${wavs.length} clip${wavs.length === 1 ? '' : 's'}` };
  if (!wavs.length) return { ok: false, how: 'empty', ...info };
  if (native && native.canWriteFiles) {
    await native.clearFiles({ kind: 'export' });
    for (let i = 0; i < wavs.length; i++) {
      step('save', i, wavs.length);
      await writeNative(native, 'export', null, wavs[i]);
    }
    step('share');
    let completed = false;
    try {
      const r = await native.shareFiles({ kind: 'export', names: wavs.map((f) => f.name) });
      completed = !!(r && r.completed);
    } catch (_) {
      /* dismissed */
    }
    return { ok: true, how: 'native-files', completed, ...info };
  }
  if (nav && nav.canShare && typeof File !== 'undefined') {
    const fl = wavs.map((f) => new File([f.blob], f.name, { type: 'audio/wav' }));
    try {
      if (nav.canShare({ files: fl })) {
        step('share');
        await nav.share({ title: 'SleepSensor clips', files: fl });
        return { ok: true, how: 'share', ...info };
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, how: 'cancelled', ...info };
    }
  }
  if (doc && typeof URL !== 'undefined' && URL.createObjectURL) {
    for (const f of wavs) {
      const url = URL.createObjectURL(f.blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = f.name;
      a.style.display = 'none';
      doc.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 1500);
    }
    return { ok: true, how: 'download', ...info };
  }
  return { ok: false, how: 'unsupported', ...info };
}

/** Copy a finished night to Files → On My iPhone → Sleep Sensor; keeps the last 14. */
export async function autoSaveNight({ storage, native, sessionId }) {
  if (!native || !native.canWriteFiles || !sessionId) return { ok: false };
  const session = (await storage.getAllSessions()).find((s) => s.id === sessionId);
  if (!session) return { ok: false };
  const dir = nightStamp(session.startTime);
  const files = await nightFiles(storage, session);
  await native.clearFiles({ kind: 'nights', dir });
  for (const f of files) await writeNative(native, 'nights', dir, f);
  const { dirs = [] } = (await native.listDirs({ kind: 'nights' }).catch(() => ({}))) || {};
  const nights = dirs.filter((d) => /^\d{4}-\d\d-\d\d \d{4}$/.test(d)).sort();
  for (const old of nights.slice(0, Math.max(0, nights.length - KEEP_NIGHTS))) {
    await native.clearFiles({ kind: 'nights', dir: old }).catch(() => {});
  }
  return { ok: true, dir, files: files.length };
}
