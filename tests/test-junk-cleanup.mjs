// junk-cleanup.js — re-filter old nights' "Noise · Soft" clips.
import 'fake-indexeddb/auto';
import { section, ok, eq, pass } from './lib.mjs';
import { findJunk, cleanupJunk } from '../js/junk-cleanup.js';
import { Storage } from '../js/storage.js';

export async function run() {
  section('junk-cleanup.js — old junk clips');
  const ev = (id, type, dbA, extra = {}) => ({ id, type, peakDbA: dbA, duration: 12, ...extra });
  const night = [
    ...Array.from({ length: 40 }, (_, i) => ev('n' + i, 'noise', 30 + (i % 3))), // breathing junk 30-32 dBA
    ev('loud', 'noise', 52), // a door
    ev('s1', 'snoring', 31), ev('b1', 'bruxism', 30), ev('a1', 'apnea', 30, { confidence: 0.8 }), ev('k1', 'click', 30),
    ev('m1', 'noise', 30, { subtype: 'movement' }),
  ];
  const j = findJunk(night);
  ok(!j.ids.includes('loud'), 'a clearly louder sound stays');
  ok(['s1', 'b1', 'a1', 'k1', 'm1'].every((id) => !j.ids.includes(id)), 'snoring/grinding/pauses/clicks/movement untouched');
  eq(j.ids.length, 40 - 4, 'junk removed; the 5 loudest generic sounds kept');
  eq(findJunk(night.slice(0, 4)).ids.length, 0, 'a night with few generic sounds is left alone');

  const storage = new Storage();
  await storage.init();
  const s = await storage.createSession({ startTime: Date.parse('2026-11-20T23:00:00Z'), noiseEpisodes: 41 });
  for (const e of night) {
    const rec = await storage.addEvent({ ...e, sessionId: s.id, startTime: 0, endTime: 12000 });
    await storage.saveClip({ sessionId: s.id, eventId: rec.id, clipType: 'event', audioBlob: new Blob([new Uint8Array(10)]), duration: 12 });
  }
  const dry = await cleanupJunk(storage);
  eq(dry.events, 36, 'dry run counts junk');
  eq((await storage.getEventsBySession(s.id)).length, night.length, 'dry run deletes nothing');
  const r = await cleanupJunk(storage, { apply: true });
  eq(r.clips, 36, 'junk clips deleted');
  eq((await storage.getEventsBySession(s.id)).length, night.length - 36, 'junk events deleted');
  eq((await storage.getClipsBySession(s.id)).length, night.length - 36, 'their clips too');
  eq((await storage.getSession(s.id)).noiseEpisodes, 5, 'session noise count updated');
  await storage.deleteSession(s.id);
  pass('old junk clips are found and removed safely');
}
