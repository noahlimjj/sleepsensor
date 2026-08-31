// Minimal WAV reader -> mono Float32Array. Handles PCM 8/16/24/32-bit and
// 32-bit float, any channel count (downmixed to mono). Node only.
import { readFileSync } from 'fs';

export function readWavMono(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a WAV file: ${path}`);
  }
  let pos = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLen = Math.min(size, buf.length - body);
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || dataOffset < 0) throw new Error(`missing fmt/data chunk: ${path}`);

  const { channels, bitsPerSample, audioFormat, sampleRate } = fmt;
  const bytes = bitsPerSample / 8;
  const frames = Math.floor(dataLen / (bytes * channels));
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = dataOffset + (i * channels + c) * bytes;
      let v;
      if (audioFormat === 3 && bitsPerSample === 32) v = buf.readFloatLE(o);
      else if (bitsPerSample === 16) v = buf.readInt16LE(o) / 32768;
      else if (bitsPerSample === 32) v = buf.readInt32LE(o) / 2147483648;
      else if (bitsPerSample === 24) {
        const b0 = buf[o];
        const b1 = buf[o + 1];
        const b2 = buf[o + 2];
        let x = b0 | (b1 << 8) | (b2 << 16);
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else if (bitsPerSample === 8) v = (buf[o] - 128) / 128;
      else throw new Error(`unsupported bit depth ${bitsPerSample}: ${path}`);
      acc += v;
    }
    out[i] = acc / channels;
  }
  return { samples: out, sampleRate };
}

// naive linear resampler (only used if a file isn't already 16 kHz)
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  const n = Math.round(samples.length * ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}
