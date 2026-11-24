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
 * Everything stays on the device unless the user shares it.
 */

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
export async function nightFiles(storage, session) {
  const [events, highlights, clips] = await Promise.all([
    storage.getEventsBySession(session.id).catch(() => []),
    storage.getHighlightsBySession(session.id).catch(() => []),
    storage.getClipsBySession(session.id).catch(() => []),
  ]);
  const stamp = nightStamp(session.startTime);
  const files = [];
  const used = new Set();
  const clipNames = [];
  for (const c of clips) {
    if (!c.audioBlob) continue;
    let name = `${stamp} ${clock(c.timestamp)} ${c.clipType || 'event'}.${c.format || 'wav'}`;
    for (let k = 2; used.has(name); k++) name = name.replace(/( \d+)?\.(\w+)$/, ` ${k}.$2`);
    used.add(name);
    files.push({ name, blob: c.audioBlob });
    clipNames.push({ file: name, eventId: c.eventId, clipType: c.clipType, timestamp: c.timestamp, duration: c.duration });
  }
  const log = { app: 'SleepSensor', exportedAt: new Date().toISOString(), session, events, highlights, clips: clipNames };
  files.unshift({ name: `${stamp} log.json`, blob: new Blob([JSON.stringify(log, null, 1)], { type: 'application/json' }) });
  return files;
}

async function writeNative(native, kind, dir, file) {
  const u8 = new Uint8Array(await file.blob.arrayBuffer());
  if (u8.length === 0) return native.writeFile({ kind, dir, name: file.name, data: '', append: false });
  for (let off = 0; off < u8.length; off += CHUNK) {
    await native.writeFile({ kind, dir, name: file.name, data: bytesToBase64(u8.subarray(off, off + CHUNK)), append: off > 0 });
  }
}

/** Latest night (or a given one) → share sheet. Returns { ok, how, files }. */
export async function exportNight({ storage, native, sessionId = null, nav = globalThis.navigator, doc = globalThis.document } = {}) {
  const sessions = await storage.getAllSessions();
  if (!sessions.length) return { ok: false, how: 'empty', files: 0 };
  const session = sessionId
    ? sessions.find((s) => s.id === sessionId)
    : sessions.reduce((a, b) => ((b.startTime || 0) > (a.startTime || 0) ? b : a));
  const files = await nightFiles(storage, session);

  if (native && native.canWriteFiles) {
    await native.clearFiles({ kind: 'export' });
    for (const f of files) await writeNative(native, 'export', null, f);
    const r = await native.shareFiles({ kind: 'export', names: files.map((f) => f.name) });
    return { ok: true, how: 'native', files: files.length, completed: !!(r && r.completed) };
  }

  if (nav && nav.canShare && typeof File !== 'undefined') {
    const asFiles = files.map((f) => new File([f.blob], f.name, { type: f.blob.type || 'application/octet-stream' }));
    for (const set of [asFiles, asFiles.slice(0, 1)]) {
      try {
        if (nav.canShare({ files: set })) {
          await nav.share({ title: 'SleepSensor night', files: set });
          return { ok: true, how: 'share', files: set.length };
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false, how: 'cancelled', files: 0 };
      }
    }
  }

  // desktop browsers: one download per file
  if (doc && typeof URL !== 'undefined' && URL.createObjectURL) {
    for (const f of files) {
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
    return { ok: true, how: 'download', files: files.length };
  }
  return { ok: false, how: 'unsupported', files: 0 };
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
