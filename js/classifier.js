/*
 * classifier.js — SleepSensor
 *
 * MVP heuristic audio classifier. Takes a normalised log-mel spectrogram
 * (128 mel bands x 64 time steps, mel-major, values in [0, 1]) and decides
 * whether the window contains snoring, bruxism (teeth grinding), silence, or
 * something else.
 *
 * This is deliberately a transparent, explainable heuristic rather than a
 * black-box model — it can be swapped for a real TF.js model later without
 * changing the public API. If the global `tf` (TensorFlow.js, loaded from CDN)
 * is present we warm its backend up during load() so a future model swap has
 * no cold-start cost.
 */

const NUM_MEL = 128;
const TIME_STEPS = 64;

// Mel-band boundaries. With a 0–8 kHz range over 128 mel bands:
//   ~500 Hz  -> band ~27   (upper edge of the snoring region)
//   ~1000 Hz -> band ~45   (lower edge of the bruxism region)
const LOW_BAND_HI = 30; // bands [0, 30)  ~ low frequency / snoring energy
const HIGH_BAND_LO = 60; // bands [60, 128) ~ high frequency / grinding energy

export class Classifier {
  constructor(options = {}) {
    this.numMel = options.numMel || NUM_MEL;
    this.timeSteps = options.timeSteps || TIME_STEPS;
    this.minConfidence = options.minConfidence ?? 0.35;
    this.ready = false;
    this._tf = typeof tf !== 'undefined' ? tf : null; // eslint-disable-line no-undef
  }

  async load() {
    if (this._tf) {
      try {
        await this._tf.ready();
        // touch a tiny tensor to force backend init, then free it
        const t = this._tf.tensor1d([0, 1, 2]);
        t.dispose();
      } catch (err) {
        console.warn('[Classifier] tf warm-up failed, continuing with heuristic only:', err);
      }
    }
    this.ready = true;
    return this;
  }

  /**
   * @param {Float32Array} spectrogram length numMel*timeSteps, mel-major, [0,1]
   * @param {{rms?:number}} [opts] optional raw window RMS energy from the worklet.
   *        The mel spectrogram is loudness-normalised, so the absolute RMS is the
   *        only reliable silence cue — pass it when available.
   * @returns {{type:'silence'|'snoring'|'bruxism'|'other', confidence:number, features?:object}}
   */
  classify(spectrogram, opts = {}) {
    if (!spectrogram || spectrogram.length < this.numMel) {
      return { type: 'other', confidence: 0 };
    }
    const f = this._features(spectrogram);

    // --- silence -----------------------------------------------------------
    // primary: absolute loudness below the quiet-room floor
    if (typeof opts.rms === 'number' && opts.rms < 0.008) {
      return { type: 'silence', confidence: clamp01(1 - opts.rms / 0.008), features: f };
    }
    // secondary (no RMS available): featureless + very low modulation
    if (f.meanEnergy < 0.1 && f.maxBandEnergy < 0.15) {
      return { type: 'silence', confidence: clamp01(1 - f.meanEnergy * 5), features: f };
    }

    // --- snoring ---------------------------------------------------------
    // low-frequency dominant + amplitude modulated (breath in / out) + tonal
    const snoreScore =
      0.45 * norm(f.lowFreqRatio, 0.45, 0.85) +
      0.30 * norm(f.periodicity, 0.35, 0.8) +
      0.15 * norm(f.centroidBand, 45, 12) + // lower centroid -> higher score
      0.10 * norm(1 - f.spectralFlatness, 0.35, 0.85);

    // --- bruxism -------------------------------------------------------
    // high-frequency broadband noise, non-periodic, spectrally flat
    const bruxScore =
      0.40 * norm(f.highFreqRatio, 0.35, 0.75) +
      0.25 * norm(f.spectralFlatness, 0.45, 0.85) +
      0.20 * norm(f.centroidBand, 45, 95) + // higher centroid -> higher score
      0.15 * norm(1 - f.periodicity, 0.4, 0.85);

    const snoreGate = f.lowFreqRatio > 0.6 && f.periodicity > 0.5;
    const bruxGate = f.highFreqRatio > 0.5 && f.spectralFlatness > 0.6;

    if (snoreGate && snoreScore >= bruxScore) {
      return { type: 'snoring', confidence: clamp01(snoreScore), features: f };
    }
    if (bruxGate) {
      return { type: 'bruxism', confidence: clamp01(bruxScore), features: f };
    }
    // soft fallback: strong single-sided score even if the hard gate missed
    if (snoreScore > 0.7 && snoreScore > bruxScore) {
      return { type: 'snoring', confidence: clamp01(snoreScore * 0.85), features: f };
    }
    if (bruxScore > 0.7) {
      return { type: 'bruxism', confidence: clamp01(bruxScore * 0.85), features: f };
    }
    return { type: 'other', confidence: clamp01(Math.max(snoreScore, bruxScore)), features: f };
  }

  dispose() {
    if (this._tf) {
      try {
        this._tf.disposeVariables();
      } catch (_) {
        /* noop */
      }
    }
    this.ready = false;
  }

  /** Map a confidence score to a coarse severity bucket. */
  static severityFor(confidence) {
    if (confidence < 0.5) return 'mild';
    if (confidence <= 0.75) return 'moderate';
    return 'severe';
  }

  // -----------------------------------------------------------------------
  // feature extraction
  // -----------------------------------------------------------------------
  _features(spec) {
    const M = this.numMel;
    const T = this.timeSteps;

    // per-band mean energy over time, and per-frame energy envelope over bands
    const bandMean = new Float32Array(M);
    const envelope = new Float32Array(T);
    let total = 0;
    for (let m = 0; m < M; m++) {
      let acc = 0;
      for (let t = 0; t < T; t++) {
        const v = spec[m * T + t];
        acc += v;
        envelope[t] += v;
      }
      bandMean[m] = acc / T;
      total += bandMean[m];
    }
    for (let t = 0; t < T; t++) envelope[t] /= M;

    const totalSafe = total || 1e-9;
    let low = 0;
    let high = 0;
    for (let m = 0; m < M; m++) {
      if (m < LOW_BAND_HI) low += bandMean[m];
      if (m >= HIGH_BAND_LO) high += bandMean[m];
    }
    const lowFreqRatio = low / totalSafe;
    const highFreqRatio = high / totalSafe;

    // spectral centroid in band units
    let cNum = 0;
    for (let m = 0; m < M; m++) cNum += m * bandMean[m];
    const centroidBand = cNum / totalSafe;

    // spectral flatness = geometric mean / arithmetic mean of band energies
    let logSum = 0;
    let arith = 0;
    for (let m = 0; m < M; m++) {
      const v = bandMean[m] + 1e-6;
      logSum += Math.log(v);
      arith += v;
    }
    const geo = Math.exp(logSum / M);
    const spectralFlatness = clamp01(geo / (arith / M));

    // amplitude modulation / periodicity of the energy envelope.
    // grinding is fairly steady; snoring rises and falls within the window.
    const envMean = mean(envelope);
    let envVar = 0;
    for (let t = 0; t < T; t++) envVar += (envelope[t] - envMean) ** 2;
    envVar /= T;
    const modulationDepth = envMean > 1e-6 ? Math.sqrt(envVar) / envMean : 0;

    // normalised autocorrelation peak (excluding lag 0) — captures a repeating
    // rise/fall pattern typical of breathing cycles.
    let acPeak = 0;
    for (let lag = 2; lag < Math.floor(T / 2); lag++) {
      let num = 0;
      let den = 0;
      for (let t = 0; t < T - lag; t++) {
        num += (envelope[t] - envMean) * (envelope[t + lag] - envMean);
        den += (envelope[t] - envMean) ** 2;
      }
      if (den > 1e-9) acPeak = Math.max(acPeak, num / den);
    }
    const periodicity = clamp01(0.5 * clamp01(modulationDepth * 1.6) + 0.5 * clamp01(acPeak));

    const maxBandEnergy = Math.max(...bandMean);

    return {
      meanEnergy: total / M,
      maxBandEnergy,
      lowFreqRatio,
      highFreqRatio,
      centroidBand,
      spectralFlatness,
      periodicity,
      modulationDepth,
    };
  }
}

// ---------------------------------------------------------------------------
// small numeric helpers
// ---------------------------------------------------------------------------
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / (arr.length || 1);
}
/** Linear ramp: 0 at `lo`, 1 at `hi`, clamped. Works with lo > hi (inverted). */
function norm(x, lo, hi) {
  if (lo === hi) return x >= hi ? 1 : 0;
  return clamp01((x - lo) / (hi - lo));
}

export default Classifier;
