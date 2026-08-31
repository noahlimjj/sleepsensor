// WAV encoder + sensitivity mapping in audio-engine.js
import { section, ok, eq, approx, pass } from './lib.mjs';
import { float32ToWav, sensitivityToThreshold } from '../js/audio-engine.js';

export async function run() {
  section('audio-engine.js — WAV encoding & sensitivity');

  const sr = 16000;
  const samples = new Float32Array(sr); // 1 second
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / sr);

  const blob = float32ToWav(samples, sr);
  eq(blob.type, 'audio/wav', 'blob has audio/wav mime type');
  eq(blob.size, 44 + sr * 2, 'blob size = 44-byte header + 16-bit PCM data');

  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer);
  eq(String.fromCharCode(...buf.slice(0, 4)), 'RIFF', 'RIFF magic');
  eq(String.fromCharCode(...buf.slice(8, 12)), 'WAVE', 'WAVE magic');
  eq(String.fromCharCode(...buf.slice(12, 16)), 'fmt ', 'fmt chunk');
  eq(view.getUint16(20, true), 1, 'PCM format tag');
  eq(view.getUint16(22, true), 1, 'mono');
  eq(view.getUint32(24, true), sr, 'sample rate in header');
  eq(view.getUint16(34, true), 16, 'bits per sample');
  eq(String.fromCharCode(...buf.slice(36, 40)), 'data', 'data chunk');
  eq(view.getUint32(40, true), sr * 2, 'data chunk size');

  // clipping guard
  const hot = float32ToWav(new Float32Array([2, -2, 0]), sr);
  const hv = new DataView(await hot.arrayBuffer());
  eq(hv.getInt16(44, true), 32767, '+2.0 clamps to full-scale positive');
  eq(hv.getInt16(46, true), -32768, '-2.0 clamps to full-scale negative');

  // sensitivity -> threshold: higher sensitivity = lower gate, monotonic
  const lo = sensitivityToThreshold(0);
  const mid = sensitivityToThreshold(0.5);
  const hi = sensitivityToThreshold(1);
  ok(lo > mid && mid > hi, 'threshold decreases as sensitivity increases');
  approx(hi, 0.001, 0.002, 'max sensitivity -> ~0.001 gate');
  ok(lo <= 0.06, 'min sensitivity gate stays reasonable');

  pass('WAV encoder and sensitivity mapping behave correctly');
}
