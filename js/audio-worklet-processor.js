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
  const SR = typeof sampleRate !== 'undefined' ? sampleRate : 16000;
  const WINDOW_SAMPLES = Math.round(SR * 2); // 2 second classification window
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

      // circular rolling buffer of raw audio
      this.rolling = new Float32Array(ROLLING_SAMPLES);
      this.rollingWrite = 0;
      this.totalSamples = 0; // total samples ever written

      this.melFb = buildMelFilterbank(NUM_MEL, FFT_SIZE, SR);

      this.frameCounter = 0;

      this.port.onmessage = (e) => this._onMessage(e.data || {});
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
      const zc = zcr(this.window);
      const timestamp = currentTime;
      if (energy < this.threshold) {
        this.port.postMessage({ type: 'silence', timestamp, rms: energy, peak, zcr: zc });
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
          { type: 'spectrogram', data: spec, timestamp, rms: energy, peak, zcr: zc },
          [spec.buffer]
        );
      }
      this.windowFill = 0;
    }

    process(inputs) {
      const input = inputs[0];
      if (!input || input.length === 0 || !input[0]) return true;
      const chan = input[0];

      this._writeRolling(chan);

      // per-frame RMS for live visualisation (~62 Hz, every other render quantum)
      this.frameCounter++;
      if (this.frameCounter % 2 === 0) {
        this.port.postMessage({ type: 'energy', rms: rms(chan) });
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
    zcr,
  };
}
