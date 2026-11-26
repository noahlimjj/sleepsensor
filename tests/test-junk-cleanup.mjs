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
  eq(r.events, 36, 'junk marked');
  const after = await storage.getEventsBySession(s.id);
  eq(after.length, night.length, 'NOTHING deleted: events all still there');
  eq((await storage.getClipsBySession(s.id)).length, night.length, 'clips all still there');
  eq(after.filter((e) => e.filtered === 'junk').length, 36, 'junk only marked filtered');
  eq((await cleanupJunk(storage)).events, 0, 'running it again finds nothing new');
  await storage.deleteSession(s.id);
  // the panel keeps filtered clips one tap away
  {
    const { buildNightModel, renderNightClips } = await import('../js/night-clips.js');
    const evs = [{ id: 'g', type: 'noise', timestamp: 1, duration: 12, filtered: 'junk' }, { id: 'b', type: 'bruxism', timestamp: 2, duration: 30 }];
    const m = buildNightModel({ session: { startTime: 0, endTime: 3600e3 }, events: evs, clips: [{ id: 'cg', eventId: 'g' }, { id: 'cb', eventId: 'b' }] });
    eq(m.items.length, 1, 'filtered clip not in the main list');
    eq(m.filtered.length, 1, 'but in the filtered list');
    ok(renderNightClips(m).includes('Show filtered-out (1)'), '"Show filtered-out" button');
    const open = renderNightClips(m, { showFiltered: true });
    ok(open.includes('Filtered out') && open.includes('quiet background') && (open.match(/nc-row/g) || []).length === 2, 'expanded: filtered clip playable with its reason');
  }
  pass('old junk clips are hidden (never deleted) and can be shown again');
}
