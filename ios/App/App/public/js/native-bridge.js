/*
 * native-bridge.js — SleepSensor
 *
 * Thin coordination layer over the Capacitor native runtime. When the app runs
 * inside the Capacitor shell (iOS / Android) this unlocks true all-night
 * background recording:
 *
 *   - iOS   : an active AVAudioSession (.playAndRecord) + a looping silent
 *             buffer keeps the app alive with UIBackgroundModes:audio, so the
 *             WebView's getUserMedia + AudioWorklet keep running while locked.
 *   - Android: a foreground Service with a persistent notification + a partial
 *             wake lock keeps the process (and the audio graph) running.
 *
 * On the plain web it is a set of safe no-ops — the engine falls back to the
 * Screen Wake Lock + watchdog it already has.
 *
 * No build step / imports: the Capacitor runtime injects `window.Capacitor`.
 */

const Cap = typeof globalThis !== 'undefined' ? globalThis.Capacitor : undefined;
const IS_NATIVE = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
const PLATFORM = Cap && typeof Cap.getPlatform === 'function' ? Cap.getPlatform() : 'web';

// core plugins are registered by the native runtime; registerPlugin just wires
// the JS proxy. Safe to call even for names the shell doesn't implement.
function plugin(name) {
  try {
    if (Cap && typeof Cap.registerPlugin === 'function') return Cap.registerPlugin(name);
    if (Cap && Cap.Plugins && Cap.Plugins[name]) return Cap.Plugins[name];
  } catch (_) {
    /* ignore */
  }
  return null;
}

export class NativeBridge {
  constructor() {
    this.available = IS_NATIVE;
    this.platform = PLATFORM;
    this._recorder = IS_NATIVE ? plugin('BackgroundRecorder') : null;
    this._app = plugin('App');
    this._device = plugin('Device');
    this._listeners = [];
    this._active = false;
  }

  /** True when native background recording is actually usable. */
  get supported() {
    return this.available && !!this._recorder;
  }

  /**
   * One-time setup: permissions + (Android) battery-optimisation exemption.
   * Returns { ok, battery, charging, warnings[] }.
   */
  async prepare() {
    const warnings = [];
    if (!this.supported) {
      return { ok: false, native: false, warnings: ['Running in a browser — recording pauses when the screen locks.'] };
    }
    try {
      const perm = await this._recorder.checkPermissions?.();
      if (perm && perm.microphone !== 'granted') {
        const req = await this._recorder.requestPermissions?.();
        if (req && req.microphone !== 'granted') warnings.push('Microphone permission was not granted.');
      }
    } catch (_) {
      /* older shell without checkPermissions */
    }

    if (this.platform === 'android') {
      try {
        const s = await this._recorder.isBatteryOptimizationExempt?.();
        if (s && s.exempt === false) {
          warnings.push('Battery optimisation is on for SleepSensor — Android may kill recording. Tap to disable it.');
        }
      } catch (_) {
        /* optional */
      }
    }

    const bat = await this.getBattery();
    if (bat && bat.level != null && bat.level < 0.5 && !bat.charging) {
      warnings.push('Battery is below 50% and not charging — plug in for all-night monitoring.');
    }
    return { ok: true, native: true, battery: bat, charging: bat?.charging, warnings };
  }

  /** Enter background-recording mode. Call right after the audio graph starts. */
  async beginSession({ title = 'SleepSensor', text = 'Monitoring your sleep…' } = {}) {
    if (!this.supported) return false;
    try {
      await this._recorder.start({ title, text });
      this._active = true;
      return true;
    } catch (err) {
      console.warn('[NativeBridge] beginSession failed:', err?.message || err);
      return false;
    }
  }

  /** Update the ongoing notification (e.g. elapsed time, event counts). */
  async updateNotification(text) {
    if (!this.supported || !this._active) return;
    try {
      await this._recorder.update?.({ text });
    } catch (_) {
      /* non-fatal */
    }
  }

  /** Leave background-recording mode. */
  async endSession() {
    if (!this.supported || !this._active) return;
    this._active = false;
    try {
      await this._recorder.stop();
    } catch (err) {
      console.warn('[NativeBridge] endSession failed:', err?.message || err);
    }
  }

  async requestIgnoreBatteryOptimizations() {
    if (this.platform !== 'android' || !this._recorder) return false;
    try {
      const r = await this._recorder.requestBatteryOptimizationExemption?.();
      return !!(r && r.exempt);
    } catch (_) {
      return false;
    }
  }

  async getBattery() {
    // native first
    if (this._device && this._device.getBatteryInfo) {
      try {
        const b = await this._device.getBatteryInfo();
        return { level: b.batteryLevel, charging: b.isCharging };
      } catch (_) {
        /* fall through */
      }
    }
    // web fallback (Android Chrome)
    try {
      if (typeof navigator !== 'undefined' && navigator.getBattery) {
        const b = await navigator.getBattery();
        return { level: b.level, charging: b.charging };
      }
    } catch (_) {
      /* not available */
    }
    return null;
  }

  // ---- events ---------------------------------------------------------
  /**
   * @param {object} cb
   *   onInterruptionBegan()  audio interrupted (call / alarm / other app)
   *   onInterruptionEnded()  interruption over — safe to resume
   *   onRouteChange({reason}) headphones / bluetooth changed
   *   onAppState({isActive}) foreground <-> background
   *   onResume()             app brought back to foreground
   *   onLowMemory()          (android) system is low on memory
   */
  on(cb = {}) {
    const add = (obj, ev, fn) => {
      if (!obj || !fn) return;
      try {
        const h = obj.addListener(ev, fn);
        this._listeners.push(h);
      } catch (_) {
        /* plugin without this event */
      }
    };
    add(this._recorder, 'interruptionBegan', () => cb.onInterruptionBegan?.());
    add(this._recorder, 'interruptionEnded', () => cb.onInterruptionEnded?.());
    add(this._recorder, 'routeChange', (e) => cb.onRouteChange?.(e || {}));
    add(this._recorder, 'lowMemory', () => cb.onLowMemory?.());
    add(this._app, 'appStateChange', (s) => {
      cb.onAppState?.(s || {});
      if (s && s.isActive) cb.onResume?.();
    });
    add(this._app, 'resume', () => cb.onResume?.());
  }

  async dispose() {
    for (const h of this._listeners) {
      try {
        (await h)?.remove?.();
      } catch (_) {
        /* ignore */
      }
    }
    this._listeners = [];
  }
}

export const nativeBridge = new NativeBridge();
export default NativeBridge;
