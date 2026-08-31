/*
 * audio-engine.js — SleepSensor
 *
 * Owns the microphone → AudioWorklet → Classifier → Storage pipeline for a
 * night of monitoring. The frontend constructs one AudioEngine, wires up three
 * callbacks, and calls start()/stop().
 *
 *   const engine = new AudioEngine({
 *     classifier, storage,
 *     onEnergy:       (rms) => {},
 *     onEvent:        (event) => {},
 *     onStatusChange: (status, error) => {},
 *   });
 *
 * All audio stays on the device. Only short WAV clips around flagged events are
 * persisted (in IndexedDB); the full night is never recorded.
 */

import { WakeLock } from './wake-lock.js';
import { Classifier } from './classifier.js';

const TARGET_SAMPLE_RATE = 16000;
const POSITIVE_TYPES = new Set(['snoring', 'bruxism']);

// debounce tuning
const CONFIRM_COUNT = 3; // consecutive positives to confirm an event
const CONFIRM_WINDOW_MS = 6000; // positives must be within this gap
const END_NEGATIVE_STREAK = 2; // consecutive negatives that end an event
const CLIP_PAD_SEC = 5; // seconds of audio kept either side of an event
const WINDOW_SEC = 2; // classification window length

export class AudioEngine {
  constructor({ classifier, storage, onEnergy, onEvent, onStatusChange } = {}) {
    this.storage = storage || null;
    this.classifier = classifier || null;
    this.onEnergy = onEnergy || (() => {});
    this.onEvent = onEvent || (() => {});
    this.onStatusChange = onStatusChange || (() => {});

    this.wakeLock = new WakeLock();

    this.status = 'idle';
    this._recording = false;

    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.sinkNode = null;

    this.session = null;
    this.startWallTime = 0;
    this.ctxStartTime = 0;

    this.sensitivity = 0.5;
    this.noiseGate = sensitivityToThreshold(0.5);

    // debounce state
    this._pending = null;
    this._negativeStreak = 0;
    this._clipQueue = []; // FIFO of { eventId } awaiting worklet audio-clip replies

    // running session tallies
    this._tally = {
      snoringEpisodes: 0,
      bruxismEpisodes: 0,
      snoringDuration: 0,
      bruxismDuration: 0,
    };

    this._onWorkletMessage = this._onWorkletMessage.bind(this);
  }

  // ---- public API -----------------------------------------------------
  isRecording() {
    return this._recording;
  }

  getElapsedTime() {
    if (!this._recording || !this.startWallTime) return 0;
    return (Date.now() - this.startWallTime) / 1000;
  }

  setSensitivity(v) {
    this.sensitivity = clamp01(v);
    this.noiseGate = sensitivityToThreshold(this.sensitivity);
    if (this.workletNode) {
      this.workletNode.port.postMessage({ command: 'set-threshold', value: this.noiseGate });
    }
    if (this.storage) this.storage.setSetting('sensitivity', this.sensitivity).catch(() => {});
    return this.noiseGate;
  }

  async start() {
    if (this._recording) return this.session;
    this._setStatus('requesting');
    try {
      if (!this.classifier) {
        this.classifier = new Classifier();
      }
      if (!this.classifier.ready) await this.classifier.load();

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: TARGET_SAMPLE_RATE,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new Ctx({ sampleRate: TARGET_SAMPLE_RATE });
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();

      const workletUrl = new URL('./audio-worklet-processor.js', import.meta.url);
      await this.audioContext.audioWorklet.addModule(workletUrl);

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'sleep-audio-processor');
      this.workletNode.port.onmessage = this._onWorkletMessage;

      // keep the graph pulling audio without echoing anything to the speakers
      this.sinkNode = this.audioContext.createGain();
      this.sinkNode.gain.value = 0;
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.sinkNode);
      this.sinkNode.connect(this.audioContext.destination);

      this.workletNode.port.postMessage({ command: 'set-threshold', value: this.noiseGate });

      // timing reference: map worklet currentTime (seconds) <-> wall clock (ms)
      this.startWallTime = Date.now();
      this.ctxStartTime = this.audioContext.currentTime;

      // persist a session row
      if (this.storage) {
        this.session = await this.storage.createSession({ startTime: this.startWallTime });
      } else {
        this.session = { id: cryptoId(), startTime: this.startWallTime, endTime: null };
      }

      // reset per-session state
      this._pending = null;
      this._negativeStreak = 0;
      this._clipQueue = [];
      this._tally = {
        snoringEpisodes: 0,
        bruxismEpisodes: 0,
        snoringDuration: 0,
        bruxismDuration: 0,
      };

      await this.wakeLock.acquire();

      this._recording = true;
      this._setStatus('recording');
      return this.session;
    } catch (err) {
      await this._teardownAudio();
      this._setStatus('error', err && err.message ? err.message : String(err));
      throw err;
    }
  }

  async stop() {
    if (!this._recording) return null;
    this._recording = false;

    // finalise any event still in progress
    await this._finalizePending();

    // give the worklet a moment to answer outstanding clip requests
    if (this._clipQueue.length) await delay(400);

    await this.wakeLock.release();
    await this._teardownAudio();

    const endTime = Date.now();
    const startTime = this.session ? this.session.startTime : this.startWallTime;
    const totalDuration = Math.max(0, (endTime - startTime) / 1000);
    const summaryPatch = {
      endTime,
      totalDuration,
      snoringDuration: round1(this._tally.snoringDuration),
      bruxismDuration: round1(this._tally.bruxismDuration),
      snoringEpisodes: this._tally.snoringEpisodes,
      bruxismEpisodes: this._tally.bruxismEpisodes,
      snoringPercentage: totalDuration ? round1((this._tally.snoringDuration / totalDuration) * 100) : 0,
      bruxismPercentage: totalDuration ? round1((this._tally.bruxismDuration / totalDuration) * 100) : 0,
    };

    let clips = [];
    if (this.storage && this.session) {
      await this.storage.updateSession(this.session.id, summaryPatch).catch((e) =>
        console.warn('[AudioEngine] updateSession failed:', e)
      );
      clips = await this.storage.getClipsBySession(this.session.id).catch(() => []);
    }

    this._setStatus('idle');

    const summary = {
      sessionId: this.session ? this.session.id : null,
      startTime,
      ...summaryPatch,
      clips,
    };
    this.session = null;
    return summary;
  }

  // ---- worklet message handling -------------------------------------
  _onWorkletMessage(e) {
    const msg = e.data;
    if (!msg) return;
    switch (msg.type) {
      case 'energy':
        this.onEnergy(msg.rms);
        break;
      case 'silence':
        this._handleClassification({ type: 'silence', confidence: 0 }, msg.timestamp);
        break;
      case 'spectrogram': {
        let result;
        try {
          result = this.classifier.classify(msg.data, { rms: msg.rms });
        } catch (err) {
          console.warn('[AudioEngine] classify failed:', err);
          result = { type: 'other', confidence: 0 };
        }
        this._handleClassification(result, msg.timestamp);
        break;
      }
      case 'audio-clip':
        this._handleClip(msg);
        break;
      default:
        break;
    }
  }

  // debounce / event lifecycle. `ctxTime` is worklet currentTime in seconds.
  _handleClassification(result, ctxTime) {
    const wall = this._ctxToWall(ctxTime);
    const isPositive =
      POSITIVE_TYPES.has(result.type) && result.confidence >= (this.classifier?.minConfidence ?? 0.35);

    if (isPositive) {
      const type = result.type;
      if (this._pending && this._pending.type === type && wall - this._pending.lastWall <= CONFIRM_WINDOW_MS) {
        this._pending.count += 1;
        this._pending.lastWall = wall;
        this._pending.lastCtx = ctxTime;
        this._pending.confidences.push(result.confidence);
        this._negativeStreak = 0;
      } else {
        // different type, or gap too large — close the old one, open a new one
        this._finalizePending();
        this._pending = {
          type,
          count: 1,
          startWall: wall - WINDOW_SEC * 1000, // window covers the preceding 2s
          startCtx: ctxTime - WINDOW_SEC,
          lastWall: wall,
          lastCtx: ctxTime,
          confidences: [result.confidence],
          emitted: false,
          eventId: null,
        };
        this._negativeStreak = 0;
      }

      if (this._pending.count >= CONFIRM_COUNT && !this._pending.emitted) {
        this._confirmPending();
      } else if (this._pending.emitted) {
        this._growPending();
      }
    } else {
      // negative (silence / other)
      if (this._pending) {
        this._negativeStreak += 1;
        if (this._negativeStreak >= END_NEGATIVE_STREAK) {
          this._finalizePending();
        }
      }
    }
  }

  _confirmPending() {
    const p = this._pending;
    p.emitted = true;
    p.eventId = cryptoId();
    const confidence = avg(p.confidences);
    const severity = Classifier.severityFor(confidence);
    const duration = Math.max(WINDOW_SEC, (p.lastWall - p.startWall) / 1000);

    const eventRecord = {
      id: p.eventId,
      sessionId: this.session ? this.session.id : null,
      type: p.type,
      startTime: Math.round(p.startWall),
      endTime: Math.round(p.lastWall),
      duration: round1(duration),
      confidence: round3(confidence),
      severity,
      timestamp: Math.round(p.startWall),
      hasClip: false,
    };

    if (this.storage) this.storage.addEvent(eventRecord).catch((e) => console.warn('[AudioEngine] addEvent:', e));

    if (p.type === 'snoring') this._tally.snoringEpisodes += 1;
    else this._tally.bruxismEpisodes += 1;

    this.onEvent({
      type: p.type,
      confidence: round3(confidence),
      severity,
      timestamp: Math.round(p.startWall),
      duration: round1(duration),
      eventId: p.eventId,
    });
  }

  _growPending() {
    const p = this._pending;
    if (!p.emitted || !this.storage) return;
    const duration = Math.max(WINDOW_SEC, (p.lastWall - p.startWall) / 1000);
    const confidence = avg(p.confidences);
    this.storage
      .updateEvent(p.eventId, {
        endTime: Math.round(p.lastWall),
        duration: round1(duration),
        confidence: round3(confidence),
        severity: Classifier.severityFor(confidence),
      })
      .catch(() => {});
  }

  async _finalizePending() {
    const p = this._pending;
    this._pending = null;
    this._negativeStreak = 0;
    if (!p || !p.emitted) return;

    const durationSec = Math.max(WINDOW_SEC, (p.lastWall - p.startWall) / 1000);
    if (p.type === 'snoring') this._tally.snoringDuration += durationSec;
    else this._tally.bruxismDuration += durationSec;

    // request the surrounding audio from the worklet's rolling buffer
    if (this.workletNode) {
      const startCtx = p.startCtx - CLIP_PAD_SEC;
      const endCtx = p.lastCtx + CLIP_PAD_SEC;
      this._clipQueue.push({ eventId: p.eventId, sessionId: this.session ? this.session.id : null });
      this.workletNode.port.postMessage({
        command: 'extract-clip',
        startTime: startCtx,
        endTime: endCtx,
      });
    }
  }

  async _handleClip(msg) {
    const pending = this._clipQueue.shift();
    if (!pending || !msg.buffer || msg.buffer.length === 0) return;
    const sampleRate = this.audioContext ? this.audioContext.sampleRate : TARGET_SAMPLE_RATE;
    const blob = float32ToWav(msg.buffer, sampleRate);
    const duration = msg.buffer.length / sampleRate;
    if (!this.storage) return;
    try {
      await this.storage.saveClip({
        eventId: pending.eventId,
        sessionId: pending.sessionId,
        audioBlob: blob,
        duration: round1(duration),
        format: 'wav',
        timestamp: Date.now(),
      });
      await this.storage.updateEvent(pending.eventId, { hasClip: true }).catch(() => {});
    } catch (e) {
      console.warn('[AudioEngine] saveClip failed:', e);
    }
  }

  // ---- helpers -----------------------------------------------------
  _ctxToWall(ctxTime) {
    if (typeof ctxTime !== 'number') return Date.now();
    return this.startWallTime + (ctxTime - this.ctxStartTime) * 1000;
  }

  _setStatus(status, error) {
    this.status = status;
    try {
      this.onStatusChange(status, error);
    } catch (e) {
      console.warn('[AudioEngine] onStatusChange threw:', e);
    }
  }

  async _teardownAudio() {
    try {
      if (this.workletNode) {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      }
      if (this.sourceNode) this.sourceNode.disconnect();
      if (this.sinkNode) this.sinkNode.disconnect();
      if (this.mediaStream) this.mediaStream.getTracks().forEach((t) => t.stop());
      if (this.audioContext && this.audioContext.state !== 'closed') await this.audioContext.close();
    } catch (e) {
      console.warn('[AudioEngine] teardown warning:', e);
    }
    this.workletNode = null;
    this.sourceNode = null;
    this.sinkNode = null;
    this.mediaStream = null;
    this.audioContext = null;
  }
}

// ---------------------------------------------------------------------------
// WAV encoding — 16-bit PCM mono
// ---------------------------------------------------------------------------
export function float32ToWav(samples, sampleRate = 16000) {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = 1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function avg(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
function round1(x) {
  return Math.round(x * 10) / 10;
}
function round3(x) {
  return Math.round(x * 1000) / 1000;
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function cryptoId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Map a 0–1 sensitivity slider to a noise-gate RMS threshold.
 * Higher sensitivity => lower gate => quieter sounds get classified.
 * 0.0 -> ~0.05, 0.5 -> ~0.01, 1.0 -> ~0.001
 */
export function sensitivityToThreshold(v) {
  const s = clamp01(v);
  return 0.001 + (0.05 - 0.001) * Math.pow(1 - s, 2);
}

export default AudioEngine;
