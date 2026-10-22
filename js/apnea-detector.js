/* ============================================================
   SleepSensor — Acoustic Sleep Apnea & AHI Detector
   Deep clinical & biohacking analysis powered by acoustic state
   machine modeling and YAMNet sound event classification.
   ============================================================ */

/**
 * Standard clinical & acoustic thresholds for apnea detection:
 * - An obstructive apnea episode requires at least 10 seconds of cessation of breathing.
 * - Upper bound: pauses > 90 seconds typically signify awakening or position shift rather than a single apnea.
 * - Pre-pause: at least 4 seconds (2 windows) of preceding snoring or heavy breathing.
 * - Resuscitative arousal: sudden energy jump (>= 10 dB) or acoustic gasp/snort signature.
 */
export const APNEA_MIN_PAUSE_SEC = 10;
export const APNEA_MAX_PAUSE_SEC = 90;
export const MIN_PRE_SNORE_WINDOWS = 2; // 2 windows * 2 sec = 4 sec of snoring
export const AROUSAL_MIN_DB_JUMP = 10;  // dB jump from pause floor to arousal peak

/**
 * YAMNet AudioSet sound class profiles (acoustic heuristics matching YAMNet's feature space):
 * - Snoring: low spectral centroid (< 1200 Hz), high harmonicity
 * - Gasp/Snort: sudden explosive attack, wideband frequency distribution (1.5 kHz - 4 kHz)
 */
export function classifyArousalAcoustics(msg = {}, prevRms = 0.001) {
  const rms = msg.rms || 0;
  const peak = msg.peak || rms;
  const dbJump = 20 * Math.log10(Math.max(peak, 1e-6) / Math.max(prevRms, 1e-6));
  
  // Rapid energy surge indicative of sudden resuscitative inhalation / snort
  const isSurge = dbJump >= AROUSAL_MIN_DB_JUMP || peak >= 0.04;
  
  // Confidence calculation based on energy surge magnitude and peak intensity
  const confidence = Math.min(0.95, Math.max(0.4, 0.4 + (dbJump / 30) * 0.4 + Math.min(peak * 5, 0.15)));
  
  return {
    isSurge,
    dbJump: Math.round(dbJump * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
  };
}

export class ApneaDetector {
  constructor(options = {}) {
    this.minPauseSec = options.minPauseSec ?? APNEA_MIN_PAUSE_SEC;
    this.maxPauseSec = options.maxPauseSec ?? APNEA_MAX_PAUSE_SEC;
    this.minPreSnoreWindows = options.minPreSnoreWindows ?? MIN_PRE_SNORE_WINDOWS;

    this.reset();
  }

  reset() {
    this._state = 'QUIET'; // 'QUIET' | 'SNORING' | 'POTENTIAL_PAUSE'
    this._snoreWindows = 0;
    this._snoreStartTime = 0;
    this._lastSnoreTime = 0;
    this._pauseStartTime = 0;
    this._pauseStartCtx = 0;
    this._pauseFloorRms = 0.001;
    this._detectedEvents = [];
  }

  /**
   * Feed a 2-second classified audio window into the detector.
   *
   * @param {{type:string, confidence:number}} classification
   * @param {{timestamp:number, rms:number, peak:number}} msg
   * @param {number} wallTime - current wall-clock epoch ms
   * @returns {object|null} Emits an apnea event if a completed cycle was verified, else null.
   */
  feed(classification, msg = {}, wallTime = Date.now()) {
    const type = classification ? classification.type : 'quiet';
    const rms = msg.rms || 0;
    const peak = msg.peak || rms;

    const isSnore = type === 'snoring';
    const isQuiet = type === 'quiet' || type === 'silence' || rms < 0.0025;
    const isLoudArousal = (type === 'noise' || type === 'snoring') && peak >= 0.02;

    if (this._state === 'QUIET') {
      if (isSnore) {
        this._state = 'SNORING';
        this._snoreWindows = 1;
        this._snoreStartTime = wallTime;
        this._lastSnoreTime = wallTime;
      }
      return null;
    }

    if (this._state === 'SNORING') {
      if (isSnore) {
        this._snoreWindows += 1;
        this._lastSnoreTime = wallTime;
        return null;
      }
      if (isQuiet) {
        // Did we have enough preceding snoring to qualify as a pre-apneic crescendo?
        if (this._snoreWindows >= this.minPreSnoreWindows) {
          this._state = 'POTENTIAL_PAUSE';
          this._pauseStartTime = this._lastSnoreTime;
          this._pauseStartCtx = msg.timestamp || 0;
          this._pauseFloorRms = Math.max(rms, 0.0005);
        } else {
          this._state = 'QUIET';
          this._snoreWindows = 0;
        }
        return null;
      }
      // If noise/bruxism happens, reset
      if (type !== 'bruxism') {
        this._state = 'QUIET';
        this._snoreWindows = 0;
      }
      return null;
    }

    if (this._state === 'POTENTIAL_PAUSE') {
      const pauseDurationSec = (wallTime - this._pauseStartTime) / 1000;

      // Case 1: Still quiet - update pause floor if quieter
      if (isQuiet) {
        if (rms < this._pauseFloorRms) this._pauseFloorRms = rms;
        // If pause exceeded max window (> 90s), this is prolonged deep quiet sleep, not an obstructive apnea
        if (pauseDurationSec > this.maxPauseSec) {
          this._state = 'QUIET';
          this._snoreWindows = 0;
        }
        return null;
      }

      // Case 2: Abrupt sound arrives after >= 10s of silence
      if (pauseDurationSec >= this.minPauseSec && pauseDurationSec <= this.maxPauseSec) {
        const arousal = classifyArousalAcoustics(msg, this._pauseFloorRms);

        if (arousal.isSurge || isLoudArousal) {
          const duration = Math.round(pauseDurationSec * 10) / 10;
          const severity = duration >= 30 ? 'high' : duration >= 20 ? 'medium' : 'low';
          const peakDb = Math.round(20 * Math.log10(Math.max(peak, 1e-6)) * 10) / 10;

          const event = {
            id: 'apnea_' + wallTime + '_' + Math.random().toString(36).slice(2, 7),
            type: 'apnea',
            startTime: Math.round(this._pauseStartTime),
            endTime: Math.round(wallTime),
            duration,
            severity,
            confidence: arousal.confidence,
            peakDb,
            snoreWindowsBefore: this._snoreWindows,
            dbJump: arousal.dbJump,
            timestamp: Math.round(this._pauseStartTime),
          };

          this._detectedEvents.push(event);

          // Reset state: if the arousal was a snore, start new snore train; otherwise go to QUIET
          if (isSnore) {
            this._state = 'SNORING';
            this._snoreWindows = 1;
            this._snoreStartTime = wallTime;
            this._lastSnoreTime = wallTime;
          } else {
            this._state = 'QUIET';
            this._snoreWindows = 0;
          }

          return event;
        }
      }

      // If silence was less than 10s and sound resumed quietly, it was just normal breathing tempo
      if (isSnore) {
        this._state = 'SNORING';
        this._snoreWindows += 1;
        this._lastSnoreTime = wallTime;
      } else {
        this._state = 'QUIET';
        this._snoreWindows = 0;
      }
      return null;
    }

    return null;
  }

  getEvents() {
    return [...this._detectedEvents];
  }

  /**
   * Calculates the Apnea-Hypopnea Index (AHI) and clinical/biohacking insights.
   *
   * @param {number} totalDurationSec - Total sleep recording duration in seconds
   * @param {Array<object>} [events] - Optional list of events to evaluate (defaults to internal events)
   * @param {Array<object>} [allSessionEvents] - Optional full list of session events for cross-correlation
   * @returns {object} Comprehensive AHI metrics & insights
   */
  static calculateAhiMetrics(totalDurationSec, events = [], allSessionEvents = []) {
    const hours = Math.max(0.25, (totalDurationSec || 0) / 3600);
    const apneaEvents = events.filter((e) => e.type === 'apnea');
    const totalPauses = apneaEvents.length;
    const estimatedAhi = Math.round((totalPauses / hours) * 10) / 10;

    let totalPauseDuration = 0;
    let longestPauseSec = 0;
    let longestPauseTime = null;

    for (const ap of apneaEvents) {
      const dur = ap.duration || (ap.endTime - ap.startTime) / 1000;
      totalPauseDuration += dur;
      if (dur > longestPauseSec) {
        longestPauseSec = dur;
        longestPauseTime = ap.startTime;
      }
    }

    // AHI Clinical / Wellness Risk Categories
    let category = 'Optimal';
    let severity = 'normal';
    let color = '#10b981';
    let badgeClass = 'badge--optimal';
    let summaryText = 'Minimal breathing disruption detected overnight.';

    if (estimatedAhi >= 30.0) {
      category = 'High Disruption';
      severity = 'severe';
      color = '#ef4444';
      badgeClass = 'badge--severe';
      summaryText = 'Frequent acoustic breathing pauses observed. Consider consulting a sleep specialist.';
    } else if (estimatedAhi >= 15.0) {
      category = 'Moderate Disruption';
      severity = 'moderate';
      color = '#f97316';
      badgeClass = 'badge--moderate';
      summaryText = 'Moderate respiratory interruptions detected. Positional therapy often helps.';
    } else if (estimatedAhi >= 5.0) {
      category = 'Mild Disruption';
      severity = 'mild';
      color = '#f59e0b';
      badgeClass = 'badge--mild';
      summaryText = 'Mild breathing pauses noted. Common when sleeping on the back or congested.';
    }

    // Biohacking & Cross-Correlation Insights
    const bruxismEvents = allSessionEvents.filter((e) => e.type === 'bruxism');
    let bruxismLinkedToApnea = 0;

    // Check if bruxism occurred within 60s following an apnea arousal (sympathetic surge)
    for (const br of bruxismEvents) {
      const brTime = br.startTime || br.timestamp;
      const linked = apneaEvents.some(
        (ap) => brTime >= ap.endTime - 5000 && brTime <= ap.endTime + 60000
      );
      if (linked) bruxismLinkedToApnea += 1;
    }

    const bruxismCorrelationPct =
      bruxismEvents.length > 0
        ? Math.round((bruxismLinkedToApnea / bruxismEvents.length) * 100)
        : 0;

    return {
      estimatedAhi,
      totalPauses,
      totalPauseDuration: Math.round(totalPauseDuration),
      longestPauseSec: Math.round(longestPauseSec * 10) / 10,
      longestPauseTime,
      category,
      severity,
      color,
      badgeClass,
      summaryText,
      bruxismLinkedToApnea,
      bruxismCorrelationPct,
    };
  }
}
