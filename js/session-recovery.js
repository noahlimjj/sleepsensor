/*
 * session-recovery.js — SleepSensor
 *
 * A night of monitoring can be cut short by a crash, an OS kill, the battery
 * dying, or the user force-quitting. Without recovery the session row stays
 * open (endTime === null) forever and the whole night's data is stranded.
 *
 * The engine checkpoints the open session (~every 60 s) with its running
 * tallies and a `lastCheckpoint` timestamp. On the next launch, recoverStale()
 * finds any still-open session and finalises it from its last checkpoint so the
 * partial night is saved and shows up in the report.
 */

const STALE_AFTER_MS = 90 * 1000; // no checkpoint for this long => the session died

export class SessionRecovery {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Finalise any session that was left open by a crash / kill.
   * @returns {Promise<Array<{sessionId, startTime, endTime, recovered:true}>>}
   */
  async recoverStale({ excludeId = null } = {}) {
    if (!this.storage) return [];
    let open;
    try {
      open = await this.storage.getUnfinishedSessions();
    } catch (_) {
      return [];
    }
    const now = Date.now();
    const recovered = [];
    for (const s of open) {
      if (s.id === excludeId) continue;
      const lastSeen = s.lastCheckpoint || s.startTime || 0;
      // only recover if it's genuinely abandoned (not a session starting right now)
      if (now - lastSeen < STALE_AFTER_MS) continue;

      const endTime = lastSeen;
      const totalDuration = Math.max(0, (endTime - s.startTime) / 1000);
      const pct = (d) => (totalDuration ? round1(((d || 0) / totalDuration) * 100) : 0);
      const patch = {
        endTime,
        totalDuration,
        snoringPercentage: pct(s.snoringDuration),
        bruxismPercentage: pct(s.bruxismDuration),
        recovered: true,
      };
      try {
        await this.storage.updateSession(s.id, patch);
        recovered.push({ sessionId: s.id, startTime: s.startTime, endTime, recovered: true });
      } catch (_) {
        /* skip this one */
      }
    }
    return recovered;
  }

  /** Is there an open session that looks like it's still actively recording? */
  async findActive() {
    if (!this.storage) return null;
    try {
      const open = await this.storage.getUnfinishedSessions();
      const now = Date.now();
      return (
        open.find((s) => now - (s.lastCheckpoint || s.startTime || 0) < STALE_AFTER_MS) || null
      );
    } catch (_) {
      return null;
    }
  }
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

export default SessionRecovery;
