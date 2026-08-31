/*
 * sync.js — SleepSensor
 *
 * Two-way sync of sleep *stats* between the local IndexedDB and Firestore, per
 * signed-in user (guest or real). What syncs:
 *
 *   users/{uid}/sessions/{id}     session summaries
 *   users/{uid}/events/{id}       detected snoring/grinding/noise events
 *   users/{uid}/highlights/{id}   loudest-moment metadata
 *
 * What does NOT sync: the WAV audio clips. They stay in the device's IndexedDB,
 * so "audio never leaves your device" holds and there's no storage cost.
 *
 * Merge rule: every row carries `updatedAt` (ms). On sync we take the newer
 * side; rows missing on one side are copied over. A locally deleted row is
 * written back as a `{ deleted: true }` tombstone so other devices drop it too.
 *
 * Offline: Firestore's own persistence queues writes; a full sync() also runs
 * on reconnect and on app foreground.
 */

const COLLECTIONS = [
  { name: 'sessions', get: 'getAllSessions', put: 'putSessionRaw' },
  { name: 'events', get: '_allEvents', put: 'putEventRaw' },
  { name: 'highlights', get: '_allHighlights', put: 'putHighlightRaw' },
];

export class SyncManager {
  constructor(storage) {
    this.storage = storage;
    this.fb = null;
    this.uid = null;
    this.status = 'idle'; // idle | syncing | synced | offline | error
    this._listeners = new Set();
    this._onOnline = () => this.sync().catch(() => {});
    this._queue = Promise.resolve();
  }

  onStatus(cb) {
    this._listeners.add(cb);
    cb(this.status);
    return () => this._listeners.delete(cb);
  }
  _setStatus(s) {
    this.status = s;
    for (const cb of this._listeners) try { cb(s); } catch (_) { /* noop */ }
  }

  /** Called when a user signs in. Runs an initial full sync. */
  async attach(fb, uid) {
    if (this.uid === uid) return;
    this.detach();
    this.fb = fb;
    this.uid = uid;
    if (typeof window !== 'undefined') window.addEventListener('online', this._onOnline);
    await this.sync();
  }

  detach() {
    if (typeof window !== 'undefined') window.removeEventListener('online', this._onOnline);
    this.fb = null;
    this.uid = null;
    this._setStatus('idle');
  }

  _col(name) {
    const { collection } = this.fb.dbFns;
    return collection(this.fb.db, 'users', this.uid, name);
  }
  _doc(name, id) {
    const { doc } = this.fb.dbFns;
    return doc(this.fb.db, 'users', this.uid, name, id);
  }

  /** Full bidirectional sync of all three collections. Serialised. */
  sync() {
    this._queue = this._queue.then(() => this._syncNow()).catch((e) => {
      console.warn('[sync] failed:', e && e.message);
      this._setStatus(navigator.onLine === false ? 'offline' : 'error');
    });
    return this._queue;
  }

  async _syncNow() {
    if (!this.fb || !this.uid) return;
    this._setStatus('syncing');
    const { getDocs, writeBatch, serverTimestamp } = this.fb.dbFns;

    for (const c of COLLECTIONS) {
      const localRows = await this.storage[c.get]();
      const localById = new Map(localRows.map((r) => [r.id, r]));

      const snap = await getDocs(this._col(c.name));
      const remoteById = new Map();
      snap.forEach((d) => remoteById.set(d.id, d.data()));

      // remote -> local
      for (const [id, remote] of remoteById) {
        const local = localById.get(id);
        if (remote.deleted) {
          if (local) await this.storage.deleteRowById(c.name, id);
          continue;
        }
        if (!local || (remote.updatedAt || 0) > (local.updatedAt || 0)) {
          await this.storage[c.put](stripUndefined(remote));
        }
      }

      // local -> remote (chunked batches, 400 writes each)
      const toPush = [];
      for (const [id, local] of localById) {
        const remote = remoteById.get(id);
        if (!remote || (local.updatedAt || 0) > (remote.updatedAt || 0)) {
          toPush.push({ id, data: this._forWire(c.name, local) });
        }
      }
      for (let i = 0; i < toPush.length; i += 400) {
        const batch = writeBatch(this.fb.db);
        for (const { id, data } of toPush.slice(i, i + 400)) {
          batch.set(this._doc(c.name, id), { ...data, syncedAt: serverTimestamp() }, { merge: true });
        }
        await batch.commit();
      }
    }

    this._setStatus('synced');
  }

  /** Push one session and its events/highlights right after a recording ends. */
  async pushSession(sessionId) {
    if (!this.fb || !this.uid || !sessionId) return;
    this._queue = this._queue.then(async () => {
      try {
        this._setStatus('syncing');
        const { writeBatch, serverTimestamp } = this.fb.dbFns;
        const session = await this.storage.getSession(sessionId);
        const events = await this.storage.getEventsBySession(sessionId);
        const highlights = await this.storage.getHighlightsBySession(sessionId);
        const batch = writeBatch(this.fb.db);
        if (session) batch.set(this._doc('sessions', session.id), { ...this._forWire('sessions', session), syncedAt: serverTimestamp() }, { merge: true });
        for (const e of events) batch.set(this._doc('events', e.id), { ...this._forWire('events', e), syncedAt: serverTimestamp() }, { merge: true });
        for (const h of highlights) batch.set(this._doc('highlights', h.id), { ...this._forWire('highlights', h), syncedAt: serverTimestamp() }, { merge: true });
        await batch.commit();
        this._setStatus('synced');
      } catch (e) {
        console.warn('[sync] pushSession failed:', e && e.message);
        this._setStatus(navigator.onLine === false ? 'offline' : 'error');
      }
    });
    return this._queue;
  }

  /** Delete everything under this account (used by "Clear all data" when signed in). */
  async purgeRemote() {
    if (!this.fb || !this.uid) return;
    const { getDocs, writeBatch } = this.fb.dbFns;
    for (const c of COLLECTIONS) {
      const snap = await getDocs(this._col(c.name));
      const ids = [];
      snap.forEach((d) => ids.push(d.id));
      for (let i = 0; i < ids.length; i += 400) {
        const batch = writeBatch(this.fb.db);
        for (const id of ids.slice(i, i + 400)) batch.delete(this._doc(c.name, id));
        await batch.commit();
      }
    }
  }

  // strip the audio blob + local-only fields before writing to Firestore
  _forWire(name, row) {
    const out = { ...row, updatedAt: row.updatedAt || Date.now() };
    delete out.audioBlob;
    delete out.syncedAt;
    return out;
  }
}

function stripUndefined(o) {
  const out = {};
  for (const k in o) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export default SyncManager;
