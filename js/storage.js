/*
 * storage.js — SleepSensor
 *
 * IndexedDB persistence layer. Everything stays on the device; nothing is ever
 * uploaded. Stores sleep sessions, detected events, and short WAV audio clips
 * for the "highlights" reel, plus a small key/value settings store.
 */

const DB_NAME = 'sleepsensor-db';
const DB_VERSION = 2;

export class Storage {
  constructor() {
    this.db = null;
  }

  // ---- lifecycle --------------------------------------------------------
  init() {
    if (this.db) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this environment'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => this._migrate(e.target.result, e.oldVersion);
      req.onsuccess = () => {
        this.db = req.result;
        this.db.onversionchange = () => this.db && this.db.close();
        resolve(this);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('[Storage] open blocked by another tab');
    });
  }

  _migrate(db) {
    if (!db.objectStoreNames.contains('sessions')) {
      const s = db.createObjectStore('sessions', { keyPath: 'id' });
      s.createIndex('date', 'date', { unique: false });
      s.createIndex('startTime', 'startTime', { unique: false });
    }
    if (!db.objectStoreNames.contains('events')) {
      const s = db.createObjectStore('events', { keyPath: 'id' });
      s.createIndex('sessionId', 'sessionId', { unique: false });
      s.createIndex('type', 'type', { unique: false });
      s.createIndex('timestamp', 'timestamp', { unique: false });
    }
    if (!db.objectStoreNames.contains('clips')) {
      const s = db.createObjectStore('clips', { keyPath: 'id' });
      s.createIndex('eventId', 'eventId', { unique: false });
      s.createIndex('sessionId', 'sessionId', { unique: false });
    }
    if (!db.objectStoreNames.contains('settings')) {
      db.createObjectStore('settings', { keyPath: 'key' });
    }
    // v2: loudest-moment highlights (top-N loudest clips of the night)
    if (!db.objectStoreNames.contains('highlights')) {
      const s = db.createObjectStore('highlights', { keyPath: 'id' });
      s.createIndex('sessionId', 'sessionId', { unique: false });
      s.createIndex('timestamp', 'timestamp', { unique: false });
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ---- generic transaction helpers -----------------------------------
  _tx(stores, mode) {
    if (!this.db) throw new Error('Storage.init() must be awaited before use');
    return this.db.transaction(stores, mode);
  }

  _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  _done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  }

  async _getAllByIndex(store, indexName, key) {
    const tx = this._tx(store, 'readonly');
    const idx = tx.objectStore(store).index(indexName);
    return this._req(idx.getAll(key));
  }

  // ---- sessions -------------------------------------------------------
  async createSession(session) {
    const now = Date.now();
    const rec = {
      id: session.id || uuid(),
      date: session.date || toDateStr(session.startTime || now),
      startTime: session.startTime || now,
      endTime: session.endTime ?? null,
      totalDuration: session.totalDuration || 0,
      snoringDuration: session.snoringDuration || 0,
      bruxismDuration: session.bruxismDuration || 0,
      snoringEpisodes: session.snoringEpisodes || 0,
      bruxismEpisodes: session.bruxismEpisodes || 0,
      noiseDuration: session.noiseDuration || 0,
      noiseEpisodes: session.noiseEpisodes || 0,
      snoringPercentage: session.snoringPercentage || 0,
      bruxismPercentage: session.bruxismPercentage || 0,
      lastCheckpoint: session.startTime || now, // updated ~every 60s while recording
      recovered: false, // set true if finalised by crash recovery
    };
    const tx = this._tx('sessions', 'readwrite');
    tx.objectStore('sessions').add(rec);
    await this._done(tx);
    return rec;
  }

  async updateSession(id, updates) {
    const tx = this._tx('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const existing = await this._req(store.get(id));
    if (!existing) {
      await this._done(tx).catch(() => {});
      throw new Error(`session ${id} not found`);
    }
    const merged = { ...existing, ...updates, id };
    store.put(merged);
    await this._done(tx);
    return merged;
  }

  async getSession(id) {
    const tx = this._tx('sessions', 'readonly');
    return (await this._req(tx.objectStore('sessions').get(id))) || null;
  }

  async getSessionByDate(dateStr) {
    const rows = await this._getAllByIndex('sessions', 'date', dateStr);
    if (!rows.length) return null;
    rows.sort((a, b) => b.startTime - a.startTime);
    return rows[0];
  }

  async getAllSessions() {
    const tx = this._tx('sessions', 'readonly');
    const rows = await this._req(tx.objectStore('sessions').getAll());
    rows.sort((a, b) => b.startTime - a.startTime);
    return rows;
  }

  async getRecentSessions(limit = 30) {
    const rows = await this.getAllSessions();
    return rows.slice(0, limit);
  }

  /** Sessions that were never finalised (endTime === null) — for crash recovery. */
  async getUnfinishedSessions() {
    const rows = await this.getAllSessions();
    return rows.filter((s) => s.endTime == null);
  }

  async deleteSession(id) {
    // cascade: remove the session, its events, highlights and clips
    const events = await this.getEventsBySession(id);
    const highlights = await this.getHighlightsBySession(id);
    const tx = this._tx(['sessions', 'events', 'highlights', 'clips'], 'readwrite');
    tx.objectStore('sessions').delete(id);
    const clipIdx = tx.objectStore('clips').index('sessionId');
    const clipKeys = await this._req(clipIdx.getAllKeys(id));
    clipKeys.forEach((k) => tx.objectStore('clips').delete(k));
    events.forEach((ev) => tx.objectStore('events').delete(ev.id));
    highlights.forEach((h) => tx.objectStore('highlights').delete(h.id));
    await this._done(tx);
  }

  // ---- events --------------------------------------------------------
  async addEvent(event) {
    const rec = {
      id: event.id || uuid(),
      sessionId: event.sessionId,
      type: event.type,
      startTime: event.startTime,
      endTime: event.endTime,
      duration: event.duration ?? (event.endTime - event.startTime) / 1000,
      confidence: event.confidence ?? 0,
      severity: event.severity || 'mild',
      timestamp: event.timestamp || event.startTime,
      hasClip: !!event.hasClip,
    };
    const tx = this._tx('events', 'readwrite');
    tx.objectStore('events').put(rec);
    await this._done(tx);
    return rec;
  }

  async updateEvent(id, updates) {
    const tx = this._tx('events', 'readwrite');
    const store = tx.objectStore('events');
    const existing = await this._req(store.get(id));
    if (!existing) {
      await this._done(tx).catch(() => {});
      throw new Error(`event ${id} not found`);
    }
    const merged = { ...existing, ...updates, id };
    store.put(merged);
    await this._done(tx);
    return merged;
  }

  async getEventsBySession(sessionId) {
    const rows = await this._getAllByIndex('events', 'sessionId', sessionId);
    rows.sort((a, b) => a.startTime - b.startTime);
    return rows;
  }

  async getEventsByType(type, limit = 100) {
    const rows = await this._getAllByIndex('events', 'type', type);
    rows.sort((a, b) => b.startTime - a.startTime);
    return rows.slice(0, limit);
  }

  // ---- clips --------------------------------------------------------
  async saveClip(clip) {
    const rec = {
      id: clip.id || uuid(),
      eventId: clip.eventId, // parent id: an event OR a highlight
      sessionId: clip.sessionId,
      clipType: clip.clipType || 'event', // 'event' | 'highlight'
      audioBlob: clip.audioBlob,
      duration: clip.duration ?? 0,
      format: clip.format || 'wav',
      timestamp: clip.timestamp || Date.now(),
    };
    const tx = this._tx('clips', 'readwrite');
    tx.objectStore('clips').put(rec);
    await this._done(tx);
    return rec;
  }

  async getClip(id) {
    const tx = this._tx('clips', 'readonly');
    return (await this._req(tx.objectStore('clips').get(id))) || null;
  }

  async getClipsBySession(sessionId) {
    const rows = await this._getAllByIndex('clips', 'sessionId', sessionId);
    rows.sort((a, b) => a.timestamp - b.timestamp);
    return rows;
  }

  /** Clips for a session filtered by kind ('event' | 'highlight'). */
  async getClipsBySessionType(sessionId, clipType) {
    const rows = await this.getClipsBySession(sessionId);
    return rows.filter((c) => (c.clipType || 'event') === clipType);
  }

  async getClipByEvent(eventId) {
    const rows = await this._getAllByIndex('clips', 'eventId', eventId);
    return rows[0] || null;
  }

  // ---- highlights (loudest moments of the night) ------------------
  async saveHighlight(h) {
    const rec = {
      id: h.id || uuid(),
      sessionId: h.sessionId,
      timestamp: h.timestamp || Date.now(),
      peak: h.peak ?? 0,
      db: h.db ?? null,
      rms: h.rms ?? 0,
      classifiedAs: h.classifiedAs || 'unknown', // 'snoring'|'bruxism'|'noise'|'unknown'
      confidence: h.confidence ?? 0,
      hasClip: !!h.hasClip,
    };
    const tx = this._tx('highlights', 'readwrite');
    tx.objectStore('highlights').put(rec);
    await this._done(tx);
    return rec;
  }

  async updateHighlight(id, updates) {
    const tx = this._tx('highlights', 'readwrite');
    const store = tx.objectStore('highlights');
    const existing = await this._req(store.get(id));
    if (!existing) {
      await this._done(tx).catch(() => {});
      return null;
    }
    const merged = { ...existing, ...updates, id };
    store.put(merged);
    await this._done(tx);
    return merged;
  }

  async getHighlightsBySession(sessionId) {
    const rows = await this._getAllByIndex('highlights', 'sessionId', sessionId);
    rows.sort((a, b) => b.peak - a.peak); // loudest first
    return rows;
  }

  async deleteHighlight(id) {
    const clip = await this.getClipByEvent(id);
    const tx = this._tx(['highlights', 'clips'], 'readwrite');
    tx.objectStore('highlights').delete(id);
    if (clip) tx.objectStore('clips').delete(clip.id);
    await this._done(tx);
  }

  async deleteClipsBySession(sessionId) {
    const tx = this._tx('clips', 'readwrite');
    const idx = tx.objectStore('clips').index('sessionId');
    const keys = await this._req(idx.getAllKeys(sessionId));
    keys.forEach((k) => tx.objectStore('clips').delete(k));
    await this._done(tx);
  }

  // ---- settings ----------------------------------------------------
  async getSetting(key, defaultValue = null) {
    const tx = this._tx('settings', 'readonly');
    const row = await this._req(tx.objectStore('settings').get(key));
    return row ? row.value : defaultValue;
  }

  async setSetting(key, value) {
    const tx = this._tx('settings', 'readwrite');
    tx.objectStore('settings').put({ key, value });
    await this._done(tx);
  }

  // ---- maintenance ----------------------------------------------
  async getStorageUsage() {
    const tx = this._tx(['sessions', 'events', 'clips', 'highlights'], 'readonly');
    const [sessions, events, clips, highlights] = await Promise.all([
      this._req(tx.objectStore('sessions').count()),
      this._req(tx.objectStore('events').count()),
      this._req(tx.objectStore('clips').count()),
      this._req(tx.objectStore('highlights').count()),
    ]);
    let totalBytes = 0;
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        totalBytes = est.usage || 0;
      } catch (_) {
        /* ignore */
      }
    }
    if (!totalBytes) {
      const clipRows = await this._req(this._tx('clips', 'readonly').objectStore('clips').getAll());
      totalBytes = clipRows.reduce((sum, c) => sum + (c.audioBlob?.size || 0), 0);
    }
    return { sessions, events, clips, highlights, totalBytes };
  }

  async pruneOldSessions(keepDays = 30) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const sessions = await this.getAllSessions();
    const stale = sessions.filter((s) => s.startTime < cutoff);
    for (const s of stale) await this.deleteSession(s.id);
    return stale.length;
  }

  async exportSession(sessionId) {
    const [session, events, highlights, clips] = await Promise.all([
      this.getSession(sessionId),
      this.getEventsBySession(sessionId),
      this.getHighlightsBySession(sessionId),
      this.getClipsBySession(sessionId),
    ]);
    return { session, events, highlights, clips };
  }

  async clearAll() {
    const stores = ['sessions', 'events', 'clips', 'highlights', 'settings'];
    const tx = this._tx(stores, 'readwrite');
    stores.forEach((s) => tx.objectStore(s).clear());
    await this._done(tx);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // RFC4122-ish fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function toDateStr(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default Storage;
