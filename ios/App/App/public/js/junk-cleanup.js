/*
 * junk-cleanup.js — SleepSensor
 *
 * Older builds saved a clip for nearly every breath of a quiet night ("Noise ·
 * Soft · 30 dBA"). This re-filters past nights the way the current detector
 * would: per night, generic sounds are compared with that night's own typical
 * generic sound; only ones that clearly stand out (+8 dB) or are among the
 * night's 5 loudest stay. Snoring, grinding, breathing pauses, clicks,
 * movement, buzzing and the loudest-moment highlights are never touched.
 */

const STANDOUT_DB = 8;
const KEEP_LOUDEST = 5;
const MIN_TO_FILTER = 6; // nights with only a few generic sounds are left alone

const isGeneric = (e) => e.type === 'noise' && (!e.subtype || e.subtype === 'other');
const level = (e) => (typeof e.peakDbA === 'number' ? e.peakDbA : typeof e.peakDb === 'number' ? e.peakDb : null);

/** @returns {{ ids: string[], seconds: number }} junk generic events of one night */
export function findJunk(events) {
  const gen = events.filter(isGeneric);
  if (gen.length < MIN_TO_FILTER) return { ids: [], seconds: 0 };
  const lv = gen.map(level).filter((v) => v != null).sort((a, b) => a - b);
  if (!lv.length) return { ids: [], seconds: 0 };
  const typical = lv[lv.length >> 1];
  const loudest = new Set([...gen].filter((e) => level(e) != null).sort((a, b) => level(b) - level(a)).slice(0, KEEP_LOUDEST).map((e) => e.id));
  const junk = gen.filter((e) => !loudest.has(e.id) && (level(e) == null || level(e) < typical + STANDOUT_DB));
  return { ids: junk.map((e) => e.id), seconds: junk.reduce((a, e) => a + (e.duration || 0), 0) };
}

/** Scan every night; `apply` deletes. Returns totals for the confirm text. */
export async function cleanupJunk(storage, { apply = false } = {}) {
  const sessions = await storage.getAllSessions();
  let events = 0, clips = 0, nights = 0;
  for (const s of sessions) {
    const evs = await storage.getEventsBySession(s.id);
    const { ids, seconds } = findJunk(evs);
    if (!ids.length) continue;
    nights += 1;
    events += ids.length;
    const set = new Set(ids);
    const sessClips = await storage.getClipsBySession(s.id);
    const clipIds = sessClips.filter((c) => set.has(c.eventId)).map((c) => c.id);
    clips += clipIds.length;
    if (apply) {
      await storage.deleteEventsAndClips(ids, clipIds);
      await storage.updateSession(s.id, {
        noiseEpisodes: Math.max(0, (s.noiseEpisodes || 0) - ids.length),
        noiseDuration: Math.max(0, (s.noiseDuration || 0) - seconds),
        junkCleaned: (s.junkCleaned || 0) + ids.length,
      });
    }
  }
  return { nights, events, clips };
}
