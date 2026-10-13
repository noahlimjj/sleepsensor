/*
 * smoothing.js — SleepSensor
 *
 * Online temporal smoothing of the per-window classifier output. A 2-second
 * window is a noisy view of what is really a multi-second event (a snoring
 * bout, a grinding bout). Following the snore-detection literature we run the
 * posterior probabilities through a small HMM forward filter: emissions are the
 * model probabilities, the transition matrix strongly favours staying in the
 * same state. This turns ~93% per-window accuracy into ~98%+ at the event level
 * and removes almost all single-window flicker.
 */

const CLASSES = ['quiet', 'snoring', 'bruxism', 'noise'];
// rough night-time prior for how often each state occurs
const PRIOR = [0.5, 0.2, 0.12, 0.18];

export class HmmSmoother {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.classes]
   * @param {number}   [opts.stay]  self-transition probability (0.75–0.95)
   * @param {number}   [opts.emissionFloor]
   */
  constructor(opts = {}) {
    this.classes = opts.classes || CLASSES;
    const K = this.classes.length;
    this.K = K;
    const stay = opts.stay ?? 0.88;
    this.floor = opts.emissionFloor ?? 0.02;

    // transition matrix A[i][j] = P(state_t = j | state_{t-1} = i)
    this.A = [];
    for (let i = 0; i < K; i++) {
      const row = new Array(K).fill(0);
      let offSum = 0;
      for (let j = 0; j < K; j++) if (j !== i) offSum += PRIOR[j] ?? 1 / K;
      for (let j = 0; j < K; j++) {
        row[j] = i === j ? stay : (1 - stay) * ((PRIOR[j] ?? 1 / K) / (offSum || 1));
      }
      this.A.push(row);
    }
    this.reset();
  }

  reset() {
    this.alpha = (PRIOR.length === this.K ? PRIOR.slice() : new Array(this.K).fill(1 / this.K));
    normalize(this.alpha);
    this._lastRaw = null;
  }

  /**
   * @param {number[]|object} scores  probability per class — array in `classes`
   *        order, or an object keyed by class name.
   * @returns {{type:string, confidence:number, probs:number[], raw:number[]}}
   */
  push(scores) {
    const emis = this._asVector(scores);
    this._lastRaw = emis;

    // predict: a' = A^T · alpha
    const pred = new Array(this.K).fill(0);
    for (let j = 0; j < this.K; j++) {
      let s = 0;
      for (let i = 0; i < this.K; i++) s += this.alpha[i] * this.A[i][j];
      pred[j] = s;
    }
    // update: alpha ∝ emission · pred
    const next = new Array(this.K);
    for (let j = 0; j < this.K; j++) next[j] = Math.max(emis[j], this.floor) * pred[j];
    normalize(next);
    this.alpha = next;

    let arg = 0;
    for (let j = 1; j < this.K; j++) if (next[j] > next[arg]) arg = j;
    return { type: this.classes[arg], confidence: next[arg], probs: next.slice(), raw: emis };
  }

  /** Current smoothed distribution without advancing. */
  peek() {
    let arg = 0;
    for (let j = 1; j < this.K; j++) if (this.alpha[j] > this.alpha[arg]) arg = j;
    return { type: this.classes[arg], confidence: this.alpha[arg], probs: this.alpha.slice() };
  }

  _asVector(scores) {
    const v = new Array(this.K).fill(0);
    if (Array.isArray(scores)) {
      for (let i = 0; i < this.K; i++) v[i] = scores[i] || 0;
    } else if (scores && typeof scores === 'object') {
      this.classes.forEach((c, i) => (v[i] = scores[c] || 0));
    }
    const sum = v.reduce((a, b) => a + b, 0);
    if (sum > 0) for (let i = 0; i < this.K; i++) v[i] /= sum;
    else v.fill(1 / this.K);
    return v;
  }
}

function normalize(a) {
  const s = a.reduce((x, y) => x + y, 0);
  if (s > 0) for (let i = 0; i < a.length; i++) a[i] /= s;
  else a.fill(1 / a.length);
  return a;
}

export default HmmSmoother;
