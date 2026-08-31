/*
 * wake-lock.js — SleepSensor
 *
 * Thin wrapper around the Screen Wake Lock API. Keeps the device awake while a
 * recording session is running. The OS still dims the screen; it just won't
 * fully sleep and suspend the audio pipeline. Re-acquires automatically when
 * the tab becomes visible again (the lock is dropped whenever the page is
 * hidden). Degrades silently on browsers without the API (notably iOS < 16.4).
 */

export class WakeLock {
  constructor() {
    this._sentinel = null;
    this._active = false;
    this._wantLock = false;
    this._supported =
      typeof navigator !== 'undefined' && 'wakeLock' in navigator;
    this._onVisibility = this._handleVisibility.bind(this);
  }

  isSupported() {
    return this._supported;
  }

  isActive() {
    return this._active;
  }

  async acquire() {
    this._wantLock = true;
    if (!this._supported) {
      console.warn('[WakeLock] Screen Wake Lock API not supported — screen may sleep.');
      return false;
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
    }
    return this._request();
  }

  async release() {
    this._wantLock = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
    if (this._sentinel) {
      try {
        await this._sentinel.release();
      } catch (_) {
        /* already released */
      }
      this._sentinel = null;
    }
    this._active = false;
  }

  async _request() {
    if (!this._supported || !this._wantLock) return false;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      // can't hold a lock while hidden; will retry on visibilitychange
      return false;
    }
    try {
      this._sentinel = await navigator.wakeLock.request('screen');
      this._active = true;
      this._sentinel.addEventListener('release', () => {
        this._active = false;
        this._sentinel = null;
      });
      return true;
    } catch (err) {
      this._active = false;
      console.warn('[WakeLock] request failed:', err && err.message ? err.message : err);
      return false;
    }
  }

  _handleVisibility() {
    if (
      this._wantLock &&
      !this._active &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible'
    ) {
      this._request();
    }
  }
}

export default WakeLock;
