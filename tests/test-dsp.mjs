// DSP math in the audio worklet: FFT, mel filterbank, mel spectrogram, RMS.
import { section, ok, eq, approx, pass } from './lib.mjs';
import { dsp } from './load-worklet.mjs';

export function run() {
  section('audio-worklet-processor.js — DSP');

  // --- FFT: delta -> flat spectrum ---
  {
    const N = 64;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    re[0] = 1;
    dsp.fftRadix2(re, im);
    let flat = true;
    for (let k = 0; k < N; k++) {
      if (Math.abs(re[k] - 1) > 1e-4 || Math.abs(im[k]) > 1e-4) flat = false;
    }
    ok(flat, 'FFT of unit impulse is a flat unit spectrum');
  }

  // --- FFT: single bin sinusoid -> energy concentrated at that bin ---
  {
    const N = 512;
    const bin = 8;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / N);
    dsp.fftRadix2(re, im);
    const mag = (k) => Math.hypot(re[k], im[k]);
    const peak = mag(bin);
    let others = 0;
    for (let k = 1; k < N / 2; k++) if (k !== bin) others = Math.max(others, mag(k));
    ok(peak > 100 && peak > others * 50, 'FFT concentrates a pure tone at its bin');
  }

  // --- mel scale monotonic + anchored ---
  {
    approx(dsp.hzToMel(0), 0, 1e-6, 'hzToMel(0) == 0');
    ok(dsp.hzToMel(1000) < dsp.hzToMel(2000), 'mel scale is monotonic');
    approx(dsp.melToHz(dsp.hzToMel(440)), 440, 1e-3, 'melToHz inverts hzToMel');
  }

  // --- mel filterbank shape ---
  {
    const fb = dsp.buildMelFilterbank(128, 512, 16000);
    eq(fb.length, 128, 'filterbank has 128 mel rows');
    eq(fb[0].length, 257, 'each row spans 257 fft bins');
    // low mel band should weight low fft bins; high band should weight high bins
    const lowCentroid = weightedBin(fb[5]);
    const highCentroid = weightedBin(fb[120]);
    ok(lowCentroid < highCentroid, 'higher mel bands map to higher fft bins');
  }

  // --- mel spectrogram output contract ---
  {
    const sr = 16000;
    const samples = new Float32Array(sr * 2);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 100 * i) / sr);
    const spec = dsp.melSpectrogram(samples, {
      fftSize: 512,
      hop: 256,
      numMel: 128,
      timeSteps: 64,
      sampleRate: sr,
    });
    eq(spec.length, 128 * 64, 'spectrogram length = 128 mel * 64 steps');
    let min = Infinity;
    let max = -Infinity;
    for (const v of spec) {
      if (Number.isNaN(v)) throw new Error('NaN in spectrogram');
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    ok(min >= 0 && max <= 1, `spectrogram normalised to [0,1] (got ${min.toFixed(3)}..${max.toFixed(3)})`);
    approx(max, 1, 1e-6, 'spectrogram max is 1 after normalisation');

    // a 100 Hz tone -> energy in the lowest mel bands
    const lowEnergy = bandEnergy(spec, 64, 0, 20);
    const hiEnergy = bandEnergy(spec, 64, 80, 128);
    ok(lowEnergy > hiEnergy * 2, '100 Hz tone lands in low mel bands');
  }

  // --- RMS ---
  {
    const buf = new Float32Array(1000).fill(0.5);
    approx(dsp.rms(buf), 0.5, 1e-6, 'RMS of constant 0.5 is 0.5');
    approx(dsp.rms(new Float32Array(1000)), 0, 1e-9, 'RMS of silence is 0');
  }

  pass('DSP module behaves correctly');
}

function weightedBin(row) {
  let num = 0;
  let den = 0;
  for (let k = 0; k < row.length; k++) {
    num += k * row[k];
    den += row[k];
  }
  return den ? num / den : 0;
}

function bandEnergy(spec, T, mLo, mHi) {
  let acc = 0;
  for (let m = mLo; m < mHi; m++) for (let t = 0; t < T; t++) acc += spec[m * T + t];
  return acc;
}
