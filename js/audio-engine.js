/*
 * audio-engine.js — SleepSensor
 *
 * Owns the microphone → AudioWorklet → Classifier → Storage pipeline for a
 * night of monitoring. The frontend constructs one AudioEngine, wires up the
 * callbacks, and calls start()/stop().
 *
 *   const engine = new AudioEngine({
 *     classifier, storage,
 *     onEnergy:       (rms) => {},
 *     onEvent:        (event) => {},   // { type:'snoring'|'bruxism'|'noise', ... }
 *     onStatusChange: (status, info) => {},
 *   });
 *
 * All audio stays on the device. Only short WAV clips around flagged events and
 * around the loudest moments of the night are persisted (IndexedDB); the full
 * night is never recorded.
 */

import { WakeLock } from './wake-lock.js';
import { Classifier } from './classifier.js';
import { HmmSmoother } from './smoothing.js';
import { nativeBridge } from './native-bridge.js';

const SMOOTH_CLASSES = ['quiet', 'snoring', 'bruxism', 'noise'];

// safety: never record forever if the user forgets to stop
const MAX_SESSION_MS = 14 * 60 * 60 * 1000;
// how often to persist the open session so a crash loses minutes, not the night
const CHECKPOINT_MS = 60 * 1000;

const TARGET_SAMPLE_RATE = 16000;
const POSITIVE_TYPES = new Set(['snoring', 'bruxism', 'noise']);

// event debounce tuning. HMM smoothing (smoothing.js) already removes
// single-window flicker, so the debounce only needs to enforce a minimum
// event duration and a clean tail.
const CONFIRM_COUNT = 2; // consecutive smoothed positives to confirm an event
const CONFIRM_WINDOW_MS = 6000; // positives must be within this gap
const END_NEGATIVE_STREAK = 2; // consecutive negatives that end an event
const CLIP_PAD_SEC = 5; // seconds of audio kept either side of an event
const WINDOW_SEC = 2; // classification window length

// "loud sound" fallback: a window that is clearly above the ambient floor but
// the classifier does not call snoring/bruxism is still logged as a generic
// noise event (coughing, talking — even softly, a door, a baby, traffic …).
const LOUD_NOISE_RMS = 0.012; // ~ -38 dBFS, roughly soft speech at bedside

// loudest-moment highlights — capture the loudest sounds of the night by peak
// amplitude, whatever they are (a shout, a bang, a dog, a snore). A window
// qualifies on peak OR average level, so brief transients are not missed.
const MAX_HIGHLIGHTS = 12;
const HIGHLIGHT_MIN_PEAK = 0.05; // ~ -26 dBFS instantaneous — clearly audible
const HIGHLIGHT_MIN_RMS = 0.012; // ~ -38 dBFS sustained
const HIGHLIGHT_MIN_GAP_MS = 20000; // collapse repeats of the same loud bout
const HIGHLIGHT_PAD_SEC = 3;

// background-resilience watchdog
const STALL_TIMEOUT_MS = 9000; // no worklet audio for this long => try to recover

export class AudioEngine {
  constructor({ classifier, storage, onEnergy, onEvent, onStatusChange } = {}) {
    this.storage = storage || null;
    this.classifier = classifier || null;
    this.onEnergy = onEnergy || (() => {});
    this.onEvent = onEvent || (() => {});
    this.onStatusChange = onStatusChange || (() => {});

    this.wakeLock = new WakeLock();
    this._smoother = new HmmSmoother({ classes: SMOOTH_CLASSES });

    this.status = 'idle';
    this._recording = false;

    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.sinkNode = null;
    this.keepAlive = null;

    this.session = null;
    this.startWallTime = 0;
    this.ctxStartTime = 0;

    this.sensitivity = 0.5;
    this.noiseGate = sensitivityToThreshold(0.5);

    // debounce state
    this._pending = null;
    this._negativeStreak = 0;
    this._clipQueue = []; // FIFO matching worklet 'audio-clip' replies -> { kind, id, sessionId }

    // loudest-moment highlights (kept sorted, loudest first)
    this._highlights = [];

    // running session tallies
    this._tally = freshTally();

    // background resilience
    this._lastAudioAt = 0;
    this._watchdog = null;
    this._checkpointTimer = null;
    this._suspendedSince = 0;
    this._interrupted = false;
    this.native = nativeBridge;
    this._onVisibility = this._handleVisibility.bind(this);
    this._onCtxStateChange = this._handleCtxStateChange.bind(this);
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

  /**
   * Current input level for a live meter.
   *   dbFS  — decibels relative to full scale (0 = clipping, quiet ≈ -60)
   *   spl   — rough estimate of room loudness in dB SPL (uncalibrated, ±10 dB)
   */
  getLevel() {
    const rms = this._lastRms || 0;
    const peak = this._lastPeak || rms;
    return {
      rms,
      peak,
      dbFS: round1(dbFS(rms)),
      peakDbFS: round1(dbFS(peak)),
      spl: Math.round(clampNum(dbFS(rms) + SPL_REFERENCE, 0, 130)),
    };
  }

  /** Plain-language description of a 0–1 sensitivity value, for the settings UI. */
  describeSensitivity(v = this.sensitivity) {
    const s = clamp01(v);
    const gate = sensitivityToThreshold(s);
    let label;
    let detail;
    if (s < 0.25) {
      label = 'Low';
      detail = 'Only clear, loud snoring or grinding is logged. Best for noisy rooms.';
    } else if (s < 0.55) {
      label = 'Medium';
      detail = 'Catches normal snoring and grinding; ignores faint background sounds.';
    } else if (s < 0.8) {
      label = 'High';
      detail = 'Picks up light snoring and soft speech. Good for a quiet bedroom.';
    } else {
      label = 'Maximum';
      detail = 'Registers almost any sound, including whispers. May log more noise.';
    }
    return { value: s, label, detail, thresholdDbFS: round1(dbFS(gate)) };
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

  /** Current OS-level microphone permission, when the browser exposes it. */
  async permissionState() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const s = await navigator.permissions.query({ name: 'microphone' });
        return s.state; // 'granted' | 'denied' | 'prompt'
      }
    } catch (_) {
      /* Safari throws for 'microphone' */
    }
    return 'unknown';
  }

  /** Honest, human-readable note about screen-off recording on this device. */
  backgroundGuidance() {
    // native (Capacitor) app: background recording actually works
    if (this.native && this.native.supported) {
      return {
        canRunScreenOff: true,
        text:
          'You can lock the screen — SleepSensor keeps recording in the background. ' +
          'Keep the phone on a charger for the night.',
      };
    }
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    const iOS = /iP(hone|ad|od)/.test(ua) || (/(Mac)/.test(ua) && navigator.maxTouchPoints > 1);
    if (iOS) {
      return {
        canRunScreenOff: false,
        text:
          'In a browser, iPhone pauses audio when the screen locks. Keep SleepSensor ' +
          'open with the screen on (it will dim) and the phone on a charger — or ' +
          'install the app for true background recording.',
      };
    }
    return {
      canRunScreenOff: false,
      text:
        'In a browser, keep SleepSensor open in the foreground with the phone on a ' +
        'charger. Locking the screen may pause capture. Install the app for true ' +
        'background recording.',
    };
  }

  async start() {
    if (this._recording) return this.session;
    this._setStatus('requesting');

    // 1. microphone FIRST — before any await that could break the user-gesture
    //    chain on iOS Safari (a common cause of a false "permission denied").
    let stream;
    try {
      stream = await openMicrophone();
    } catch (err) {
      const info = describeMicError(err);
      this._setStatus('error', info.message, info);
      const e = new Error(info.message);
      e.name = info.name;
      throw e;
    }
    this.mediaStream = stream;

    try {
      // 2. audio graph at the device's native rate (forcing 16 kHz throws on
      //    some iOS versions); the worklet reads the real rate at runtime.
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new Ctx();
      this.audioContext.addEventListener('statechange', this._onCtxStateChange);
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();

      const workletUrl = new URL('./audio-worklet-processor.js', import.meta.url);
      await this.audioContext.audioWorklet.addModule(workletUrl);

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'sleep-audio-processor');
      this.workletNode.port.onmessage = this._onWorkletMessage;

      // keep the render graph pulling audio without echoing to the speakers
      this.sinkNode = this.audioContext.createGain();
      this.sinkNode.gain.value = 0;
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.sinkNode);
      this.sinkNode.connect(this.audioContext.destination);

      // a silent looping source helps some browsers keep the audio thread warm
      this._startKeepAlive();

      this.workletNode.port.postMessage({ command: 'set-threshold', value: this.noiseGate });

      // 3. everything that can safely happen after we hold the mic
      if (!this.classifier) this.classifier = new Classifier();
      if (!this.classifier.ready) await this.classifier.load();

      this.startWallTime = Date.now();
      this.ctxStartTime = this.audioContext.currentTime;
      this._lastAudioAt = Date.now();

      if (this.storage) {
        this.session = await this.storage.createSession({ startTime: this.startWallTime });
      } else {
        this.session = { id: cryptoId(), startTime: this.startWallTime, endTime: null };
      }

      this._pending = null;
      this._negativeStreak = 0;
      this._clipQueue = [];
      this._highlights = [];
      this._tally = freshTally();
      this._suspendedSince = 0;
      this._interrupted = false;
      this._smoother.reset();

      await this.wakeLock.acquire();
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);
      this._startWatchdog();
      this._startCheckpoints();

      // native background-recording mode (Capacitor iOS/Android) — keeps the
      // audio graph alive while the screen is locked. No-op on the plain web.
      let nativeWarnings = [];
      try {
        const prep = await this.native.prepare();
        nativeWarnings = prep.warnings || [];
        await this.native.beginSession({ title: 'SleepSensor', text: 'Monitoring your sleep…' });
        this.native.on({
          onInterruptionBegan: () => this._onInterruption(true),
          onInterruptionEnded: () => this._onInterruption(false),
          onResume: () => this._handleVisibility(),
          onAppState: (s) => {
            if (s && s.isActive) this._handleVisibility();
          },
          onLowMemory: () => this._setStatus('recording', 'Device low on memory — recording continues.'),
        });
      } catch (e) {
        console.warn('[AudioEngine] native bridge:', e?.message || e);
      }

      this._recording = true;
      this._setStatus('recording', null, {
        native: this.native.supported,
        warnings: nativeWarnings,
      });
      return this.session;
    } catch (err) {
      await this._teardown();
      const msg = err && err.message ? err.message : String(err);
      this._setStatus('error', 'Could not start the audio engine: ' + msg, { name: err?.name });
      throw err;
    }
  }

  async stop(reason) {
    if (!this._recording) return null;
    this._recording = false;

    this._stopWatchdog();
    this._stopCheckpoints();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibility);

    await this._finalizePending();
    if (this._clipQueue.length) await delay(500); // let outstanding clips arrive

    await this.wakeLock.release();
    try {
      await this.native.endSession();
      await this.native.dispose();
    } catch (_) {
      /* non-fatal */
    }
    await this._teardown();

    const endTime = Date.now();
    const startTime = this.session ? this.session.startTime : this.startWallTime;
    const totalDuration = Math.max(0, (endTime - startTime) / 1000);
    const t = this._tally;
    const pct = (d) => (totalDuration ? round1((d / totalDuration) * 100) : 0);

    const summaryPatch = {
      endTime,
      totalDuration,
      snoringDuration: round1(t.snoringDuration),
      bruxismDuration: round1(t.bruxismDuration),
      noiseDuration: round1(t.noiseDuration),
      snoringEpisodes: t.snoringEpisodes,
      bruxismEpisodes: t.bruxismEpisodes,
      noiseEpisodes: t.noiseEpisodes,
      snoringPercentage: pct(t.snoringDuration),
      bruxismPercentage: pct(t.bruxismDuration),
      loudestDb: t.loudestDb === -Infinity ? null : round1(t.loudestDb),
    };

    let clips = [];
    let highlights = [];
    if (this.storage && this.session) {
      await this.storage
        .updateSession(this.session.id, summaryPatch)
        .catch((e) => console.warn('[AudioEngine] updateSession failed:', e));
      clips = await this.storage.getClipsBySession(this.session.id).catch(() => []);
      highlights = await this.storage.getHighlightsBySession(this.session.id).catch(() => []);
    }

    this._setStatus('idle', reason ? `Stopped: ${reason}` : null, { reason: reason || 'user' });
    const summary = {
      sessionId: this.session ? this.session.id : null,
      startTime,
      stopReason: reason || 'user',
      ...summaryPatch,
      clips,
      highlights,
    };
    this.session = null;
    return summary;
  }

  // ---- checkpointing (crash recovery) ----------------------------
  _startCheckpoints() {
    this._stopCheckpoints();
    this._checkpointTimer = setInterval(() => this._checkpoint(), CHECKPOINT_MS);
  }
  _stopCheckpoints() {
    if (this._checkpointTimer) clearInterval(this._checkpointTimer);
    this._checkpointTimer = null;
  }
  _checkpoint() {
    if (!this._recording) return;

    // safety auto-stop: never record past MAX_SESSION_MS
    if (Date.now() - this.startWallTime > MAX_SESSION_MS) {
      this.stop('max-duration').catch(() => {});
      return;
    }

    const t = this._tally;
    if (this.storage && this.session) {
      this.storage
        .updateSession(this.session.id, {
          lastCheckpoint: Date.now(),
          snoringDuration: round1(t.snoringDuration),
          bruxismDuration: round1(t.bruxismDuration),
          noiseDuration: round1(t.noiseDuration),
          snoringEpisodes: t.snoringEpisodes,
          bruxismEpisodes: t.bruxismEpisodes,
          noiseEpisodes: t.noiseEpisodes,
          loudestDb: t.loudestDb === -Infinity ? null : round1(t.loudestDb),
        })
        .catch((e) => {
          // storage full or unavailable mid-night — stop cleanly, keep what we have
          if (/quota|full|NotAllowed|Unknown/i.test(String(e && e.name))) {
            console.warn('[AudioEngine] storage error during checkpoint — stopping:', e);
            this.stop('storage-full').catch(() => {});
          }
        });
    }

    const mins = Math.round((Date.now() - this.startWallTime) / 60000);
    this.native
      .updateNotification(
        `${fmtDur(mins)} · ${t.snoringEpisodes} snoring · ${t.bruxismEpisodes} grinding · ${t.noiseEpisodes} other`
      )
      .catch(() => {});
  }

  _onInterruption(began) {
    if (!this._recording) return;
    if (began) {
      this._interrupted = true;
      this._setStatus('interrupted', 'Audio interrupted (call, alarm or another app) — will resume automatically.');
    } else {
      this._interrupted = false;
      if (this.audioContext && this.audioContext.state !== 'running') {
        this.audioContext.resume().catch(() => {});
      }
      this.native.beginSession({ title: 'SleepSensor', text: 'Monitoring your sleep…' }).catch(() => {});
      this.wakeLock.acquire().catch(() => {});
      this._lastAudioAt = Date.now();
      this._setStatus('recording', null, { resumedFromInterruption: true });
    }
  }

  // ---- worklet message handling -------------------------------------
  _onWorkletMessage(e) {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'energy') {
      this._lastRms = msg.rms;
      this._lastPeak = msg.peak ?? msg.rms;
      this.onEnergy(msg.rms, dbFS(msg.rms));
      return;
    }
    this._lastAudioAt = Date.now();

    switch (msg.type) {
      case 'silence': {
        const smoothed = this._smoother.push({ quiet: 1 });
        this._considerHighlight(msg, { type: 'silence', confidence: 0 });
        this._handleClassification(smoothed, msg);
        break;
      }
      case 'spectrogram': {
        let result;
        try {
          result = this.classifier.classify(msg.data, {
            rms: msg.rms,
            peak: msg.peak,
            zcr: msg.zcr,
          });
        } catch (err) {
          console.warn('[AudioEngine] classify failed:', err);
          result = { type: 'other', confidence: 0, scores: {} };
        }
        // temporal smoothing (HMM forward filter) -> stable event decisions
        const smoothed = this._smoother.push(result.scores || {});
        this._lastRaw = result;
        this._considerHighlight(msg, result); // highlights use the raw per-window label
        this._handleClassification(smoothed, msg);
        break;
      }
      case 'audio-clip':
        this._handleClip(msg);
        break;
      default:
        break;
    }
  }

  // Decide the effective label for a window: classifier verdict, or a generic
  // "noise" when it is simply above the ambient floor, or negative.
  _effectiveType(result, msg) {
    const min = this.classifier?.minConfidence ?? 0.35;
    // bruxism is the lower-precision class — hold it to a higher bar so a hissy
    // fan or distant traffic isn't logged as teeth grinding.
    if (result.type === 'snoring' && result.confidence >= min) {
      return { type: 'snoring', confidence: result.confidence };
    }
    if (result.type === 'bruxism' && result.confidence >= Math.max(min, 0.5)) {
      return { type: 'bruxism', confidence: result.confidence };
    }
    // a confident quiet/silence verdict wins even if the raw level looks loud
    if ((result.type === 'quiet' || result.type === 'silence') && result.confidence >= 0.6) {
      return null;
    }
    const loud = (msg.rms || 0) >= Math.max(LOUD_NOISE_RMS, this.noiseGate * 3);
    if (result.type === 'noise' && result.confidence >= 0.4 && loud) {
      return { type: 'noise', confidence: result.confidence };
    }
    if (loud) {
      return { type: 'noise', confidence: clamp01((msg.rms - LOUD_NOISE_RMS) * 12 + 0.4) };
    }
    return null;
  }

  _handleClassification(result, msg) {
    const ctxTime = typeof msg.timestamp === 'number' ? msg.timestamp : this._wallToCtx(Date.now());
    const wall = this._ctxToWall(ctxTime);
    const positive = this._effectiveType(result, msg);

    if (positive) {
      const { type, confidence } = positive;
      const peak = msg.peak ?? msg.rms ?? 0;
      if (
        this._pending &&
        this._pending.type === type &&
        wall - this._pending.lastWall <= CONFIRM_WINDOW_MS
      ) {
        this._pending.count += 1;
        this._pending.lastWall = wall;
        this._pending.lastCtx = ctxTime;
        this._pending.confidences.push(confidence);
        this._pending.peaks.push(peak);
        this._negativeStreak = 0;
      } else {
        this._finalizePending();
        this._pending = {
          type,
          count: 1,
          startWall: wall - WINDOW_SEC * 1000,
          startCtx: ctxTime - WINDOW_SEC,
          lastWall: wall,
          lastCtx: ctxTime,
          confidences: [confidence],
          peaks: [peak],
          emitted: false,
          eventId: null,
        };
        this._negativeStreak = 0;
      }

      if (this._pending.count >= CONFIRM_COUNT && !this._pending.emitted) this._confirmPending();
      else if (this._pending.emitted) this._growPending();
    } else if (this._pending) {
      this._negativeStreak += 1;
      if (this._negativeStreak >= END_NEGATIVE_STREAK) this._finalizePending();
    }
  }

  _confirmPending() {
    const p = this._pending;
    p.emitted = true;
    p.eventId = cryptoId();
    const confidence = avg(p.confidences);
    const severity = Classifier.severityFor(confidence);
    const duration = Math.max(WINDOW_SEC, (p.lastWall - p.startWall) / 1000);
    const peakDb = round1(dbFS(Math.max(...p.peaks)));
    const rec = {
      id: p.eventId,
      sessionId: this.session ? this.session.id : null,
      type: p.type,
      startTime: Math.round(p.startWall),
      endTime: Math.round(p.lastWall),
      duration: round1(duration),
      confidence: round3(confidence),
      severity,
      peakDb,
      timestamp: Math.round(p.startWall),
      hasClip: false,
    };
    if (this.storage) this.storage.addEvent(rec).catch((e) => console.warn('[AudioEngine] addEvent:', e));
    this._tally[p.type + 'Episodes'] += 1;

    this.onEvent({
      type: p.type,
      confidence: round3(confidence),
      severity,
      peakDb,
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
        peakDb: round1(dbFS(Math.max(...p.peaks))),
      })
      .catch(() => {});
  }

  _finalizePending() {
    const p = this._pending;
    this._pending = null;
    this._negativeStreak = 0;
    if (!p || !p.emitted) return;

    const durationSec = Math.max(WINDOW_SEC, (p.lastWall - p.startWall) / 1000);
    this._tally[p.type + 'Duration'] += durationSec;

    if (this.workletNode) {
      this._clipQueue.push({
        kind: 'event',
        id: p.eventId,
        sessionId: this.session ? this.session.id : null,
      });
      this.workletNode.port.postMessage({
        command: 'extract-clip',
        startTime: p.startCtx - CLIP_PAD_SEC,
        endTime: p.lastCtx + CLIP_PAD_SEC,
      });
    }
  }

  // ---- loudest-moment highlights ----------------------------------
  _considerHighlight(msg, result) {
    const peak = msg.peak ?? msg.rms ?? 0;
    const rms = msg.rms ?? 0;

    // always track the single loudest instant of the night, even sub-threshold
    const db = 20 * Math.log10(Math.max(peak, 1e-6));
    if (db > this._tally.loudestDb) this._tally.loudestDb = db;

    // qualify on a loud instantaneous peak OR a loud sustained level
    if (peak < HIGHLIGHT_MIN_PEAK && rms < HIGHLIGHT_MIN_RMS) return;

    const ctxTime = typeof msg.timestamp === 'number' ? msg.timestamp : this._wallToCtx(Date.now());
    const wall = this._ctxToWall(ctxTime);

    // label it by the classifier's verdict; "unknown" when it isn't sure —
    // the point is to keep the sound regardless of what it is
    let classifiedAs = 'unknown';
    if ((result.type === 'snoring' || result.type === 'bruxism') && (result.confidence || 0) >= 0.4) {
      classifiedAs = result.type;
    } else if (result.type === 'noise' && (result.confidence || 0) >= 0.5) {
      classifiedAs = 'noise';
    } else if (rms >= LOUD_NOISE_RMS) {
      classifiedAs = 'noise';
    }

    // collapse with a nearby existing highlight (same loud bout)
    const near = this._highlights.find((h) => Math.abs(h.wall - wall) < HIGHLIGHT_MIN_GAP_MS);
    if (near) {
      if (peak > near.peak) {
        near.peak = peak;
        near.rms = rms;
        near.db = db;
        near.wall = wall;
        near.ctxTime = ctxTime;
        near.classifiedAs = classifiedAs;
        near.confidence = result.confidence || 0;
        this._requestHighlightClip(near);
        this._persistHighlight(near);
      }
      return;
    }

    const full = this._highlights.length >= MAX_HIGHLIGHTS;
    const quietest = full ? this._highlights[this._highlights.length - 1] : null;
    if (full && peak <= quietest.peak) return;

    const h = {
      id: cryptoId(),
      sessionId: this.session ? this.session.id : null,
      wall,
      ctxTime,
      peak,
      rms,
      db,
      classifiedAs,
      confidence: result.confidence || 0,
      hasClip: false,
    };
    this._highlights.push(h);
    this._highlights.sort((a, b) => b.peak - a.peak);

    if (this._highlights.length > MAX_HIGHLIGHTS) {
      const evicted = this._highlights.pop();
      if (this.storage) this.storage.deleteHighlight(evicted.id).catch(() => {});
    }
    this._requestHighlightClip(h);
    this._persistHighlight(h);
  }

  _persistHighlight(h) {
    if (!this.storage) return;
    this.storage
      .saveHighlight({
        id: h.id,
        sessionId: h.sessionId,
        timestamp: Math.round(h.wall),
        peak: round3(h.peak),
        db: round1(h.db),
        rms: round3(h.rms),
        classifiedAs: h.classifiedAs,
        confidence: round3(h.confidence),
        hasClip: h.hasClip,
      })
      .catch((e) => console.warn('[AudioEngine] saveHighlight:', e));
  }

  _requestHighlightClip(h) {
    if (!this.workletNode) return;
    this._clipQueue.push({ kind: 'highlight', id: h.id, sessionId: h.sessionId });
    this.workletNode.port.postMessage({
      command: 'extract-clip',
      startTime: h.ctxTime - WINDOW_SEC - HIGHLIGHT_PAD_SEC,
      endTime: h.ctxTime + HIGHLIGHT_PAD_SEC,
    });
  }

  async _handleClip(msg) {
    const pending = this._clipQueue.shift();
    if (!pending || !msg.buffer || msg.buffer.length === 0 || !this.storage) return;
    // a highlight that was evicted (a louder one arrived) while its clip was in
    // flight — drop the clip rather than orphan it in storage
    if (pending.kind === 'highlight' && !this._highlights.some((h) => h.id === pending.id)) return;
    // the worklet resamples to a fixed 16 kHz internally, so clips are 16 kHz
    const blob = float32ToWav(msg.buffer, TARGET_SAMPLE_RATE);
    const duration = msg.buffer.length / TARGET_SAMPLE_RATE;
    try {
      await this.storage.saveClip({
        // clip id == parent id: re-requesting a clip (e.g. a highlight whose
        // peak grew) overwrites rather than piling up orphan rows
        id: pending.id,
        eventId: pending.id,
        sessionId: pending.sessionId,
        clipType: pending.kind,
        audioBlob: blob,
        duration: round1(duration),
        format: 'wav',
        timestamp: Date.now(),
      });
      if (pending.kind === 'event') {
        await this.storage.updateEvent(pending.id, { hasClip: true }).catch(() => {});
      } else {
        await this.storage.updateHighlight(pending.id, { hasClip: true }).catch(() => {});
        const h = this._highlights.find((x) => x.id === pending.id);
        if (h) h.hasClip = true;
      }
    } catch (e) {
      console.warn('[AudioEngine] saveClip failed:', e);
    }
  }

  // ---- background resilience -------------------------------------
  _startKeepAlive() {
    try {
      const ctx = this.audioContext;
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); // 1s of silence
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(ctx.destination);
      src.start();
      this.keepAlive = { src, g };
    } catch (_) {
      /* non-fatal */
    }
  }

  _handleCtxStateChange() {
    const st = this.audioContext && this.audioContext.state;
    if (!this._recording) return;
    if (st === 'suspended' || st === 'interrupted') {
      if (!this._suspendedSince) this._suspendedSince = Date.now();
      this._setStatus('interrupted', 'Audio paused by the operating system — keep the app open.');
      this.audioContext.resume().catch(() => {});
    } else if (st === 'running' && this._suspendedSince) {
      const gapSec = round1((Date.now() - this._suspendedSince) / 1000);
      this._suspendedSince = 0;
      this._lastAudioAt = Date.now();
      this._setStatus('recording', null, { recoveredGapSec: gapSec });
    }
  }

  _handleVisibility() {
    if (!this._recording) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      if (this.audioContext && this.audioContext.state !== 'running') {
        this.audioContext.resume().catch(() => {});
      }
      this.wakeLock.acquire().catch(() => {});
    }
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = setInterval(() => {
      if (!this._recording) return;
      const idle = Date.now() - this._lastAudioAt;
      if (idle > STALL_TIMEOUT_MS) {
        this._setStatus('stalled', `No audio for ${Math.round(idle / 1000)}s — attempting recovery.`);
        if (this.audioContext && this.audioContext.state !== 'running') {
          this.audioContext.resume().catch(() => {});
        }
        if (typeof document === 'undefined' || document.visibilityState === 'visible') this.wakeLock.acquire().catch(() => {});
      }
    }, 3000);
  }

  _stopWatchdog() {
    if (this._watchdog) clearInterval(this._watchdog);
    this._watchdog = null;
  }

  // ---- helpers ---------------------------------------------------
  _ctxToWall(ctxTime) {
    if (typeof ctxTime !== 'number') return Date.now();
    return this.startWallTime + (ctxTime - this.ctxStartTime) * 1000;
  }
  _wallToCtx(wall) {
    return this.ctxStartTime + (wall - this.startWallTime) / 1000;
  }

  _setStatus(status, message, extra) {
    this.status = status;
    try {
      this.onStatusChange(status, message || (extra ? extra : undefined), extra);
    } catch (e) {
      console.warn('[AudioEngine] onStatusChange threw:', e);
    }
  }

  async _teardown() {
    this._stopWatchdog();
    this._stopCheckpoints();
    try {
      if (this.keepAlive) {
        try {
          this.keepAlive.src.stop();
        } catch (_) {
          /* already stopped */
        }
        this.keepAlive.src.disconnect();
        this.keepAlive.g.disconnect();
      }
      if (this.workletNode) {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      }
      if (this.sourceNode) this.sourceNode.disconnect();
      if (this.sinkNode) this.sinkNode.disconnect();
      if (this.mediaStream) this.mediaStream.getTracks().forEach((t) => t.stop());
      if (this.audioContext) {
        this.audioContext.removeEventListener('statechange', this._onCtxStateChange);
        if (this.audioContext.state !== 'closed') await this.audioContext.close();
      }
    } catch (e) {
      console.warn('[AudioEngine] teardown warning:', e);
    }
    this.keepAlive = null;
    this.workletNode = null;
    this.sourceNode = null;
    this.sinkNode = null;
    this.mediaStream = null;
    this.audioContext = null;
  }
}

// ---------------------------------------------------------------------------
// microphone acquisition
// ---------------------------------------------------------------------------
async function openMicrophone() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const e = new Error('This browser cannot access the microphone.');
    e.name = 'NotSupportedError';
    throw e;
  }
  // `ideal` (not exact) so an unsupported rate never triggers OverconstrainedError
  const preferred = {
    audio: {
      channelCount: { ideal: 1 },
      sampleRate: { ideal: TARGET_SAMPLE_RATE },
      echoCancellation: { ideal: false },
      noiseSuppression: { ideal: false },
      autoGainControl: { ideal: false },
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(preferred);
  } catch (err) {
    if (err && (err.name === 'OverconstrainedError' || err.name === 'NotReadableError' || err.name === 'TypeError')) {
      // fall back to the most permissive request
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw err;
  }
}

function describeMicError(err) {
  const name = (err && err.name) || 'Error';
  const map = {
    NotAllowedError:
      'Microphone access is blocked for this site. Open your browser’s site settings ' +
      '(the lock/AA icon by the address bar) → Microphone → Allow, then reload. ' +
      'On iPhone also check Settings → Safari → Microphone, or Settings → the app.',
    SecurityError: 'Microphone needs a secure (https) connection.',
    NotFoundError: 'No microphone was found on this device.',
    NotReadableError:
      'The microphone is in use by another app. Close other apps using the mic and try again.',
    AbortError: 'The microphone request was interrupted. Try again.',
    NotSupportedError: 'This browser cannot access the microphone.',
  };
  return {
    name,
    message: map[name] || `Microphone error: ${(err && err.message) || name}`,
    raw: err && err.message,
  };
}

// ---------------------------------------------------------------------------
// WAV encoding — 16-bit PCM mono
// ---------------------------------------------------------------------------
export function float32ToWav(samples, sampleRate = 16000) {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
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
function freshTally() {
  return {
    snoringEpisodes: 0,
    bruxismEpisodes: 0,
    noiseEpisodes: 0,
    snoringDuration: 0,
    bruxismDuration: 0,
    noiseDuration: 0,
    loudestDb: -Infinity,
  };
}
// A phone mic at ~0.5 m: full-scale (dBFS 0) corresponds very roughly to a
// ~105 dB SPL source. Used only for a friendly, clearly-labelled estimate.
const SPL_REFERENCE = 105;

function dbFS(rms) {
  return 20 * Math.log10(Math.max(rms || 0, 1e-7));
}
function clampNum(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
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
function fmtDur(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
function cryptoId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Map a 0–1 sensitivity slider to a noise-gate RMS threshold. This is only the
 * floor below which a 2-second window is treated as pure silence and skipped;
 * the live dB meter still shows every sound.
 * Higher sensitivity => lower gate => quieter sounds get classified.
 * 0.0 -> ~0.02 (-34 dBFS), 0.5 -> ~0.004 (-48 dBFS), 1.0 -> ~0.0006 (-64 dBFS)
 */
export function sensitivityToThreshold(v) {
  const s = clamp01(v);
  return 0.0006 + (0.02 - 0.0006) * Math.pow(1 - s, 2.2);
}

export default AudioEngine;
