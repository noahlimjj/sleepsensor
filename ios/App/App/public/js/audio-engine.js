/*
 * audio-engine.js — SleepSensor
 *
 * Owns the microphone → AudioWorklet → Classifier → Storage pipeline for a
 * night of monitoring. The frontend constructs one AudioEngine, wires up the
 * callbacks, and calls start()/stop().
 *
 *   const engine = new AudioEngine({
 *     classifier, storage,
 *     onEnergy:       (rms, db, peak) => {},
 *     onEvent:        (event) => {},   // { type:'snoring'|'bruxism'|'noise'|'apnea', ... }
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
import { ApneaDetector } from './apnea-detector.js';
import { RespRateTracker } from './resp-rate.js';
import { soundShape, labelNoise } from './sound-shape.js';

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

// adaptive ambient floor: a sound counts as "loud" when it stands out from the
// room's own background by a sensitivity-dependent margin, so a quiet bedroom
// picks up soft sounds a fixed dBFS bar would miss (phone mics on a nightstand
// often hear snoring at -45 dBFS or below).
// The floor drops quickly towards quieter windows and creeps up slowly, so a
// steady fan or AC is learned within a minute while a cough, a word or a bout
// of talking barely moves it.
const FLOOR_RISE_DB = 0.5; // max rise per 2 s window (~15 dB/min)
const FLOOR_FALL = 0.5; // blend factor towards a quieter window
// the floor hugs the room's quietest moments, so a background that swells and
// fades (AC cycling, a fan's airflow) would read as a "sound" on every swell.
// A window must also clear the quiet level of the last few windows (its own
// included) by this much — a brief cough or word barely lifts the quiet level,
// a swelling background lifts it along with the peak.
const RECENT_QUIET_WINDOWS = 5; // 10 s
const RECENT_QUIET_MARGIN_DB = 2;
// ...but it may lift the bar at most this far, so a sustained sound (talking,
// a fan switching on) still registers until the floor catches up
const RECENT_QUIET_MAX_LIFT_DB = 6;
const DEFAULT_SENSITIVITY = 0.7;
// the classifier's loudness feature was trained on close-mic recordings; a
// phone across the bed hears the same sounds 10-20 dB quieter. Treat the room
// floor as a reference and lift it to this level (capped) before classifying.
const CLASSIFY_FLOOR_DB = -50;
// a generic sound this far over the loud threshold (+1.5 dB) is logged from a
// single window
const SINGLE_WINDOW_RATIO = 1.19;
// bout-level snoring: across a bout's windows the model's mean snoring
// probability is a steadier signal than any one window's top label
const BOUT_MIN_WINDOWS = 3;
const BOUT_SNORE_MEAN = 0.3;
const MAX_LOUDNESS_GAIN_DB = 20;

// loudest-moment highlights — capture the loudest sounds of the night by peak
// amplitude, whatever they are (a shout, a bang, a dog, a snore). A window
// qualifies on peak OR average level, so brief transients are not missed.
const MAX_HIGHLIGHTS = 20;
const HIGHLIGHT_MIN_PEAK = 0.05; // ~ -26 dBFS instantaneous — clearly audible
const HIGHLIGHT_MIN_RMS = 0.012; // ~ -38 dBFS sustained
const HIGHLIGHT_MIN_GAP_MS = 12000; // collapse repeats of the same loud bout
const HIGHLIGHT_PAD_SEC = 3;

// breathing-pause clips: the tail of the pause plus the snort/gasp that ends it
const APNEA_CLIP_LEAD_SEC = 20;
// single pauses are unreliable on ordinary nights (PSG-Audio, nights with AHI
// < 15: ~1 in 10 flagged pauses is real at the counting cut-off). All candidates
// still feed the hourly estimate (the validated number); only likely ones get a clip
export const APNEA_SHOW_PROB = 0.6;
// a pause can only be judged where breathing was audible: a breathing-rate
// estimate within 3 min before it. A phone in a very quiet room often hears no
// breath at all, and "no breath sound, then a noise" is not an apnea.
const APNEA_AUDIBLE_BEFORE_MS = 180000;
const APNEA_MAX_SEC = 60; // longer "pauses" are silence the mic could not resolve
const AHI_MIN_AUDIBLE_SEC = 1800; // need 30 min of audible breathing for an estimate
// phone handling: putting the phone down / picking it up to stop
const SETTLE_MS = 60000;
const HANDLING_TAIL_MS = 90000;
const APNEA_CLIP_TAIL_SEC = 8; // the recovery breaths; detection fires ~30 s later, so this audio exists

// background-resilience watchdog
const STALL_TIMEOUT_MS = 9000; // no worklet audio for this long => try to recover

// dead-mic detection. After an interruption (notification, Siri, an alarm,
// another app) iOS WebKit can leave the getUserMedia track muted: the worklet
// keeps running but is fed pure digital zeros, which looks exactly like a quiet
// room — the night silently records nothing. A real microphone never delivers
// a 2 s window this quiet, so a few such windows mean the mic is gone: reopen it.
const DEAD_MIC_PEAK = 3e-6; // ~ -110 dBFS: below any real mic's self-noise
const DEAD_MIC_WINDOWS = 3; // 6 s of dead air
const MIC_REOPEN_MIN_GAP_MS = 20000; // retry the mic at most this often
const MAX_GAPS = 60; // listening gaps kept per session

// night baseline: a generic sound is only logged when it clearly deviates from
// what this night normally sounds like (the 60th percentile of the last 10 min
// of window levels, so steady breathing, a fan or soft room noise sets the bar
// instead of the silent gaps between breaths), by a sensitivity-dependent margin.
// A sound has to persist ~4 min before it counts as the new normal.
const BASELINE_WINDOWS = 300; // 10 min
const BASELINE_PCT = 0.6;
const BASELINE_WARMUP = 15; // 30 s before the baseline is trusted

// clicks / snaps (detected in the worklet): clicks within 10 s form one event;
// only a few representative clips are kept, the rest are counted and timed
const CLICK_CLUSTER_GAP_MS = 10000;
const MAX_CLICK_CLIPS = 8;
const GRINDISH_SCORE = 0.25; // model's grinding probability that always earns a clip
const MIN_CLICKS_PER_EVENT = 2;
const MAX_CLICK_TIMES = 4000;
const TMJ_WINDOW_MS = 120000; // clicks this close to grinding: possibly TMJ/bruxism-related
const TRACE_MAX_MIN = 16 * 60; // per-minute diagnostic trace (one row per minute)

export class AudioEngine {
  constructor({ classifier, storage, onEnergy, onEvent, onStatusChange } = {}) {
    this.storage = storage || null;
    this.classifier = classifier || null;
    this.onEnergy = onEnergy || (() => {});
    this.onEvent = onEvent || (() => {});
    this.onStatusChange = onStatusChange || (() => {});

    this.wakeLock = new WakeLock();
    this._smoother = new HmmSmoother({ classes: SMOOTH_CLASSES });
    this.apneaDetector = new ApneaDetector();

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

    this.dbOffset = DEFAULT_DB_OFFSET;
    this.dbCalibrated = false;
    this._calMeanSq = 0; // ~2 s running mean of the A-weighted level
    this.sensitivity = DEFAULT_SENSITIVITY;
    this.noiseGate = sensitivityToThreshold(DEFAULT_SENSITIVITY);
    this._floor = null; // ambient background level (RMS), learned per session
    this._recentQuiet = []; // quiet-slice level of the last few windows

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
    this._resetListening();
    this._resetNight();
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
   *   dbFS  — unweighted, relative to full scale (0 = clipping)
   *   dbA   — A-weighted, Fast (125 ms) sound level in dBA: calibrated when
   *           `calibrated` is true, otherwise a typical-phone estimate (±10 dB)
   *   spl   — same as dbA (kept for older callers)
   */
  getLevel() {
    const rms = this._lastRms || 0;
    const peak = this._lastPeak || rms;
    const laf = this._lastLaf ?? rms;
    const dbA = Math.round(clampNum(this.toDbA(laf), 0, 130));
    return {
      rms,
      peak,
      dbFS: round1(dbFS(rms)),
      peakDbFS: round1(dbFS(peak)),
      dbA,
      spl: dbA,
      calibrated: this.dbCalibrated,
    };
  }

  /** Convert an A-weighted RMS (full scale = 1) to an estimated dBA. */
  toDbA(rms) {
    return dbFS(rms) + this.dbOffset;
  }

  /**
   * Set the dBFS -> dBA offset. `calibrated` marks a user calibration against a
   * reference meter (vs the generic phone default).
   */
  setDbCalibration(offset, calibrated = true) {
    this.dbOffset = clampNum(Number(offset) || DEFAULT_DB_OFFSET, 60, 160);
    this.dbCalibrated = !!calibrated;
    if (this.storage) {
      this.storage.setSetting('dbCalibration', { offset: this.dbOffset, calibrated: this.dbCalibrated }).catch(() => {});
    }
    return this.dbOffset;
  }

  /**
   * Calibrate against a reference: `referenceDbA` is what a sound level meter
   * (A-weighted) next to the phone reads right now. Uses the last ~2 s average
   * so a steady sound gives a stable result. Returns the new offset, or null if
   * the mic has not been heard yet.
   */
  calibrateTo(referenceDbA) {
    const ms = this._calMeanSq;
    if (!(ms > 0) || !Number.isFinite(Number(referenceDbA))) return null;
    return this.setDbCalibration(Number(referenceDbA) - 10 * Math.log10(ms), true);
  }

  resetDbCalibration() {
    return this.setDbCalibration(DEFAULT_DB_OFFSET, false);
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
    if (this.storage) this.storage.setSetting('sensitivityV2', this.sensitivity).catch(() => {});
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

    // 1. Synchronously initialise AudioContext and kick off resume within the
    //    active user gesture (tap/click), preventing iOS WebKit autoplay blocks.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new Ctx();
      this.audioContext.addEventListener('statechange', this._onCtxStateChange);
    }
    const resumePromise = this.audioContext.state === 'suspended'
      ? this.audioContext.resume().catch((e) => console.warn('[AudioEngine] initial resume warning:', e))
      : Promise.resolve();

    // In the SAME synchronous turn of the user gesture, request the microphone.
    const micPromise = openMicrophone();

    let stream;
    try {
      stream = await micPromise;
    } catch (err) {
      const info = describeMicError(err);
      this._setStatus('error', info.message, info);
      const e = new Error(info.message);
      e.name = info.name;
      throw e;
    }
    this.mediaStream = stream;

    try {
      // 2. Wait for AudioContext resume and build the audio graph
      await resumePromise;
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume().catch(() => {});
      }

      // Load worklet processor; fall back to Blob URL if WKWebView scheme denies direct URL
      const workletUrl = new URL('./audio-worklet-processor.js', import.meta.url);
      try {
        await this.audioContext.audioWorklet.addModule(workletUrl.href);
      } catch (workletErr) {
        console.warn('[AudioEngine] direct addModule failed, trying blob URL fallback:', workletErr);
        const resp = await fetch(workletUrl.href);
        const text = await resp.text();
        const blob = new Blob([text], { type: 'application/javascript; charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        try {
          await this.audioContext.audioWorklet.addModule(blobUrl);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }

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
      this._watchTrack();

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
      this._resetListening();
      this._resetNight();
      this._smoother.reset();
      this.apneaDetector.reset();
      this._floor = null;
      this._recentQuiet = [];

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
    this._finalizeClicks();
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
    const audibleSec = this._breathAudibleSec();
    const ahiRaw = ApneaDetector.calculateAhiMetrics(this._apneaKept, audibleSec);
    const ahi = audibleSec >= AHI_MIN_AUDIBLE_SEC ? ahiRaw : { ...ahiRaw, estimatedAhi: null, severity: 'unknown' };
    await this._dropHandlingTail();

    this._markHearing(); // close an open gap at the stop time
    const summaryPatch = {
      ...this._listeningPatch(),
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
      ...this._nightDbA(),
      apneaEvents: t.apneaEvents,
      apneaDuration: round1(t.apneaDuration),
      apneaUnheard: t.apneaUnheard || 0,
      breathAudibleSec: audibleSec,
      estimatedAhi: ahi.estimatedAhi,
      ahiSeverity: ahi.severity,
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
          ...this._listeningPatch(),
          snoringDuration: round1(t.snoringDuration),
          bruxismDuration: round1(t.bruxismDuration),
          noiseDuration: round1(t.noiseDuration),
          snoringEpisodes: t.snoringEpisodes,
          bruxismEpisodes: t.bruxismEpisodes,
          noiseEpisodes: t.noiseEpisodes,
          loudestDb: t.loudestDb === -Infinity ? null : round1(t.loudestDb),
          ...this._nightDbA(),
          apneaEvents: t.apneaEvents,
          apneaDuration: round1(t.apneaDuration),
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
      this._markDeaf('interrupted');
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
      // the OS often hands the session back with the WebView's mic still muted
      setTimeout(() => this._checkMic('after-interruption'), 1500);
    }
  }

  // ---- worklet message handling -------------------------------------
  _onWorkletMessage(e) {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'energy') {
      this._lastRms = msg.rms;
      this._lastPeak = msg.peak ?? msg.rms;
      if (typeof msg.laf === 'number') {
        this._lastLaf = msg.laf;
        const sq = msg.laf * msg.laf;
        this._calMeanSq = this._calMeanSq ? this._calMeanSq + 0.0027 * (sq - this._calMeanSq) : sq; // ~2 s at ~187 Hz
      }
      this.onEnergy(msg.rms, dbFS(msg.rms), this._lastPeak);
      return;
    }
    this._lastAudioAt = Date.now();
    this._trackDbA(msg);
    if (msg.type === 'silence' || msg.type === 'spectrogram') {
      this._noteWindowAlive(msg);
      this._feedRespRate(msg);
      this._feedClicks(msg);
    }

    switch (msg.type) {
      case 'silence': {
        const smoothed = this._smoother.push({ quiet: 1 });
        this._considerHighlight(msg, { type: 'silence', confidence: 0 });
        this._handleClassification(smoothed, msg);
        this._feedApnea({ type: 'silence', confidence: 1 }, msg);
        break;
      }
      case 'spectrogram': {
        let result;
        try {
          result = this.classifier.classify(msg.data, {
            rms: msg.rms,
            peak: msg.peak,
            zcr: msg.zcr,
            activeRms: msg.activeRms,
            gate: this.noiseGate,
            loudnessGain: this.loudnessGain(),
          });
        } catch (err) {
          console.warn('[AudioEngine] classify failed:', err);
          result = { type: 'other', confidence: 0, scores: {} };
        }
        // temporal smoothing (HMM forward filter) -> stable event decisions
        const smoothed = this._smoother.push(result.scores || {});
        this._lastRaw = result;
        this._traceLabel(result.type);
        this._considerHighlight(msg, result); // highlights use the raw per-window label
        this._handleClassification(smoothed, msg, result);
        this._feedApnea(result, msg); // pause timing needs the unsmoothed verdict
        break;
      }
      case 'audio-clip':
        this._handleClip(msg);
        break;
      default:
        break;
    }
  }

  // ---- sound level (dBA) over the night --------------------------------
  _trackDbA(msg) {
    const t = this._tally;
    if (typeof msg.laeq === 'number') {
      t.aEnergy += msg.laeq * msg.laeq;
      t.aWindows += 1;
    }
    if (typeof msg.lafMax === 'number' && msg.lafMax > t.lafMax) t.lafMax = msg.lafMax;
  }

  _nightDbA() {
    const t = this._tally;
    return {
      laeqDbA: t.aWindows ? round1(this.toDbA(Math.sqrt(t.aEnergy / t.aWindows))) : null,
      loudestDbA: t.lafMax > 0 ? round1(this.toDbA(t.lafMax)) : null,
      dbCalibrated: this.dbCalibrated,
    };
  }

  // ---- ambient floor -------------------------------------------------
  _level(msg) {
    return Math.max(msg.activeRms ?? 0, msg.rms ?? 0);
  }

  _noteQuiet(msg) {
    const level = typeof msg.quietRms === 'number' ? msg.quietRms : this._level(msg);
    if (!this._recentQuiet) this._recentQuiet = [];
    this._recentQuiet.push(level);
    if (this._recentQuiet.length > RECENT_QUIET_WINDOWS) this._recentQuiet.shift();
  }

  _trackLevel(msg) {
    // prefer the quietest slices of the window (between breaths/snores); fall
    // back to the window level when the worklet doesn't report them
    const level = typeof msg.quietRms === 'number' ? msg.quietRms : this._level(msg);
    let f = this._floor ?? level;
    if (level < f) f = f * (1 - FLOOR_FALL) + level * FLOOR_FALL;
    else f = Math.min(level, f * Math.pow(10, FLOOR_RISE_DB / 20));
    // a dropout (digital silence) must not drag the floor to zero
    this._floor = Math.max(f, this.noiseGate * 0.25);
  }

  /** Estimated background level (RMS) of the room. */
  ambientFloor() {
    return this._floor ?? this.noiseGate;
  }

  /** Gain applied to the classifier's loudness feature (>= 1). */
  loudnessGain() {
    const lift = CLASSIFY_FLOOR_DB - dbFS(this.ambientFloor());
    return Math.pow(10, clampNum(lift, 0, MAX_LOUDNESS_GAIN_DB) / 20);
  }

  /** RMS a window must reach to count as a sound worth logging. */
  loudThreshold() {
    // 7 dB above the floor at minimum sensitivity, 2 dB at maximum
    // (3.5 dB at the 0.7 default)
    const marginDb = 7 - 5 * this.sensitivity;
    const relative = this.ambientFloor() * Math.pow(10, marginDb / 20);
    const recent = this._recentQuiet && this._recentQuiet.length ? Math.max(...this._recentQuiet) : 0;
    const swell = Math.min(
      recent * Math.pow(10, RECENT_QUIET_MARGIN_DB / 20),
      relative * Math.pow(10, RECENT_QUIET_MAX_LIFT_DB / 20),
    );
    return Math.max(this.noiseGate, relative, swell);
  }

  // Decide the effective label for a window: classifier verdict, or a generic
  // "noise" when it is simply above the ambient floor, or negative.
  _effectiveType(result, msg, raw = null) {
    const min = this.classifier?.minConfidence ?? 0.35;
    // at higher sensitivity a confident single-window snore/grind is not
    // swallowed by the HMM's lag while it is still catching up
    if (
      raw && this.sensitivity >= 0.55 &&
      (raw.type === 'snoring' || raw.type === 'bruxism') &&
      raw.type !== result.type && (raw.confidence || 0) >= 0.6
    ) {
      result = raw;
    }
    // bruxism is the lower-precision class — hold it to a higher bar so a hissy
    // fan or distant traffic isn't logged as teeth grinding.
    if (result.type === 'snoring' && result.confidence >= min) {
      return { type: 'snoring', confidence: result.confidence };
    }
    if (result.type === 'bruxism' && result.confidence >= Math.max(min, 0.5)) {
      return { type: 'bruxism', confidence: result.confidence };
    }
    // a click inflates the window's loudest 100 ms slice; judge clicky windows
    // on their 2 s level (the clicks themselves are counted separately)
    const level = msg.clicks && msg.clicks.length ? msg.rms ?? 0 : this._level(msg);
    const threshold = this.loudThreshold();
    // inside an ongoing snoring/grinding bout the in-between windows keep it
    // together (the model flips between labels); elsewhere a generic sound must
    // clearly deviate from the night's baseline
    const p = this._pending;
    const inBout = !!(p && p.emitted && (p.type === 'snoring' || p.type === 'bruxism'));
    const snoreish = !!(raw && raw.scores && (raw.scores.snoring || 0) >= BOUT_SNORE_MEAN);
    // err towards keeping anything that may be grinding: it skips the baseline bar
    const grindish = !!(raw && raw.scores && (raw.scores.bruxism || 0) >= GRINDISH_SCORE);
    const settling = this._inSettle(this._ctxToWall(msg.timestamp));
    const loud = !settling && level >= threshold && (inBout || snoreish || grindish || level >= this.deviationThreshold());
    // no "confident quiet" veto: steady background (a fan, AC) is already
    // absorbed into the floor, and the model often calls a quiet cough "quiet"
    if (result.type === 'noise' && result.confidence >= 0.4 && loud) {
      return { type: 'noise', confidence: result.confidence };
    }
    if (loud) {
      // 0.4 at the threshold, rising ~0.1 per 3 dB above it
      const overDb = 20 * Math.log10(level / threshold);
      return { type: 'noise', confidence: clamp01(0.4 + overDb / 30) };
    }
    return null;
  }

  _handleClassification(result, msg, raw = null) {
    const ctxTime = typeof msg.timestamp === 'number' ? msg.timestamp : this._wallToCtx(Date.now());
    const wall = this._ctxToWall(ctxTime);
    // the session's first window seeds the floor, so a fan or AC that is
    // already running is background from the start rather than a "sound"
    if (this._floor == null) this._trackLevel(msg);
    this._noteQuiet(msg);
    const positive = this._effectiveType(result, msg, raw);
    const grindy = !!(raw && raw.scores && (raw.scores.bruxism || 0) >= GRINDISH_SCORE);
    const devHit = !!positive && (grindy || this._windowLevel(msg) >= this.deviationThreshold());
    this._trackLevel(msg);
    this._noteBaseline(msg);
    if (!positive) this._noteBackgroundBand(msg);

    if (positive) {
      const { type, confidence } = positive;
      const peak = msg.peak ?? msg.rms ?? 0;
      const level = this._level(msg);
      const p = this._pending;
      // a generic loud window can belong to a snoring/grinding bout (the model
      // often flips between "snoring" and "noise" within one bout), but
      // snoring and grinding never merge with each other
      const compatible = p && (p.type === type || p.type === 'noise' || type === 'noise');
      if (p && compatible && wall - p.lastWall <= CONFIRM_WINDOW_MS) {
        p.count += 1;
        p.votes[type] = (p.votes[type] || 0) + 1;
        p.lastWall = wall;
        p.lastCtx = ctxTime;
        p.confidences.push(confidence);
        p.peaks.push(peak);
        p.maxLevel = Math.max(p.maxLevel, level);
        this._addLevel(p, msg);
        this._addBoutEvidence(p, raw);
        this._addShape(p, msg);
        if (devHit) p.devHit = true;
        this._negativeStreak = 0;
      } else {
        this._finalizePending();
        this._pending = {
          type,
          count: 1,
          votes: { [type]: 1 },
          startWall: wall - WINDOW_SEC * 1000,
          startCtx: ctxTime - WINDOW_SEC,
          lastWall: wall,
          lastCtx: ctxTime,
          confidences: [confidence],
          peaks: [peak],
          maxLevel: level,
          emitted: false,
          eventId: null,
          ev: { n: 0, snoring: 0, bruxism: 0 },
          aEnergy: 0,
          aWindows: 0,
          lafMax: 0,
        };
        this._addLevel(this._pending, msg);
        this._addBoutEvidence(this._pending, raw);
        this._addShape(this._pending, msg);
        this._pending.devHit = devHit;
        this._negativeStreak = 0;
      }

      const cur = this._pending;
      const specific = cur.votes.snoring ? 'snoring' : cur.votes.bruxism ? 'bruxism' : this._boutSnoring(cur) ? 'snoring' : null;
      if (specific && (cur.votes[specific] >= this._confirmCount(specific, msg) || (specific === 'snoring' && this._boutSnoring(cur)))) {
        if (!cur.emitted) {
          cur.type = specific;
          this._confirmPending();
        } else if (cur.type !== specific) {
          this._retypePending(specific);
        } else {
          this._growPending();
        }
      } else if (!cur.emitted && cur.devHit && (cur.votes.noise || 0) >= this._confirmCount('noise', msg)) {
        cur.type = 'noise';
        this._confirmPending();
      } else if (cur.emitted) {
        this._growPending();
      }
    } else if (this._pending) {
      this._negativeStreak += 1;
      if (this._negativeStreak >= END_NEGATIVE_STREAK) this._finalizePending();
    }
  }

  // windows needed to confirm an event. A single clearly-loud generic sound (a
  // cough, a word, a bang) is real on its own; snoring/grinding keep the 2-window
  // check against classifier flicker unless sensitivity is at maximum.
  _confirmCount(type, msg) {
    if (this.sensitivity >= 0.8) return 1;
    if (type === 'noise' && this._level(msg) >= this.loudThreshold() * SINGLE_WINDOW_RATIO) return 1;
    return CONFIRM_COUNT;
  }

  _addLevel(p, msg) {
    if (typeof msg.laeq === 'number') {
      p.aEnergy += msg.laeq * msg.laeq;
      p.aWindows += 1;
    }
    if (typeof msg.lafMax === 'number' && msg.lafMax > p.lafMax) p.lafMax = msg.lafMax;
  }

  // calibrated A-weighted levels for an event: loudest (LAFmax) and average (LAeq)
  _eventDbA(p) {
    return {
      peakDbA: p.lafMax > 0 ? round1(this.toDbA(p.lafMax)) : null,
      laeqDbA: p.aWindows ? round1(this.toDbA(Math.sqrt(p.aEnergy / p.aWindows))) : null,
    };
  }

  _addBoutEvidence(p, raw) {
    const sc = raw && raw.scores;
    if (!sc) return;
    p.ev.n += 1;
    p.ev.snoring += sc.snoring || 0;
    p.ev.bruxism += sc.bruxism || 0;
  }

  _boutSnoring(p) {
    const e = p.ev;
    if (!e || e.n < BOUT_MIN_WINDOWS) return false;
    return e.snoring / e.n >= BOUT_SNORE_MEAN && e.snoring > e.bruxism * 1.5;
  }

  // an emitted generic sound turned out to be a snoring/grinding bout
  _retypePending(type) {
    const p = this._pending;
    const from = p.type;
    this._tally[from + 'Episodes'] = Math.max(0, this._tally[from + 'Episodes'] - 1);
    this._tally[type + 'Episodes'] += 1;
    p.type = type;
    if (this.storage) this.storage.updateEvent(p.eventId, { type, subtype: null }).catch(() => {});
    this._growPending();
    const confidence = avg(p.confidences);
    this.onEvent({
      type,
      upgradedFrom: from,
      confidence: round3(confidence),
      severity: Classifier.severityFor(confidence),
      peakDb: round1(dbFS(Math.max(...p.peaks))),
      ...this._eventDbA(p),
      timestamp: Math.round(p.startWall),
      duration: round1(Math.max(WINDOW_SEC, (p.lastWall - p.startWall) / 1000)),
      eventId: p.eventId,
    });
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
      ...this._eventDbA(p),
      timestamp: Math.round(p.startWall),
      hasClip: false,
    };
    if (p.type === 'noise') {
      rec.subtype = this._noiseLabel(p, duration);
      this._handlingEvents.push({ id: p.eventId, start: p.startWall, kind: 'noise' });
      if (this._handlingEvents.length > 50) this._handlingEvents.shift();
    }
    if (this.storage) this.storage.addEvent(rec).catch((e) => console.warn('[AudioEngine] addEvent:', e));
    this._tally[p.type + 'Episodes'] += 1;

    this.onEvent({
      type: p.type,
      confidence: round3(confidence),
      severity,
      peakDb,
      ...this._eventDbA(p),
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
        ...this._eventDbA(p),
      })
      .catch(() => {});
  }

  _finalizePending() {
    const p = this._pending;
    this._pending = null;
    this._negativeStreak = 0;
    if (!p) return;
    if (!p.emitted) {
      // a sound the model guessed was snoring/grinding but that never
      // repeated is still a real sound: log it if it stood out from the room
      if (!p.devHit || p.maxLevel < this.loudThreshold()) return;
      p.type = 'noise';
      this._pending = p;
      this._confirmPending();
      this._pending = null;
    }

    const durationSec = Math.max(WINDOW_SEC, (p.lastWall - p.startWall) / 1000);
    this._tally[p.type + 'Duration'] += durationSec;
    if (p.type === 'noise') {
      const sub = this._noiseLabel(p, durationSec);
      if (this.storage && p.eventId) this.storage.updateEvent(p.eventId, { subtype: sub }).catch(() => {});
    }
    if (p.type === 'bruxism') this._noteGrind(p.startWall, p.lastWall);

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

  // ---- breathing pauses (acoustic apnea) ----------------------------
  _feedApnea(result, msg) {
    const ctxTime = typeof msg.timestamp === 'number' ? msg.timestamp : this._wallToCtx(Date.now());
    const ev = this.apneaDetector.feed(result, msg, this._ctxToWall(ctxTime));
    if (!ev) return;
    if (!this._breathAudibleBefore(ev.startTime) || ev.duration > APNEA_MAX_SEC) {
      this._tally.apneaUnheard = (this._tally.apneaUnheard || 0) + 1;
      return;
    }
    this._apneaKept.push({ ...ev, type: 'apnea' });

    const eventId = cryptoId();
    const sessionId = this.session ? this.session.id : null;
    const rec = { id: eventId, sessionId, ...ev, timestamp: ev.startTime, hasClip: false };
    if (this.storage) this.storage.addEvent(rec).catch((e) => console.warn('[AudioEngine] addEvent:', e));
    this._tally.apneaEvents += 1;
    this._tally.apneaDuration += ev.duration;

    if (this.workletNode && (ev.confidence ?? 0) >= APNEA_SHOW_PROB) {
      const onsetCtx = this._wallToCtx(ev.endTime);
      this._clipQueue.push({ kind: 'event', id: eventId, sessionId });
      this.workletNode.port.postMessage({
        command: 'extract-clip',
        startTime: onsetCtx - Math.min(ev.duration, APNEA_CLIP_LEAD_SEC),
        endTime: onsetCtx + APNEA_CLIP_TAIL_SEC,
      });
    }

    this.onEvent({
      type: 'apnea',
      confidence: ev.confidence,
      severity: ev.severity,
      peakDb: ev.peakDb,
      timestamp: ev.startTime,
      duration: ev.duration,
      arousal: ev.arousal,
      eventId,
    });
  }

  // ---- loudest-moment highlights ----------------------------------
  _considerHighlight(msg, result) {
    const peak = msg.peak ?? msg.rms ?? 0;
    const rms = msg.rms ?? 0;

    // always track the single loudest instant of the night, even sub-threshold
    const db = 20 * Math.log10(Math.max(peak, 1e-6));
    if (db > this._tally.loudestDb) this._tally.loudestDb = db;

    // qualify on a loud instantaneous peak OR a loud sustained level
    if (peak < HIGHLIGHT_MIN_PEAK && rms < HIGHLIGHT_MIN_RMS && this._level(msg) < this.loudThreshold()) return;

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

  // ---- is the microphone actually hearing anything? ------------------
  _resetListening() {
    this._gaps = [];
    this._deafSince = 0;
    this._deafReason = null;
    this._deadWindows = 0;
    this._micReopens = 0;
    this._lastReopen = 0;
    this._reopening = false;
    this._trace = [];
  }

  /** Start (or keep) a "not listening" gap. */
  _markDeaf(reason, now = Date.now()) {
    if (!this._recording && !this.session) return;
    if (!this._deafSince) {
      this._deafSince = now;
      this._deafReason = reason;
    }
  }

  /** Audio is flowing again: close the open gap, if any. */
  _markHearing(now = Date.now()) {
    if (!this._deafSince) return;
    const start = this._deafSince;
    const end = Math.max(start, now);
    this._deafSince = 0;
    if (end - start < 4000) return; // a blip, not a gap
    this._gaps.push({ start, end, sec: round1((end - start) / 1000), reason: this._deafReason });
    if (this._gaps.length > MAX_GAPS) this._gaps.shift();
  }

  _listeningPatch() {
    const open = this._deafSince ? [{ start: this._deafSince, end: Date.now(), sec: round1((Date.now() - this._deafSince) / 1000), reason: this._deafReason, open: true }] : [];
    const gaps = [...this._gaps, ...open];
    return {
      listenGaps: gaps,
      deafSec: round1(gaps.reduce((a, g) => a + g.sec, 0)),
      micReopens: this._micReopens,
      trace: this._trace.slice(-TRACE_MAX_MIN),
      respRate: this._rr ? this._rr.summary() : null,
      clicks: this._clicks ? { ...this._clicks, times: this._clickTimes.slice() } : null,
    };
  }

  _traceRow(wall) {
    const m = Math.floor((wall - this.startWallTime) / 60000);
    let row = this._trace[this._trace.length - 1];
    if (!row || row.m !== m) {
      // m: minute since start; db: loudest window (dBFS); n: windows; s: sound
      // windows classified; sn/br: raw snoring/grinding labels; z: dead-mic windows
      row = { m, db: -120, n: 0, s: 0, sn: 0, br: 0, z: 0 };
      this._trace.push(row);
      if (this._trace.length > TRACE_MAX_MIN) this._trace.shift();
    }
    return row;
  }

  _traceLabel(type) {
    const row = this._trace[this._trace.length - 1];
    if (!row) return;
    row.s += 1;
    if (type === 'snoring') row.sn += 1;
    else if (type === 'bruxism') row.br += 1;
  }

  _noteWindowAlive(msg) {
    const wall = this._ctxToWall(msg.timestamp);
    const row = this._traceRow(wall);
    row.n += 1;
    const lvl = Math.max(msg.peak ?? 0, msg.rms ?? 0, msg.activeRms ?? 0);
    const db = lvl > 0 ? round1(dbFS(lvl)) : -120;
    if (db > row.db) row.db = db;
    if (lvl < DEAD_MIC_PEAK) {
      row.z += 1;
      this._deadWindows += 1;
      if (this._deadWindows >= DEAD_MIC_WINDOWS) {
        // the gap began with the first dead window
        this._markDeaf('mic-silent', wall - (DEAD_MIC_WINDOWS - 1) * WINDOW_SEC * 1000);
        this._reopenMic('mic-silent');
      }
    } else {
      this._deadWindows = 0;
      if (!this._interrupted && !this._suspendedSince) this._markHearing(wall - WINDOW_SEC * 1000);
    }
  }

  _audioTrack() {
    return this.mediaStream && this.mediaStream.getAudioTracks ? this.mediaStream.getAudioTracks()[0] : null;
  }

  _watchTrack() {
    const track = this._audioTrack();
    if (!track) return;
    track.onmute = () => {
      if (!this._recording) return;
      this._markDeaf('mic-muted');
      // give the OS a moment to unmute on its own before reopening
      setTimeout(() => {
        if (this._recording && track === this._audioTrack() && track.muted) this._reopenMic('mic-muted');
      }, 3000);
    };
    track.onended = () => {
      if (!this._recording || track !== this._audioTrack()) return;
      this._markDeaf('mic-ended');
      this._reopenMic('mic-ended');
    };
  }

  /** Reopen the mic if it is muted, ended or feeding dead air. */
  _checkMic(why) {
    if (!this._recording) return;
    const t = this._audioTrack();
    if (!t || t.readyState === 'ended' || t.muted || this._deadWindows >= DEAD_MIC_WINDOWS) {
      this._reopenMic(why, { force: why === 'foreground' });
    }
  }

  async _reopenMic(reason, { force = false } = {}) {
    if (!this._recording || this._reopening || !this.audioContext || !this.workletNode) return false;
    const now = Date.now();
    if (!force && now - this._lastReopen < MIC_REOPEN_MIN_GAP_MS) return false;
    this._lastReopen = now;
    this._reopening = true;
    try {
      const old = this.mediaStream;
      // WebKit allows one live capture: release the dead track first
      if (old) old.getTracks().forEach((t) => t.stop());
      const stream = await openMicrophone();
      if (!this._recording) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      const oldSrc = this.sourceNode;
      this.mediaStream = stream;
      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.sourceNode.connect(this.workletNode);
      try {
        if (oldSrc) oldSrc.disconnect();
      } catch (_) {
        /* already gone */
      }
      this._watchTrack();
      this._micReopens += 1;
      this._deadWindows = 0;
      if (this.audioContext.state !== 'running') this.audioContext.resume().catch(() => {});
      this._setStatus('recording', null, { micReopened: reason });
      return true;
    } catch (e) {
      console.warn('[AudioEngine] mic reopen failed (' + reason + '):', e && (e.name || e.message));
      this._setStatus('stalled', 'Microphone was paused by the system — open the app to resume.');
      return false;
    } finally {
      this._reopening = false;
    }
  }

  // ---- night baseline, sound labels, breathing rate, clicks ------------
  _resetNight() {
    this._apneaKept = [];
    this._handlingEvents = [];
    this._lvlHist = [];
    this._rr = new RespRateTracker();
    this._clickCluster = null;
    this._clickTimes = [];
    this._clickClips = 0;
    this._clickEvents = [];
    this._grindSpans = [];
    this._clicks = { count: 0, events: 0, nearGrind: 0, nearGrindEvents: 0 };
  }

  /** Dominant band of the room when nothing is happening (hum, fan, AC). */
  _noteBackgroundBand(msg) {
    if (!msg.data || msg.data.length < 256) return;
    const sh = soundShape(msg.data);
    if (!sh) return;
    this._bgBands = this._bgBands || [];
    this._bgBands.push(sh.band);
    if (this._bgBands.length > 60) this._bgBands.shift();
  }

  _backgroundBand() {
    const b = this._bgBands;
    if (!b || b.length < 5) return null;
    const h = new Map();
    for (const x of b) h.set(x, (h.get(x) || 0) + 1);
    let mode = null, best = 0;
    for (const [k, c] of h) if (c > best) { best = c; mode = k; }
    return best >= b.length * 0.3 ? mode : null;
  }

  _windowLevel(msg) {
    return msg.clicks && msg.clicks.length ? msg.rms ?? 0 : this._level(msg);
  }

  _noteBaseline(msg) {
    const lvl = this._windowLevel(msg);
    if (!(lvl > 0)) return;
    this._lvlHist.push(lvl);
    if (this._lvlHist.length > BASELINE_WINDOWS) this._lvlHist.shift();
  }

  /** The night's normal level (RMS): 60th percentile of the last 10 minutes. */
  nightBaseline() {
    const h = this._lvlHist;
    if (!h || h.length < BASELINE_WARMUP) return null;
    const s = [...h].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) * BASELINE_PCT)];
  }

  /** RMS a generic sound must reach to count as deviating from the night. */
  deviationThreshold() {
    const base = this.nightBaseline();
    // 6.5 dB over the baseline at minimum sensitivity, 2.5 dB at maximum (~3.7 at default)
    const marginDb = 6.5 - 4 * this.sensitivity;
    // first 30 s: no baseline yet, so only a clearly loud sound counts
    if (base == null) return this.loudThreshold() * Math.pow(10, 10 / 20);
    return base * Math.pow(10, marginDb / 20);
  }

  _addShape(p, msg) {
    if (!msg.data || msg.data.length < 256) return;
    const sh = soundShape(msg.data);
    if (!sh) return;
    p.sh = p.sh || { n: 0, tonal: 0, stable: 0, burst: 0, bands: [] };
    p.sh.n += 1;
    p.sh.bands.push(sh.band);
    p.sh.tonal += sh.tonal;
    p.sh.stable += sh.stable;
    p.sh.burst += sh.burst;
  }

  _noiseLabel(p, durationSec) {
    if (!p.sh || !p.sh.n) return 'other';
    const n = p.sh.n;
    const bands = [...p.sh.bands].sort((a, b) => a - b);
    const band = bands[bands.length >> 1];
    const bg = this._backgroundBand();
    // a steady tone the room always has (mains hum, a fan's whine) is not a buzz
    const newTone = bg == null || Math.abs(band - bg) > 3;
    return labelNoise({ tonal: p.sh.tonal / n, stable: newTone ? p.sh.stable / n : 0, burst: p.sh.burst / n }, durationSec);
  }

  _breathAudibleBefore(t) {
    return this._rr.points.some((p) => p.t >= t - APNEA_AUDIBLE_BEFORE_MS && p.t <= t + 30000);
  }

  /** Seconds of the night with audibly rhythmic breathing (estimates every 30 s). */
  _breathAudibleSec() {
    return this._rr ? this._rr.points.length * 30 : 0;
  }

  _inSettle(wall) {
    return wall - this.startWallTime < (this.settleMs ?? SETTLE_MS);
  }

  /** On stop: sounds/clicks in the last 90 s are the phone being picked up (hidden, not deleted). */
  async _dropHandlingTail() {
    const cut = Date.now() - HANDLING_TAIL_MS;
    const ids = this._handlingEvents.filter((e) => e.start >= cut).map((e) => e.id);
    if (!ids.length || !this.storage) return;
    for (const id of ids) {
      const ev = this._handlingEvents.find((e) => e.id === id);
      if (ev && ev.kind === 'click') {
        this._clicks.events = Math.max(0, this._clicks.events - 1);
        this._clicks.count = Math.max(0, this._clicks.count - (ev.n || 0));
      } else this._tally.noiseEpisodes = Math.max(0, this._tally.noiseEpisodes - 1);
    }
    for (const id of ids) await this.storage.updateEvent(id, { filtered: 'handling' }).catch(() => {});
  }

  _feedRespRate(msg) {
    if (!msg.breath || !msg.breath.length) return;
    const wall = this._ctxToWall(msg.timestamp);
    const pt = this._rr.push(msg.breath, wall);
    if (pt) {
      const row = this._trace[this._trace.length - 1];
      if (row) row.rr = pt.bpm;
    }
  }

  _feedClicks(msg) {
    const wall = this._ctxToWall(msg.timestamp);
    const cl = this._clickCluster;
    if (cl && wall - WINDOW_SEC * 1000 - cl.last > CLICK_CLUSTER_GAP_MS) this._finalizeClicks();
    const clicks = msg.clicks;
    if (!clicks || !clicks.length) return;
    const row = this._trace[this._trace.length - 1];
    const winStart = wall - WINDOW_SEC * 1000;
    const ctxStart = (typeof msg.timestamp === 'number' ? msg.timestamp : this._wallToCtx(wall)) - WINDOW_SEC;
    for (const c of clicks) {
      const t = winStart + c.t * 1000;
      if (this._inSettle(t)) continue; // putting the phone down
      const ctx = ctxStart + c.t;
      this._clicks.count += 1;
      if (row) row.ck = (row.ck || 0) + 1;
      if (this._clickTimes.length < MAX_CLICK_TIMES) this._clickTimes.push(Math.round(t - this.startWallTime));
      const cur = this._clickCluster;
      if (cur && t - cur.last <= CLICK_CLUSTER_GAP_MS) {
        cur.n += 1;
        cur.last = t;
        cur.lastCtx = ctx;
        cur.db = Math.max(cur.db, c.db);
      } else {
        if (cur) this._finalizeClicks();
        this._clickCluster = { start: t, last: t, startCtx: ctx, lastCtx: ctx, n: 1, db: c.db };
      }
    }
  }

  _nearGrind(t0, t1) {
    const spans = [...this._grindSpans];
    const p = this._pending;
    if (p && p.emitted && p.type === 'bruxism') spans.push({ start: p.startWall, end: p.lastWall });
    return spans.some((g) => t0 <= g.end + TMJ_WINDOW_MS && t1 >= g.start - TMJ_WINDOW_MS);
  }

  _finalizeClicks() {
    const cl = this._clickCluster;
    this._clickCluster = null;
    if (!cl) return;
    if (cl.n < MIN_CLICKS_PER_EVENT) return; // a lone click is counted and timed, not logged
    const nearGrind = this._nearGrind(cl.start, cl.last);
    const eventId = cryptoId();
    const sessionId = this.session ? this.session.id : null;
    const duration = round1(Math.max(0.1, (cl.last - cl.start) / 1000));
    const rec = {
      id: eventId, sessionId, type: 'click', count: cl.n, nearGrind,
      startTime: Math.round(cl.start), endTime: Math.round(cl.last), timestamp: Math.round(cl.start),
      duration, confidence: 0.8, severity: cl.n >= 5 ? 'moderate' : 'mild', peakDb: cl.db, hasClip: false,
    };
    if (this.storage) this.storage.addEvent(rec).catch((e) => console.warn('[AudioEngine] addEvent:', e));
    this._clicks.events += 1;
    if (nearGrind) {
      this._clicks.nearGrind += cl.n;
      this._clicks.nearGrindEvents += 1;
    }
    this._clickEvents.push({ id: eventId, start: cl.start, end: cl.last, n: cl.n, nearGrind });
    this._handlingEvents.push({ id: eventId, start: cl.start, kind: 'click', n: cl.n });
    if (this._handlingEvents.length > 50) this._handlingEvents.shift();
    if (this._clickEvents.length > 400) this._clickEvents.shift();
    // a few representative clips, not hundreds
    const want = this._clickClips < MAX_CLICK_CLIPS && (nearGrind || cl.n >= 3 || this._clickClips < 3);
    if (want && this.workletNode) {
      this._clickClips += 1;
      this._clipQueue.push({ kind: 'event', id: eventId, sessionId });
      this.workletNode.port.postMessage({
        command: 'extract-clip',
        startTime: Math.max(cl.startCtx - 2, cl.lastCtx - 25),
        endTime: cl.lastCtx + 2,
      });
    }
    this.onEvent({ type: 'click', count: cl.n, nearGrind, confidence: 0.8, severity: rec.severity, peakDb: cl.db, timestamp: rec.timestamp, duration, eventId });
  }

  /** A grinding episode ended: clicks within 2 min before it become TMJ-flagged too. */
  _noteGrind(start, end) {
    this._grindSpans.push({ start, end });
    if (this._grindSpans.length > 200) this._grindSpans.shift();
    for (const c of this._clickEvents) {
      if (c.nearGrind) continue;
      if (c.start <= end + TMJ_WINDOW_MS && c.end >= start - TMJ_WINDOW_MS) {
        c.nearGrind = true;
        this._clicks.nearGrind += c.n;
        this._clicks.nearGrindEvents += 1;
        if (this.storage) this.storage.updateEvent(c.id, { nearGrind: true }).catch(() => {});
      }
    }
  }

  _handleCtxStateChange() {
    const st = this.audioContext && this.audioContext.state;
    if (!this._recording) return;
    if (st === 'suspended' || st === 'interrupted') {
      if (!this._suspendedSince) this._suspendedSince = Date.now();
      this._markDeaf('suspended');
      this._setStatus('interrupted', 'Audio paused by the operating system — keep the app open.');
      this.audioContext.resume().catch(() => {});
    } else if (st === 'running' && this._suspendedSince) {
      const gapSec = round1((Date.now() - this._suspendedSince) / 1000);
      this._suspendedSince = 0;
      this._lastAudioAt = Date.now();
      this._setStatus('recording', null, { recoveredGapSec: gapSec });
      setTimeout(() => this._checkMic('after-suspend'), 1500);
    }
  }

  _handleVisibility() {
    if (!this._recording) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      if (this.audioContext && this.audioContext.state !== 'running') {
        this.audioContext.resume().catch(() => {});
      }
      this.wakeLock.acquire().catch(() => {});
      this._checkMic('foreground');
    }
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchdog = setInterval(() => {
      if (!this._recording) return;
      const idle = Date.now() - this._lastAudioAt;
      if (idle > STALL_TIMEOUT_MS) {
        this._setStatus('stalled', `No audio for ${Math.round(idle / 1000)}s — attempting recovery.`);
        this._markDeaf('stalled');
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
        if (typeof this.audioContext.removeEventListener === 'function') {
          this.audioContext.removeEventListener('statechange', this._onCtxStateChange);
        }
        if (this.audioContext.state !== 'closed' && typeof this.audioContext.close === 'function') {
          await this.audioContext.close();
        }
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
    apneaEvents: 0,
    apneaDuration: 0,
    loudestDb: -Infinity,
    aEnergy: 0, // sum of per-window A-weighted mean squares (for LAeq)
    aWindows: 0,
    lafMax: 0, // loudest Fast-weighted A level (RMS)
  };
}
// A phone mic at ~0.5 m: full-scale (dBFS 0) corresponds very roughly to a
// ~105 dB SPL source. Used only for a friendly, clearly-labelled estimate.
// default dBFS -> dBA offset for an uncalibrated phone mic. There is no
// universal value (it depends on the mic and on iOS/browser processing), so the
// UI marks readings "est." until the user calibrates against a reference meter.
const DEFAULT_DB_OFFSET = 105;

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
 * 0.0 -> ~0.0125 (-38 dBFS), 0.5 -> ~0.0013 (-58 dBFS), 0.7 -> ~0.00038 (-68 dBFS),
 * 1.0 -> ~0.0002 (-74 dBFS, below a phone mic's own noise in a silent room)
 */
export function sensitivityToThreshold(v) {
  const s = clamp01(v);
  return 0.0002 + (0.0125 - 0.0002) * Math.pow(1 - s, 3.5);
}

export default AudioEngine;
