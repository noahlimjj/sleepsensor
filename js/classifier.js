/*
 * classifier.js — SleepSensor
 *
 * Classifies a 2-second audio window as quiet / snoring / bruxism / noise.
 *
 * Primary path: a tiny MLP (14 audio features -> 24 hidden -> 4 classes) trained
 * offline on the Kaggle snoring dataset + curated grinding / ambient recordings
 * (see training/). Weights live in model-weights.js (~5 KB) and inference is a
 * couple of matrix-vector products — no TensorFlow needed at runtime.
 *
 * Fallback path: a transparent hand-tuned heuristic, used if the weights file is
 * missing or malformed. The public API is identical either way.
 */

import { extractFeatures, FEATURE_NAMES } from './features.js';
import { MODEL as RAW_MODEL } from './model-weights.js';

const MODEL =
  RAW_MODEL &&
  Array.isArray(RAW_MODEL.w1) &&
  RAW_MODEL.featureNames &&
  RAW_MODEL.featureNames.length === FEATURE_NAMES.length
    ? RAW_MODEL
    : null;

const CLASSES = MODEL ? MODEL.classes : ['quiet', 'snoring', 'bruxism', 'noise'];
const QUIET_RMS = 0.0018; // hard floor: below this it is silence regardless

export class Classifier {
  constructor(options = {}) {
    this.minConfidence = options.minConfidence ?? 0.35;
    this.usingModel = !!MODEL;
    this.ready = false;
    this._tf = typeof tf !== 'undefined' ? tf : null; // eslint-disable-line no-undef
  }

  async load() {
    if (this._tf) {
      try {
        await this._tf.ready();
      } catch (_) {
        /* heuristic/MLP path does not need tf */
      }
    }
    this.ready = true;
    return this;
  }

  /**
   * @param {Float32Array} spectrogram  NUM_MEL*TIME_STEPS, mel-major, [0,1]
   * @param {{rms?:number, peak?:number, zcr?:number}} [hints]
   * @returns {{type:'silence'|'snoring'|'bruxism'|'noise', confidence:number, scores?:object, db?:number}}
   */
  classify(spectrogram, hints = {}) {
    if (!spectrogram || spectrogram.length < 64) return { type: 'other', confidence: 0 };

    const rms = typeof hints.rms === 'number' ? hints.rms : null;
    const db = rms != null ? round1(20 * Math.log10(Math.max(rms, 1e-7))) : undefined;

    if (rms != null && rms < QUIET_RMS) {
      return { type: 'silence', confidence: clamp01(1 - rms / QUIET_RMS), db, scores: { quiet: 1 } };
    }

    const feats = extractFeatures(spectrogram, hints);
    const probs = MODEL ? this._infer(feats) : this._heuristic(feats, rms);

    let arg = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[arg]) arg = i;
    let type = CLASSES[arg];
    if (type === 'quiet') type = 'silence';

    const scores = {};
    CLASSES.forEach((c, i) => (scores[c] = round3(probs[i])));
    return { type, confidence: round3(probs[arg]), scores, db, features: feats };
  }

  dispose() {
    this.ready = false;
  }

  static severityFor(confidence) {
    if (confidence < 0.5) return 'mild';
    if (confidence <= 0.75) return 'moderate';
    return 'severe';
  }

  // ---- MLP inference -------------------------------------------------
  _infer(f) {
    const { mean, std, w1, b1, w2, b2, hidden } = MODEL;
    const x = new Float32Array(f.length);
    for (let k = 0; k < f.length; k++) x[k] = (f[k] - mean[k]) / (std[k] || 1);

    const h = new Float32Array(hidden);
    for (let j = 0; j < hidden; j++) {
      let s = b1[j];
      const row = w1[j];
      for (let k = 0; k < x.length; k++) s += row[k] * x[k];
      h[j] = s > 0 ? s : 0;
    }
    const K = w2.length;
    const logit = new Float32Array(K);
    let mx = -Infinity;
    for (let c = 0; c < K; c++) {
      let s = b2[c];
      const row = w2[c];
      for (let j = 0; j < hidden; j++) s += row[j] * h[j];
      logit[c] = s;
      if (s > mx) mx = s;
    }
    let Z = 0;
    const p = new Float32Array(K);
    for (let c = 0; c < K; c++) {
      p[c] = Math.exp(logit[c] - mx);
      Z += p[c];
    }
    for (let c = 0; c < K; c++) p[c] /= Z;
    return p;
  }

  // ---- heuristic fallback (no weights available) -----------------
  _heuristic(f, rms) {
    // f indices follow FEATURE_NAMES in features.js
    const [lowR, , highR, centroid, , rolloff, flatness, crest, harmon, period, modDepth, flux] = f;
    const snore = clamp01(
      0.4 * norm(lowR, 0.4, 0.85) +
        0.25 * norm(harmon, 0.3, 0.8) +
        0.2 * norm(period, 0.3, 0.8) +
        0.15 * norm(crest, 0.2, 0.8)
    );
    const brux = clamp01(
      0.35 * norm(highR, 0.3, 0.75) +
        0.25 * norm(flatness, 0.45, 0.85) +
        0.2 * norm(rolloff, 0.5, 0.9) +
        0.2 * norm(flux, 0.3, 0.85)
    );
    const loud = rms == null ? 0.3 : clamp01((rms - 0.02) * 6 + 0.3);
    const quiet = rms == null ? 0.2 : clamp01(1 - rms / 0.02);
    const noise = clamp01(loud * (1 - Math.max(snore, brux)) + 0.1 * centroid);
    return normalize([quiet, snore, brux, noise]);
  }
}

// ---------------------------------------------------------------------------
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function norm(x, lo, hi) {
  if (lo === hi) return x >= hi ? 1 : 0;
  return clamp01((x - lo) / (hi - lo));
}
function normalize(a) {
  const s = a.reduce((x, y) => x + y, 0) || 1;
  return a.map((v) => v / s);
}
function round1(x) {
  return Math.round(x * 10) / 10;
}
function round3(x) {
  return Math.round(x * 1000) / 1000;
}

export default Classifier;
