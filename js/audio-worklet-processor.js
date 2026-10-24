/*
 * audio-worklet-processor.js — SleepSensor
 *
 * Runs on the audio rendering thread. Receives raw PCM, computes RMS energy
 * for live visualisation, accumulates 2-second windows, turns each window into
 * a log-mel spectrogram, applies a noise gate, and keeps a 30-second rolling
 * buffer of raw audio so the main thread can pull clips for flagged events.
 *
 * IMPORTANT: this file runs in the AudioWorkletGlobalScope. It must not use
 * `import`. A small CommonJS guard at the bottom exposes the pure DSP helpers
 * to Node for unit testing; it is inert in the browser.
 */

// ---------------------------------------------------------------------------
// Pure DSP helpers (no worklet globals referenced here)
// ---------------------------------------------------------------------------

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

/**
 * In-place iterative radix-2 Cooley–Tukey FFT.
 * `re` / `im` are Float32Array of length N (power of two). Transforms in place.
 */
function fftRadix2(re, im) {
  const n = re.length;
  if (n <= 1) return;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wpr = Math.cos(ang);
    const wpi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nwr = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = nwr;
      }
    }
  }
}

function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel) {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

/**
 * Build a [numMel][numBins] triangular mel filterbank matrix.
 * numBins = fftSize/2 + 1.
 */
function buildMelFilterbank(numMel, fftSize, sampleRate, fMin = 0, fMax = null) {
  const nyquist = sampleRate / 2;
  const top = fMax == null ? nyquist : Math.min(fMax, nyquist);
  const numBins = fftSize / 2 + 1;
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(top);
  const points = new Float32Array(numMel + 2);
  for (let i = 0; i < points.length; i++) {
    points[i] = melToHz(melMin + ((melMax - melMin) * i) / (numMel + 1));
  }
  // map hz -> fft bin
  const bin = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    bin[i] = (points[i] / nyquist) * (numBins - 1);
  }
  const fb = [];
  for (let m = 1; m <= numMel; m++) {
    const row = new Float32Array(numBins);
    const left = bin[m - 1];
    const center = bin[m];
    const right = bin[m + 1];
    for (let k = 0; k < numBins; k++) {
      let v = 0;
      if (k >= left && k <= center && center > left) {
        v = (k - left) / (center - left);
      } else if (k > center && k <= right && right > center) {
        v = (right - k) / (right - center);
      }
      row[k] = v;
    }
    fb.push(row);
  }
  return fb;
}

/**
 * Compute a normalised log-mel spectrogram for a mono window.
 *
 * @returns Float32Array of length numMel * timeSteps, mel-major
 *          (index = mel * timeSteps + t), values in [0, 1].
 */
function melSpectrogram(samples, opts) {
  const {
    fftSize = 512,
    hop = 256,
    numMel = 128,
    timeSteps = 64,
    sampleRate = 16000,
    melFb = null,
  } = opts || {};

  const win = hannWindow(fftSize);
  const fb = melFb || buildMelFilterbank(numMel, fftSize, sampleRate);
  const numBins = fftSize / 2 + 1;

  const framesAvail = Math.max(1, 1 + Math.floor((samples.length - fftSize) / hop));
  // raw mel frames
  const melFrames = [];
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  for (let f = 0; f < framesAvail; f++) {
    const start = f * hop;
    for (let i = 0; i < fftSize; i++) {
      const s = start + i;
      re[i] = s < samples.length ? samples[s] * win[i] : 0;
      im[i] = 0;
    }
    fftRadix2(re, im);
    const power = new Float32Array(numBins);
    for (let k = 0; k < numBins; k++) {
      power[k] = (re[k] * re[k] + im[k] * im[k]) / fftSize;
    }
    const mel = new Float32Array(numMel);
    for (let m = 0; m < numMel; m++) {
      const row = fb[m];
      let acc = 0;
      for (let k = 0; k < numBins; k++) acc += row[k] * power[k];
      mel[m] = Math.log(Math.max(acc, 1e-10));
    }
    melFrames.push(mel);
  }

  // resample time axis to exactly `timeSteps` by linear interpolation
  const out = new Float32Array(numMel * timeSteps);
  let min = Infinity;
  let max = -Infinity;
  for (let t = 0; t < timeSteps; t++) {
    const pos = melFrames.length === 1 ? 0 : (t * (melFrames.length - 1)) / (timeSteps - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(melFrames.length - 1, i0 + 1);
    const frac = pos - i0;
    for (let m = 0; m < numMel; m++) {
      const v = melFrames[i0][m] * (1 - frac) + melFrames[i1][m] * frac;
      out[m * timeSteps + t] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const range = max - min || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) / range;
  return out;
}

function rms(buf, from = 0, to = buf.length) {
  let acc = 0;
  for (let i = from; i < to; i++) acc += buf[i] * buf[i];
  const n = Math.max(1, to - from);
  return Math.sqrt(acc / n);
}

function peakAbs(buf) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i];
    if (a > m) m = a;
  }
  return m;
}

// loudest short-frame RMS in the buffer. A 2 s average dilutes a brief sound
// (a cough, a single snore, a grind burst) into the background; the loudest
// ~100 ms slice does not.
function maxFrameRms(buf, frame = 1600) {
  if (buf.length <= frame) return rms(buf);
  let m = 0;
  const hop = frame >> 1;
  for (let i = 0; i + frame <= buf.length; i += hop) {
    const r = rms(buf, i, i + frame);
    if (r > m) m = r;
  }
  return m;
}

// background level inside the buffer: a low percentile of short-frame RMS.
// Even mid-snoring-bout the gaps between breaths fall back to the room's own
// noise, so this tracks the floor without being dragged up by the sound.
function quietFrameRms(buf, frame = 1600, pct = 0.1) {
  if (buf.length <= frame) return rms(buf);
  const hop = frame >> 1;
  const vals = [];
  for (let i = 0; i + frame <= buf.length; i += hop) vals.push(rms(buf, i, i + frame));
  vals.sort((a, b) => a - b);
  return vals[Math.floor((vals.length - 1) * pct)];
}

// ---- A-weighting (IEC 61672) ------------------------------------------------
// Analog prototype k·s⁴ / ((s+ω1)²(s+ω2)(s+ω3)(s+ω4)²) split into first-order
// sections, each mapped with the bilinear transform, then normalised to 0 dB
// at 1 kHz. Run at the device's native rate so the whole audible band counts.
const A_POLES_HZ = [20.598997, 107.65265, 737.86223, 12194.217];

function aWeightingSections(fs) {
  const K = 2 * fs;
  const w = A_POLES_HZ.map((f) => 2 * Math.PI * f);
  // [b0, b1, a1] for y = b0 x + b1 x[-1] - a1 y[-1]
  const hp = (wp) => [K / (K + wp), -K / (K + wp), (wp - K) / (K + wp)];
  const lp = (wp) => [1 / (K + wp), 1 / (K + wp), (wp - K) / (K + wp)];
  // prewarp the 12 kHz pole: the bilinear transform squeezes it towards Nyquist
  const w4 = Math.min(K * Math.tan(w[3] / K), K * 20);
  const secs = [hp(w[0]), hp(w[0]), hp(w[1]), hp(w[2]), lp(w4), lp(w4)];
  // normalise |H(1 kHz)| to 1
  const om = (2 * Math.PI * 1000) / fs;
  let mag = 1;
  for (const [b0, b1, a1] of secs) {
    const nr = b0 + b1 * Math.cos(om), ni = -b1 * Math.sin(om);
    const dr = 1 + a1 * Math.cos(om), di = -a1 * Math.sin(om);
    mag *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  secs[0] = [secs[0][0] / mag, secs[0][1] / mag, secs[0][2]];
  return secs;
}

/** Stateful A-weighting filter + IEC "Fast" (125 ms) exponential averager. */
function createLevelMeter(fs) {
  const secs = aWeightingSections(fs);
  const xs = new Float64Array(secs.length);
  const ys = new Float64Array(secs.length);
  const alpha = 1 - Math.exp(-1 / (fs * 0.125));
  let fast = 0; // fast-weighted mean square
  return {
    // feeds samples; returns { sumSq, n, fastMaxSq, fastSq }
    process(buf) {
      let sumSq = 0;
      let fastMax = 0;
      for (let i = 0; i < buf.length; i++) {
        let v = buf[i];
        for (let k = 0; k < secs.length; k++) {
          const [b0, b1, a1] = secs[k];
          const y = b0 * v + b1 * xs[k] - a1 * ys[k];
          xs[k] = v;
          ys[k] = y;
          v = y;
        }
        const sq = v * v;
        sumSq += sq;
        fast += alpha * (sq - fast);
        if (fast > fastMax) fastMax = fast;
      }
      return { sumSq, n: buf.length, fastMaxSq: fastMax, fastSq: fast };
    },
  };
}

// zero-crossing rate — high for noise/grinding, low for tonal snoring
function zcr(buf) {
  let c = 0;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i - 1] >= 0) !== (buf[i] >= 0)) c++;
  }
  return c / Math.max(1, buf.length - 1);
}

// ---------------------------------------------------------------------------
// Worklet processor (only defined when running in the audio thread)
// ---------------------------------------------------------------------------

if (typeof registerProcessor !== 'undefined' && typeof AudioWorkletProcessor !== 'undefined') {
  // The audio graph runs at the device's native rate (44.1/48 kHz). We resample
  // to a fixed 16 kHz internally so the spectrogram, features and the trained
  // model see exactly what they were trained on regardless of hardware.
  const NATIVE_SR = typeof sampleRate !== 'undefined' ? sampleRate : 16000;
  const SR = 16000;
  const WINDOW_SAMPLES = SR * 2; // 2 second classification window
  const ROLLING_SECONDS = 30;
  const ROLLING_SAMPLES = SR * ROLLING_SECONDS;
  const NUM_MEL = 128;
  const TIME_STEPS = 64;
  const FFT_SIZE = 512;
  const HOP = 256;

  class SleepAudioProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.threshold = 0.01;
      this.window = new Float32Array(WINDOW_SAMPLES);
      this.windowFill = 0;

      // circular rolling buffer of resampled (16 kHz) audio
      this.rolling = new Float32Array(ROLLING_SAMPLES);
      this.rollingWrite = 0;
      this.totalSamples = 0; // total 16 kHz samples ever written

      this.melFb = buildMelFilterbank(NUM_MEL, FFT_SIZE, SR);

      // A-weighted level metering at the native rate
      this.meter = createLevelMeter(NATIVE_SR);
      this._aSum = 0; // A-weighted energy over the current window
      this._aN = 0;
      this._aFastMax = 0; // loudest Fast-weighted level in the current window
      this._meterFastMax = 0; // ... since the last meter post

      this.frameCounter = 0;

      // linear resampler state
      this._rsRatio = NATIVE_SR / SR;
      this._rsPhase = 0;

      this.port.onmessage = (e) => this._onMessage(e.data || {});
    }

    _resample(chan) {
      if (NATIVE_SR === SR) return chan;
      const ratio = this._rsRatio;
      const out = new Float32Array(Math.ceil(chan.length / ratio) + 2);
      let n = 0;
      let pos = this._rsPhase < 0 ? 0 : this._rsPhase;
      for (; pos < chan.length - 1; pos += ratio) {
        const i0 = pos | 0;
        const frac = pos - i0;
        out[n++] = chan[i0] * (1 - frac) + chan[i0 + 1] * frac;
      }
      this._rsPhase = pos - chan.length;
      return out.subarray(0, n);
    }

    _onMessage(msg) {
      if (msg.command === 'set-threshold' && typeof msg.value === 'number') {
        this.threshold = Math.max(0, msg.value);
      } else if (msg.command === 'extract-clip') {
        this._extractClip(msg.startTime, msg.endTime);
      }
    }

    _writeRolling(frame) {
      for (let i = 0; i < frame.length; i++) {
        this.rolling[this.rollingWrite] = frame[i];
        this.rollingWrite = (this.rollingWrite + 1) % ROLLING_SAMPLES;
      }
      this.totalSamples += frame.length;
    }

    _extractClip(startTime, endTime) {
      const now = currentTime;
      const bufferStartTime = now - Math.min(this.totalSamples, ROLLING_SAMPLES) / SR;
      const s = Math.max(startTime, bufferStartTime);
      const e = Math.min(endTime, now);
      if (e <= s) {
        this.port.postMessage({ type: 'audio-clip', buffer: new Float32Array(0), startTime, endTime });
        return;
      }
      const count = Math.round((e - s) * SR);
      const out = new Float32Array(count);
      // sample index (absolute) of the oldest sample currently in the buffer
      const oldestAbs = Math.max(0, this.totalSamples - ROLLING_SAMPLES);
      const startAbs = Math.round((s - bufferStartTime) * SR) + oldestAbs;
      for (let i = 0; i < count; i++) {
        const abs = startAbs + i;
        if (abs < oldestAbs || abs >= this.totalSamples) {
          out[i] = 0;
          continue;
        }
        const idx = abs % ROLLING_SAMPLES;
        out[i] = this.rolling[idx];
      }
      this.port.postMessage(
        { type: 'audio-clip', buffer: out, startTime: s, endTime: e },
        [out.buffer]
      );
    }

    _processWindow() {
      const energy = rms(this.window);
      const peak = peakAbs(this.window);
      const active = maxFrameRms(this.window);
      const quiet = quietFrameRms(this.window);
      const zc = zcr(this.window);
      const timestamp = currentTime;
      // A-weighted equivalent level (LAeq) and Fast max (LAFmax) as RMS values
      const laeq = this._aN ? Math.sqrt(this._aSum / this._aN) : 0;
      const lafMax = Math.sqrt(this._aFastMax);
      this._aSum = 0;
      this._aN = 0;
      this._aFastMax = 0;
      if (active < this.threshold) {
        this.port.postMessage({ type: 'silence', timestamp, rms: energy, activeRms: active, quietRms: quiet, peak, zcr: zc, laeq, lafMax });
      } else {
        const spec = melSpectrogram(this.window, {
          fftSize: FFT_SIZE,
          hop: HOP,
          numMel: NUM_MEL,
          timeSteps: TIME_STEPS,
          sampleRate: SR,
          melFb: this.melFb,
        });
        this.port.postMessage(
          { type: 'spectrogram', data: spec, timestamp, rms: energy, activeRms: active, quietRms: quiet, peak, zcr: zc, laeq, lafMax },
          [spec.buffer]
        );
      }
      this.windowFill = 0;
    }

    process(inputs) {
      const input = inputs[0];
      if (!input || input.length === 0 || !input[0]) return true;
      const lv = this.meter.process(input[0]);
      this._aSum += lv.sumSq;
      this._aN += lv.n;
      if (lv.fastMaxSq > this._aFastMax) this._aFastMax = lv.fastMaxSq;
      if (lv.fastMaxSq > this._meterFastMax) this._meterFastMax = lv.fastMaxSq;
      const chan = this._resample(input[0]);
      if (chan.length === 0) return true;

      this._writeRolling(chan);

      // per-frame level for the live meter (~62 Hz, every other render quantum)
      this.frameCounter++;
      if (this.frameCounter % 2 === 0) {
        const r = rms(chan);
        this.port.postMessage({
          type: 'energy',
          rms: r,
          peak: peakAbs(chan),
          laf: Math.sqrt(lv.fastSq), // A-weighted, Fast time-weighted (RMS)
          lafMax: Math.sqrt(this._meterFastMax),
        });
        this._meterFastMax = 0;
      }

      // accumulate into the 2s window
      let offset = 0;
      while (offset < chan.length) {
        const space = WINDOW_SAMPLES - this.windowFill;
        const take = Math.min(space, chan.length - offset);
        this.window.set(chan.subarray(offset, offset + take), this.windowFill);
        this.windowFill += take;
        offset += take;
        if (this.windowFill >= WINDOW_SAMPLES) this._processWindow();
      }
      return true;
    }
  }

  registerProcessor('sleep-audio-processor', SleepAudioProcessor);
}

// ---------------------------------------------------------------------------
// Node test hook (inert in the browser: `module` is undefined there)
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    hannWindow,
    fftRadix2,
    hzToMel,
    melToHz,
    buildMelFilterbank,
    melSpectrogram,
    rms,
    peakAbs,
    maxFrameRms,
    quietFrameRms,
    aWeightingSections,
    createLevelMeter,
    zcr,
  };
}
