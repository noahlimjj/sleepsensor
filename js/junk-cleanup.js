/*
 * junk-cleanup.js — SleepSensor
 *
 * Older builds saved a clip for nearly every breath of a quiet night ("Noise ·
 * Soft · 30 dBA"). This re-filters past nights the way the current detector
 * would: per night, generic sounds are compared with that night's own typical
 * generic sound; only ones that clearly stand out (+8 dB) or are among the
 * night's 5 loudest stay. Snoring, grinding, breathing pauses, clicks,
 * movement, buzzing and the loudest-moment highlights are never touched.
 *
 * NOTHING IS DELETED (an earlier version deleted, and lost a grinding clip the
 * old detector had called "Noise"): junk is only marked `filtered: 'junk'`, so
 * it drops out of the lists and stays one tap away under "Show filtered-out".
 */

const STANDOUT_DB = 8;
const KEEP_LOUDEST = 5;
const MIN_TO_FILTER = 6;
const WEAK_PAUSE = 0.6; // breathing pauses below this are mostly false on ordinary nights // nights with only a few generic sounds are left alone

const isGeneric = (e) => e.type === 'noise' && (!e.subtype || e.subtype === 'other') && !e.filtered;
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
    const { ids } = findJunk(evs);
    if (!ids.length) continue;
    nights += 1;
    events += ids.length;
    const set = new Set(ids);
    const sessClips = await storage.getClipsBySession(s.id);
    clips += sessClips.filter((c) => set.has(c.eventId)).length;
    if (apply) {
      for (const id of ids) await storage.updateEvent(id, { filtered: 'junk' }).catch(() => {});
      await storage.updateSession(s.id, { junkHidden: (s.junkHidden || 0) + ids.length });
    }
  }
  return { nights, events, clips };
}
