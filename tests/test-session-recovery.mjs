// session-recovery.js — finalise sessions abandoned by a crash / OS kill.
import 'fake-indexeddb/auto';
import { section, ok, eq, pass } from './lib.mjs';
import { Storage } from '../js/storage.js';
import { SessionRecovery } from '../js/session-recovery.js';

export async function run() {
  section('session-recovery.js — crash recovery');

  const storage = new Storage();
  await storage.init();
  await storage.clearAll();
  const rec = new SessionRecovery(storage);

  const HOUR = 3600 * 1000;
  const now = Date.now();

  // 1. a completed session — never touched
  const done = await storage.createSession({ startTime: now - 8 * HOUR });
  await storage.updateSession(done.id, { endTime: now - 1 * HOUR, totalDuration: 25200 });

  // 2. an abandoned session — open, last checkpoint 5h ago
  const dead = await storage.createSession({ startTime: now - 6 * HOUR });
  await storage.updateSession(dead.id, {
    lastCheckpoint: now - 5 * HOUR,
    snoringDuration: 1800,
    bruxismDuration: 120,
  });

  // 3. a session that is still actively recording — checkpoint 10s ago
  const live = await storage.createSession({ startTime: now - 30 * 60 * 1000 });
  await storage.updateSession(live.id, { lastCheckpoint: now - 10 * 1000, snoringDuration: 300 });

  const recovered = await rec.recoverStale();

  eq(recovered.length, 1, 'exactly one session recovered');
  eq(recovered[0].sessionId, dead.id, 'the abandoned session is the one recovered');

  const fixed = await storage.getSession(dead.id);
  eq(fixed.endTime, now - 5 * HOUR, 'endTime set to the last checkpoint');
  eq(fixed.recovered, true, 'flagged recovered');
  ok(fixed.totalDuration > 3500 && fixed.totalDuration < 3700, `duration ≈ 1h (${fixed.totalDuration}s)`);
  ok(fixed.snoringPercentage > 0, 'percentages computed from the partial data');

  ok((await storage.getSession(done.id)).endTime === now - HOUR, 'completed session untouched');
  ok((await storage.getSession(live.id)).endTime == null, 'the actively-recording session is left alone');

  const active = await rec.findActive();
  eq(active && active.id, live.id, 'findActive() returns the live session');

  // recovering again does nothing (dead session now has an endTime)
  eq((await rec.recoverStale()).length, 0, 'second pass recovers nothing');

  // excludeId keeps the current session safe even if its checkpoint is stale
  await storage.updateSession(live.id, { lastCheckpoint: now - 5 * HOUR });
  eq((await rec.recoverStale({ excludeId: live.id })).length, 0, 'excludeId protects the running session');

  storage.close();
  pass('crash recovery behaves correctly');
}
