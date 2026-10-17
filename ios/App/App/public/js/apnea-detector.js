/*
 * apnea-detector.js — SleepSensor
 *
 * Acoustic breathing-pause detection. Obstructive events have a recognisable
 * sound pattern: a run of snoring, a stretch of near-silence while the airway
 * is blocked, then an abrupt loud snort or gasp as the sleeper partially wakes
 * and breathing resumes. This module follows that pattern window by window:
 *
 *   [snoring run ≥ 4 s] → [quiet pause 10–90 s] → [arousal: ≥ 10 dB jump]
 *
 * It is fed the raw (unsmoothed) per-window classifier verdict plus the
 * window's level, because the HMM smoother lags by a window or two and would
 * blur exactly the transitions this looks for.
 *
 * Sound alone cannot see breathing effort or blood oxygen, so the resulting
 * "estimated AHI" is a wellness indicator only — never a diagnosis.
 */

const WINDOW_MS = 2000; // the worklet emits back-to-back 2 s windows

const SNORE_MIN_CONF = 0.35;
const MIN_SNORE_RUN_MS = 4000; // snoring must precede the pause
const MIN_PAUSE_MS = 10000; // clinical apnea/hypopnea minimum
const MAX_PAUSE_MS = 90000; // longer than this is quiet sleep or waking, not a pause
const QUIET_RATIO = 0.18; // a "quiet" window is ≥ ~15 dB below the snoring level
const AROUSAL_JUMP_DB = 10; // resumption must jump this far above the pause floor
const AROUSAL_MIN_RATIO = 0.5; // ...and come back to at least ~-6 dB of the snoring
const WIDEBAND_ZCR = 0.15; // breathy, broadband gasps cross zero often
const BRUXISM_LINK_MS = 60000; // grinding this soon after a pause counts as linked

// estimated-AHI tiers (events per hour)
const TIERS = [
  { max: 5, key: 'optimal', label: 'Optimal' },
  { max: 15, key: 'mild', label: 'Mild' },
  { max: 30, key: 'moderate', label: 'Moderate' },
  { max: Infinity, key: 'severe', label: 'Severe' },
];

/**
 * Decide whether the window that ended a pause sounds like a post-apnea
 * arousal (snort / gasp) rather than, say, a soft rustle.
 *
 *   win       — { rms, peak, zcr, type, confidence }
 *   floorRms  — loudest window seen during the pause
 *   snoreRms  — mean level of the preceding snoring run
 */
export function classifyArousalAcoustics(win, floorRms, snoreRms) {
  const rms = win.rms || 0;
  const jumpDb = toDb(rms) - toDb(Math.max(floorRms || 0, 1e-5));
  const wideband = (win.zcr || 0) >= WIDEBAND_ZCR;
  const snort = win.type === 'snoring' && (win.confidence || 0) >= SNORE_MIN_CONF;
  const loudEnough = rms >= (snoreRms || 0) * AROUSAL_MIN_RATIO;
  const isArousal = jumpDb >= AROUSAL_JUMP_DB && loudEnough;
  const kind = !isArousal ? 'none' : snort ? 'snort' : wideband ? 'gasp' : 'arousal';
  return { isArousal, kind, jumpDb: round1(jumpDb), wideband };
}

export class ApneaDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.state = 'idle'; // 'idle' | 'snoring' | 'pause'
    this.events = [];
    this._runStart = 0;
    this._snoreEnd = 0;
    this._snoreRmsSum = 0;
    this._snoreCount = 0;
    this._pauseStart = 0;
    this._pauseFloor = 0;
  }

  /**
   * Feed one classification window.
   *   result — raw classifier verdict { type, confidence }
   *   msg    — worklet message { rms, peak, zcr }
   *   wall   — wall-clock ms at the END of the window
   * Returns an apnea event when a pause has just been confirmed, else null.
   */
  feed(result, msg, wall) {
    const type = (result && result.type) || 'other';
    const confidence = (result && result.confidence) || 0;
    const rms = (msg && msg.rms) || 0;
    const isSnore = type === 'snoring' && confidence >= SNORE_MIN_CONF;
    const snoreRms = this._snoreCount ? this._snoreRmsSum / this._snoreCount : 0;
    const isQuiet =
      !isSnore &&
      (type === 'silence' || type === 'quiet' || (snoreRms > 0 && rms <= snoreRms * QUIET_RATIO));

    if (this.state === 'idle') {
      if (isSnore) this._beginRun(wall, rms);
      return null;
    }

    if (this.state === 'snoring') {
      if (isSnore) {
        this._extendRun(wall, rms);
      } else if (isQuiet && this._snoreEnd - this._runStart >= MIN_SNORE_RUN_MS) {
        this.state = 'pause';
        this._pauseStart = this._snoreEnd;
        this._pauseFloor = rms;
      } else {
        // too short a run to count, or talking / a door — not a snore cycle
        this.state = 'idle';
      }
      return null;
    }

    // state === 'pause'
    if (isQuiet) {
      this._pauseFloor = Math.max(this._pauseFloor, rms);
      if (wall - this._pauseStart > MAX_PAUSE_MS) this.state = 'idle';
      return null;
    }

    const onset = wall - WINDOW_MS; // the resumption began at most one window ago
    const pauseMs = onset - this._pauseStart;
    let event = null;
    if (pauseMs >= MIN_PAUSE_MS && pauseMs <= MAX_PAUSE_MS) {
      const arousal = classifyArousalAcoustics(
        { rms, peak: msg && msg.peak, zcr: msg && msg.zcr, type, confidence },
        this._pauseFloor,
        snoreRms
      );
      if (arousal.isArousal) {
        event = this._makeEvent(onset, pauseMs, arousal, msg, snoreRms);
        this.events.push(event);
      }
    }

    if (isSnore) {
      // snoring resumed: a confirmed pause starts a fresh cycle; a short one
      // was just a breath between snores, so the run carries on
      if (event || pauseMs >= MIN_PAUSE_MS) this._beginRun(wall, rms);
      else {
        this.state = 'snoring';
        this._extendRun(wall, rms);
      }
    } else {
      this.state = 'idle';
    }
    return event;
  }

  _beginRun(wall, rms) {
    this.state = 'snoring';
    this._runStart = wall - WINDOW_MS;
    this._snoreEnd = wall;
    this._snoreRmsSum = rms;
    this._snoreCount = 1;
  }

  _extendRun(wall, rms) {
    this._snoreEnd = wall;
    this._snoreRmsSum += rms;
    this._snoreCount += 1;
  }

  _makeEvent(onset, pauseMs, arousal, msg, snoreRms) {
    const runSec = (this._snoreEnd - this._runStart) / 1000;
    const jumpScore = clamp01((arousal.jumpDb - AROUSAL_JUMP_DB) / 15);
    const runScore = clamp01(runSec / 20);
    const kindBonus = arousal.kind === 'arousal' ? 0 : 0.15;
    const confidence = Math.min(0.95, 0.4 + 0.2 * jumpScore + 0.2 * runScore + kindBonus);
    const duration = pauseMs / 1000;
    const peak = (msg && (msg.peak ?? msg.rms)) || 0;
    return {
      type: 'apnea',
      startTime: Math.round(this._pauseStart),
      endTime: Math.round(onset),
      duration: round1(duration),
      confidence: Math.round(confidence * 1000) / 1000,
      severity: duration < 20 ? 'mild' : duration < 40 ? 'moderate' : 'severe',
      arousal: arousal.kind,
      arousalJumpDb: arousal.jumpDb,
      snoreDb: round1(toDb(snoreRms)),
      peakDb: round1(toDb(peak)),
    };
  }

  /**
   * Night-level metrics from a list of events (any types; only 'apnea' and
   * 'bruxism' are used).
   *   events       — stored or in-memory event records
   *   sleepSeconds — recording length used as the AHI denominator
   */
  static calculateAhiMetrics(events, sleepSeconds) {
    const list = events || [];
    const apneas = list.filter((e) => e.type === 'apnea');
    const bruxism = list.filter((e) => e.type === 'bruxism');
    const hours = Math.max(0, sleepSeconds || 0) / 3600;
    const count = apneas.length;
    const ahi = hours > 0 ? count / hours : 0;
    const tier = TIERS.find((t) => ahi < t.max);
    const durations = apneas.map((e) => e.duration || ((e.endTime - e.startTime) / 1000) || 0);
    const totalPauseSec = durations.reduce((s, d) => s + d, 0);

    // grinding that starts during a pause or within 60 s of its arousal
    const linked = bruxism.filter((b) =>
      apneas.some((a) => b.startTime >= a.startTime && b.startTime - a.endTime <= BRUXISM_LINK_MS)
    );

    return {
      apneaEvents: count,
      estimatedAhi: round1(ahi),
      severity: tier.key,
      severityLabel: tier.label,
      totalPauseSec: round1(totalPauseSec),
      avgPauseSec: count ? round1(totalPauseSec / count) : 0,
      longestPauseSec: count ? round1(Math.max(...durations)) : 0,
      bruxismEpisodes: bruxism.length,
      bruxismLinked: linked.length,
      bruxismLinkedPct: bruxism.length ? Math.round((linked.length / bruxism.length) * 100) : 0,
      reliable: hours >= 2, // AHI over a short recording swings wildly
    };
  }

  /** Plain-language takeaways for the morning report. */
  static describeMetrics(m) {
    if (!m) return [];
    const out = [];
    if (!m.apneaEvents) {
      out.push('No breathing pauses were heard after snoring tonight.');
    } else {
      out.push(
        `${m.apneaEvents} breathing pause${m.apneaEvents === 1 ? '' : 's'} heard after snoring ` +
          `(average ${Math.round(m.avgPauseSec)}s, longest ${Math.round(m.longestPauseSec)}s) — ` +
          `about ${m.estimatedAhi} per hour (${m.severityLabel.toLowerCase()}).`
      );
    }
    if (m.bruxismLinked > 0) {
      out.push(
        `${m.bruxismLinked} of ${m.bruxismEpisodes} grinding episode${m.bruxismEpisodes === 1 ? '' : 's'} ` +
          `(${m.bruxismLinkedPct}%) began within a minute of a breathing pause. Grinding is often the jaw ` +
          'reacting to a narrowed airway, so better breathing may also mean less grinding.'
      );
    }
    if (m.severity === 'moderate' || m.severity === 'severe') {
      out.push(
        'Frequent pauses are worth raising with a doctor — only a sleep study can tell whether this is sleep apnea.'
      );
    } else if (m.apneaEvents && m.severity === 'mild') {
      out.push('Side-sleeping and avoiding alcohol late in the evening often reduce snoring-related pauses.');
    }
    if (!m.reliable) out.push('This recording was short, so the hourly rate is a rough guide only.');
    return out;
  }
}

function toDb(x) {
  return 20 * Math.log10(Math.max(x || 0, 1e-7));
}
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function round1(x) {
  return Math.round(x * 10) / 10;
}

export default ApneaDetector;
