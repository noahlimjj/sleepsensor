/*
 * classifier.js — SleepSensor
 *
 * Classifies a 2-second audio window as quiet / snoring / bruxism / noise.
 *
 * Primary path: a small MLP over 46 audio features, trained offline (see
 * training/) on the Kaggle snoring dataset + curated grinding / ambient audio
 * with augmentation and a recording-independent test split. Weights ship as
 * plain arrays in model-weights.js; inference is a few matrix-vector products —
 * no TensorFlow needed at runtime.
 *
 * Fallback path: a transparent hand-tuned heuristic, used if the weights file is
 * missing or malformed. The public API is identical either way.
 *
 * Per-window output is inherently noisy; feed `.scores` through HmmSmoother
 * (smoothing.js) for stable event-level decisions — AudioEngine does this.
 */

import { extractFeatures, FEATURE_NAMES } from './features.js';
import { MODEL as RAW_MODEL } from './model-weights.js';

const MODEL =
  RAW_MODEL &&
  Array.isArray(RAW_MODEL.layers) &&
  RAW_MODEL.layers.length > 0 &&
  RAW_MODEL.featureNames &&
  RAW_MODEL.featureNames.length === FEATURE_NAMES.length
    ? RAW_MODEL
    : null;

const CLASSES = MODEL ? MODEL.classes : ['quiet', 'snoring', 'bruxism', 'noise'];
const QUIET_RMS = 0.0018; // hard floor: below this it is silence regardless

// Flip to true only when training/train-cnn.mjs has produced a js/model-cnn/
// that beats the feature MLP (it did not on the current dataset). Guards a
// 404 for the model files when no CNN is shipped.
const CNN_ENABLED = false;

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
        await this._loadCnn();
      } catch (_) {
        /* the feature-MLP / heuristic path does not need tf */
      }
    }
    this.ready = true;
    return this;
  }

  async _loadCnn() {
    // Optional high-accuracy path: a small CNN over the log-mel spectrogram,
    // exported as a TF.js LayersModel to js/model-cnn/. Absent => feature MLP.
    if (!CNN_ENABLED) return;
    try {
      const base = new URL('./model-cnn/', import.meta.url);
      const meta = await fetch(new URL('meta.json', base)).then((r) => (r.ok ? r.json() : null));
      if (!meta || !meta.classes) return;
      this.cnn = await this._tf.loadLayersModel(new URL('model.json', base).href);
      this.cnnMeta = meta;
      // warm up so the first real inference isn't slow
      const w = this._tf.zeros([1, meta.mels, meta.frames, 1]);
      const p = this.cnn.predict(w);
      p.dataSync();
      w.dispose();
      p.dispose();
      this.usingModel = 'cnn';
    } catch (err) {
      console.warn('[Classifier] CNN unavailable, using feature MLP:', err && err.message);
      this.cnn = null;
    }
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

    let probs;
    let classList = CLASSES;
    if (this.cnn) {
      probs = this._cnnInfer(spectrogram);
      classList = this.cnnMeta.classes;
    } else {
      const feats = extractFeatures(spectrogram, hints);
      probs = MODEL ? this._infer(feats) : this._heuristic(feats, rms);
    }

    let arg = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[arg]) arg = i;
    let type = classList[arg];
    if (type === 'quiet') type = 'silence';

    const scores = {};
    classList.forEach((c, i) => (scores[c] = round3(probs[i])));
    return { type, confidence: round3(probs[arg]), scores, db };
  }

  _cnnInfer(spec) {
    const { mels, frames } = this.cnnMeta;
    const need = mels * frames;
    let input = spec;
    if (spec.length !== need) {
      // live worklet emits 128×frames mel-major; average band pairs down to `mels`
      const srcMels = Math.round(spec.length / frames);
      input = new Float32Array(need);
      const ratio = srcMels / mels;
      for (let m = 0; m < mels; m++) {
        const s0 = Math.floor(m * ratio);
        const s1 = Math.max(s0 + 1, Math.floor((m + 1) * ratio));
        for (let t = 0; t < frames; t++) {
          let acc = 0;
          for (let s = s0; s < s1; s++) acc += spec[s * frames + t];
          input[m * frames + t] = acc / (s1 - s0);
        }
      }
    }
    return this._tf.tidy(() => {
      const x = this._tf.tensor4d(input, [1, mels, frames, 1]);
      const out = this.cnn.predict(x);
      const arr = out.dataSync();
      return Float32Array.from(arr);
    });
  }

  dispose() {
    this.ready = false;
  }

  static severityFor(confidence) {
    if (confidence < 0.5) return 'mild';
    if (confidence <= 0.75) return 'moderate';
    return 'severe';
  }

  // ---- MLP inference (variable-depth dense net, weights [in][out]) ----
  _infer(f) {
    const { mean, std, layers } = MODEL;
    let a = new Float32Array(f.length);
    for (let k = 0; k < f.length; k++) a[k] = (f[k] - mean[k]) / (std[k] || 1);

    for (let li = 0; li < layers.length; li++) {
      const { w, b, act } = layers[li];
      const inN = w.length;
      const outN = b.length;
      const z = new Float32Array(outN);
      for (let o = 0; o < outN; o++) z[o] = b[o];
      for (let i = 0; i < inN; i++) {
        const wi = w[i];
        const ai = a[i];
        if (ai === 0) continue;
        for (let o = 0; o < outN; o++) z[o] += wi[o] * ai;
      }
      if (act === 'relu') {
        for (let o = 0; o < outN; o++) if (z[o] < 0) z[o] = 0;
      } else if (act === 'softmax') {
        let mx = -Infinity;
        for (let o = 0; o < outN; o++) if (z[o] > mx) mx = z[o];
        let Z = 0;
        for (let o = 0; o < outN; o++) {
          z[o] = Math.exp(z[o] - mx);
          Z += z[o];
        }
        for (let o = 0; o < outN; o++) z[o] /= Z;
      } else if (act === 'tanh') {
        for (let o = 0; o < outN; o++) z[o] = Math.tanh(z[o]);
      }
      a = z;
    }
    return a;
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
