// Storage layer against a fake IndexedDB.
import 'fake-indexeddb/auto';
import { section, ok, eq, pass } from './lib.mjs';
import { Storage } from '../js/storage.js';

export async function run() {
  section('storage.js — IndexedDB persistence');

  const storage = new Storage();
  await storage.init();
  ok(storage.db, 'init() opens the database');
  await storage.clearAll();

  // --- sessions ---
  const s = await storage.createSession({ startTime: Date.parse('2026-08-20T23:00:00Z') });
  ok(s.id && s.date === '2026-08-20' || s.date === '2026-08-21', 'createSession derives a date string');
  eq(s.endTime, null, 'new session has null endTime');

  const fetched = await storage.getSession(s.id);
  eq(fetched.id, s.id, 'getSession round-trips');
  eq(await storage.getSession('nope'), null, 'getSession(missing) -> null');

  const updated = await storage.updateSession(s.id, { endTime: 123, snoringEpisodes: 4 });
  eq(updated.snoringEpisodes, 4, 'updateSession merges fields');
  eq((await storage.getSession(s.id)).endTime, 123, 'updateSession persists');

  const byDate = await storage.getSessionByDate(s.date);
  eq(byDate.id, s.id, 'getSessionByDate uses the date index');

  // --- events ---
  const e1 = await storage.addEvent({
    sessionId: s.id, type: 'snoring', startTime: 1000, endTime: 6000,
    confidence: 0.8, severity: 'severe',
  });
  const e2 = await storage.addEvent({
    sessionId: s.id, type: 'bruxism', startTime: 7000, endTime: 9000,
    confidence: 0.4, severity: 'mild',
  });
  eq(e1.duration, 5, 'addEvent computes duration from start/end when absent');
  const evs = await storage.getEventsBySession(s.id);
  eq(evs.length, 2, 'getEventsBySession returns all events');
  eq(evs[0].id, e1.id, 'events sorted by startTime ascending');
  const snores = await storage.getEventsByType('snoring');
  eq(snores.length, 1, 'getEventsByType filters by type');

  await storage.updateEvent(e1.id, { hasClip: true });
  eq((await storage.getEventsBySession(s.id))[0].hasClip, true, 'updateEvent persists');

  // --- clips ---
  const blob = new Blob([new Uint8Array(2048)], { type: 'audio/wav' });
  const clip = await storage.saveClip({ eventId: e1.id, sessionId: s.id, audioBlob: blob, duration: 12 });
  const gotClip = await storage.getClip(clip.id);
  eq(gotClip.audioBlob.size, 2048, 'clip blob round-trips through IndexedDB');
  eq((await storage.getClipByEvent(e1.id)).id, clip.id, 'getClipByEvent works');
  eq((await storage.getClipsBySession(s.id)).length, 1, 'getClipsBySession works');

  // --- settings ---
  eq(await storage.getSetting('sensitivity', 0.5), 0.5, 'getSetting returns default when unset');
  await storage.setSetting('sensitivity', 0.8);
  eq(await storage.getSetting('sensitivity'), 0.8, 'setSetting persists');

  // --- usage + export ---
  const usage = await storage.getStorageUsage();
  eq(usage.sessions, 1, 'usage counts sessions');
  eq(usage.events, 2, 'usage counts events');
  eq(usage.clips, 1, 'usage counts clips');
  ok(usage.totalBytes >= 2048, 'usage estimates bytes from clip blobs');

  const exported = await storage.exportSession(s.id);
  eq(exported.session.id, s.id, 'exportSession bundles the session');
  eq(exported.events.length, 2, 'exportSession bundles events');
  eq(exported.clips.length, 1, 'exportSession bundles clips');

  // --- cascade delete ---
  await storage.deleteSession(s.id);
  eq(await storage.getSession(s.id), null, 'deleteSession removes the session');
  eq((await storage.getEventsBySession(s.id)).length, 0, 'deleteSession cascades to events');
  eq((await storage.getClipsBySession(s.id)).length, 0, 'deleteSession cascades to clips');

  // --- prune ---
  const old = await storage.createSession({ startTime: Date.now() - 40 * 864e5 });
  const recent = await storage.createSession({ startTime: Date.now() - 2 * 864e5 });
  const deleted = await storage.pruneOldSessions(30);
  eq(deleted, 1, 'pruneOldSessions removes sessions older than keepDays');
  ok(await storage.getSession(recent.id), 'pruneOldSessions keeps recent sessions');
  ok(!(await storage.getSession(old.id)), 'pruneOldSessions deleted the stale session');

  await storage.clearAll();
  eq((await storage.getAllSessions()).length, 0, 'clearAll empties every store');

  storage.close();
  pass('storage layer behaves correctly');
}
