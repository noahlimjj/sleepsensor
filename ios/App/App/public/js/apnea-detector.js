/*
 * apnea-detector.js — SleepSensor
 *
 * Acoustic breathing-pause detection. Apneas and hypopneas have a recognisable
 * sound pattern: breathing or snoring fades or stops for ten seconds or more,
 * then comes back abruptly with a snort, a gasp or a few heavy breaths as the
 * sleeper partially wakes.
 *
 * The detector listens for that pattern in the 1–4 kHz "breathing band" level
 * that the worklet measures every 100 ms. That band is used instead of the
 * plain level because room rumble (air-con, traffic, hum) sits far below it
 * and would otherwise hide quiet breathing completely.
 *
 * Validation (training/ahi): 20 hours of hospital sleep studies from 18
 * patients with a room microphone above the bed (PSG-Audio dataset), scored by
 * sleep technicians. Leave-one-patient-out, events per hour against the
 * scored rate: correlation 0.84, mean absolute error 10 per hour, every hour
 * at 15+/h flagged as 15+, two thirds of hours under 15/h kept under 15.
 * The previous snore → silence → snort rule found no events at all on the
 * same recordings.
 *
 * Sound alone cannot see breathing effort or blood oxygen, so the resulting
 * "estimated AHI" is a wellness indicator only — never a diagnosis.
 */

const WIDEBAND_ZCR = 0.15; // breathy, broadband gasps cross zero often
const SNORE_MIN_CONF = 0.35;
const BRUXISM_LINK_MS = 60000; // grinding this soon after a pause counts as linked
const GAP_RESET_MS = 6000; // a hole in the audio this long restarts the listening

// estimated-AHI tiers (events per hour)
const TIERS = [
  { max: 5, key: 'optimal', label: 'Optimal' },
  { max: 15, key: 'mild', label: 'Mild' },
  { max: 30, key: 'moderate', label: 'Moderate' },
  { max: Infinity, key: 'severe', label: 'Severe' },
];

/**
 * Streaming "quiet, then a loud recovery" detector over the worklet's 1–4 kHz
 * breathing-band level (one dBFS value per 100 ms).
 *
 * Every second it compares three stretches of sound against a rolling noise
 * floor: the 30 s before (was there breathing?), the last 10 s (a pause?) and
 * the next 5 s (a recovery?). Moments where the level jumps back up are
 * candidates; a small logistic model, fitted to hospital sleep studies with
 * room-microphone audio (training/ahi), turns each candidate's shape into the
 * probability that it ends a real apnea or hypopnea.
 */
export const BREATH = {
  frameHz: 10,
  floorSec: 120, // rolling noise floor = 20th percentile of the last 2 min
  floorPct: 0.2,
  pauseSec: 10,
  preSec: 30,
  postSec: 5,
  minJumpDb: 4, // candidate: recovery at least this far above the pause
  refractorySec: 15, // one candidate per 15 s either side
  activeDb: 3, // "sound present" = this far above the floor
  lookaheadSec: 30,
  nearSec: 180,
  // candidates at least this likely count as events; set so that the number
  // kept equals the number scored across the validation sleep studies
  minProb: 0.296,
};

// logistic weights: jump, drop, lPause, near, gap, gap15, preAct, postAct, postLong, bias
export const BREATH_WEIGHTS = [0.69, 0.024, -0.613, 0.944, -0.317, 1.018, -1.116, 0.167, -0.566, -1.29];

export function breathFeatures(c) {
  return [
    Math.min(c.jump, 15) / 5,
    Math.max(-5, Math.min(c.drop, 15)) / 5,
    Math.min(c.lPause, 10) / 5,
    Math.min(c.near, 8) / 4,
    Math.min(c.gap, 40) / 20,
    c.gap >= 15 ? 1 : 0,
    c.preAct / 15,
    c.postAct / 15,
    c.postAct >= 20 ? 1 : 0,
  ];
}

export function breathProbability(c, w = BREATH_WEIGHTS) {
  const f = breathFeatures(c);
  let z = w[f.length];
  for (let k = 0; k < f.length; k++) z += w[k] * f[k];
  return 1 / (1 + Math.exp(-z));
}

export class BreathPauseTracker {
  constructor(opts = {}) {
    this.o = { ...BREATH, ...opts };
    this.weights = opts.weights || BREATH_WEIGHTS;
    this.reset();
  }

  reset() {
    this.frames = []; // recent 100 ms levels (dB) for the floor
    this._acc = 0;
    this._accN = 0;
    this.pw = []; // per-second mean power, index = second number
    this.fl = []; // per-second floor power
    this.base = 0; // second number of pw[0]
    this.n = 0; // seconds seen
    this.jumps = new Map(); // second -> candidate row
    this.cands = []; // recent accepted local maxima (for `near`)
    this.expected = 0; // sum of probabilities = expected event count
  }

  /** feed 100 ms levels; returns the candidates (with .prob) decided by them */
  push(levelsDb) {
    const out = [];
    const o = this.o;
    for (let i = 0; i < levelsDb.length; i++) {
      const v = levelsDb[i];
      this.frames.push(v);
      if (this.frames.length > o.floorSec * o.frameHz) this.frames.shift();
      this._acc += 10 ** (v / 10);
      if (++this._accN < o.frameHz) continue;
      const sorted = Float64Array.from(this.frames).sort();
      this.pw.push(this._acc / o.frameHz);
      this.fl.push(10 ** (sorted[Math.floor(sorted.length * o.floorPct)] / 10));
      this._acc = 0;
      this._accN = 0;
      this.n += 1;
      const c = this._second();
      if (c) out.push(c);
    }
    return out;
  }

  _mean(a, b) {
    let s = 0;
    for (let t = a; t < b; t++) s += this.pw[t - this.base];
    return s / (b - a);
  }

  _excess(t) {
    const i = t - this.base;
    if (i < 0 || t >= this.n) return 0;
    return 10 * Math.log10(Math.max(this.pw[i] / this.fl[i], 1e-3));
  }

  _second() {
    const o = this.o;
    // 1) the recovery jump for second t needs sound up to t + postSec
    const t = this.n - o.postSec;
    if (t >= o.preSec + o.pauseSec) {
      const f = this.fl[t - 1 - this.base];
      const dB = (x) => 10 * Math.log10(Math.max(x / f, 1e-3));
      const lPause = dB(this._mean(t - o.pauseSec, t));
      const lPre = dB(this._mean(t - o.pauseSec - o.preSec, t - o.pauseSec));
      const lPost = dB(this._mean(t, t + o.postSec));
      this.jumps.set(t, { t, lPause, lPre, lPost, jump: lPost - lPause, drop: lPre - lPause });
    }
    // 2) decide second tc once everything around it has been heard
    const tc = this.n - o.lookaheadSec;
    let found = null;
    const r = this.jumps.get(tc);
    if (r && r.jump >= o.minJumpDb) {
      let top = true;
      for (let j = tc - o.refractorySec; j <= tc + o.refractorySec && top; j++) {
        const q = this.jumps.get(j);
        if (q && (q.jump > r.jump || (q.jump === r.jump && j < tc))) top = false;
      }
      if (top) {
        let gap = 0;
        while (gap < 90 && this._excess(tc - 1 - gap) < o.activeDb) gap++;
        const g0 = tc - gap;
        let preAct = 0;
        for (let s = g0 - 30; s < g0; s++) if (this._excess(s) >= o.activeDb) preAct++;
        let postAct = 0;
        for (let s = tc; s < tc + 30; s++) if (this._excess(s) >= o.activeDb) postAct++;
        this.cands = this.cands.filter((x) => tc - x <= o.nearSec);
        found = { ...r, gap, start: g0, end: tc, preAct, postAct, near: this.cands.length };
        this.cands.push(tc);
        found.prob = breathProbability(found, this.weights);
        this.expected += found.prob;
      }
    }
    // 3) forget what can no longer be needed (keep 2.5 min of seconds)
    const keep = 150 + o.preSec + o.pauseSec;
    while (this.n - this.base > keep) {
      this.pw.shift();
      this.fl.shift();
      this.jumps.delete(this.base - o.refractorySec - 1);
      this.base += 1;
    }
    return found;
  }
}

export class ApneaDetector {
  constructor(opts = {}) {
    this.tracker = new BreathPauseTracker(opts);
    this.reset();
  }

  reset() {
    this.tracker.reset();
    this.events = [];
    this.state = 'idle'; // 'idle' until sound arrives, then 'listening'
    this._t0 = 0; // wall-clock ms of the tracker's second 0
    this._lastWall = 0;
    this._recent = []; // last minute of windows, to describe the recovery sound
  }

  /**
   * Feed one classification window.
   *   result — raw classifier verdict { type, confidence }
   *   msg    — worklet message { rms, peak, zcr, breath: [dBFS per 100 ms] }
   *   wall   — wall-clock ms at the END of the window
   * Returns an apnea event when a pause has just been confirmed, else null.
   * Confirmation comes about 30 s after the breathing returns, because the
   * detector also looks at what the sound does next.
   */
  feed(result, msg, wall) {
    const frames = msg && msg.breath;
    if (!frames || !frames.length) return null;
    const span = frames.length * 100;
    if (this.state === 'idle' || wall - this._lastWall > span + GAP_RESET_MS) {
      // first sound, or the microphone was interrupted: start a fresh timeline
      this.tracker.reset();
      this._recent = [];
      this._t0 = wall - span;
      this.state = 'listening';
    }
    this._lastWall = wall;
    this._recent.push({
      wall,
      type: (result && result.type) || 'other',
      confidence: (result && result.confidence) || 0,
      zcr: (msg && msg.zcr) || 0,
      peak: (msg && (msg.peak ?? msg.rms)) || 0,
    });
    if (this._recent.length > 40) this._recent.shift();

    let event = null;
    for (const c of this.tracker.push(frames)) {
      if (c.prob < this.tracker.o.minProb) continue;
      event = this._makeEvent(c);
      this.events.push(event);
    }
    return event;
  }

  _makeEvent(c) {
    const o = this.tracker.o;
    const endTime = this._t0 + c.end * 1000;
    // a pause with faint sound still in it (a hypopnea) is timed as the 10 s dip
    const duration = Math.max(c.gap, o.pauseSec);
    // the window in which breathing came back says what the recovery sounded like
    const win = this._recent.find((w) => w.wall > endTime) || this._recent[this._recent.length - 1] || {};
    const snort = win.type === 'snoring' && win.confidence >= SNORE_MIN_CONF;
    const arousal = snort ? 'snort' : win.zcr >= WIDEBAND_ZCR ? 'gasp' : 'arousal';
    return {
      type: 'apnea',
      startTime: Math.round(endTime - duration * 1000),
      endTime: Math.round(endTime),
      duration: round1(duration),
      confidence: Math.round(Math.min(0.95, c.prob) * 1000) / 1000,
      severity: duration < 20 ? 'mild' : duration < 40 ? 'moderate' : 'severe',
      arousal,
      arousalJumpDb: round1(c.jump),
      peakDb: round1(toDb(win.peak)),
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
      out.push('No breathing pauses were heard tonight.');
    } else {
      out.push(
        `${m.apneaEvents} breathing pause${m.apneaEvents === 1 ? '' : 's'} heard ` +
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
function round1(x) {
  return Math.round(x * 10) / 10;
}

export default ApneaDetector;
