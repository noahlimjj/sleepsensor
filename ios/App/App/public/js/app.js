/* ============================================================
   SleepSensor — Main App Controller
   Handles screen routing, UI state, and wires everything together
   ============================================================ */

import { formatDuration, formatTimer, formatTime, formatDate, formatBytes, toDateKey, getMonthAbbr, getDayOfMonth, throttle, toPercent, roundRectPath } from './utils.js';
import { Timeline } from './timeline.js';
import { ApneaDetector } from './apnea-detector.js';
import { DonutChart, TrendChart } from './charts.js';
import { SessionRecovery } from './session-recovery.js';
import { authManager } from './auth.js';
import { SyncManager } from './sync.js';
import { getFirebase } from './firebase.js';
import { bedtimeReminder, parseTime } from './bedtime-reminder.js';

// loudness wording for a generic sound event: A-weighted when available
function loudnessLabel(event) {
  if (typeof event.peakDbA === 'number') {
    const d = Math.round(event.peakDbA);
    const word = d >= 70 ? 'Very loud' : d >= 55 ? 'Loud' : d >= 40 ? 'Moderate' : 'Soft';
    return `${word} · ${d} dBA`;
  }
  const d = event.peakDb ?? -30;
  return d > -6 ? 'Very loud' : d > -18 ? 'Loud' : 'Moderate';
}

class App {
  constructor() {
    // Engine modules (loaded dynamically)
    this.engine = null;
    this.storage = null;
    this.classifier = null;

    // UI state
    this.currentScreen = 'record';
    this.isRecording = false;
    this.snoringCount = 0;
    this.bruxismCount = 0;
    this.noiseCount = 0;
    this.elapsedInterval = null;
    this.startTime = null;
    this.currentSessionId = null;

    // Charts
    this.timeline = null;
    this.donutChart = null;
    this.trendChart = null;

    // Accounts / cloud sync (no-op unless firebase-config.js is filled in)
    this.auth = authManager;
    this.sync = null;

    // Audio playback
    this.currentAudio = null;
    this.currentPlayBtn = null;

    // Waveform animation
    this.waveformData = new Float32Array(128).fill(0);
    this.waveformAnimId = null;
  }

  async init() {
    try {
      // Load backend modules
      const [
        { Storage },
        { Classifier },
        { AudioEngine },
      ] = await Promise.all([
        import('./storage.js'),
        import('./classifier.js'),
        import('./audio-engine.js'),
      ]);

      // Initialize storage
      this.storage = new Storage();
      await this.storage.init();

      // Accounts: if Firebase is configured, make sure we have a user (guest or
      // real) before showing the app. No-op in local-only builds.
      await this._setupAccounts();

      // Initialize classifier
      this.classifier = new Classifier();
      await this.classifier.load();

      // Finalise any session left open by a crash / OS kill / dead battery
      try {
        const recovered = await new SessionRecovery(this.storage).recoverStale();
        if (recovered.length) {
          this._banner(
            `Last night's recording ended early — we saved what was captured (${recovered.length} session${recovered.length > 1 ? 's' : ''}).`,
            { autoHideMs: 12000 }
          );
        }
      } catch (e) {
        console.warn('recovery check failed:', e);
      }

      // Initialize audio engine
      this.engine = new AudioEngine({
        classifier: this.classifier,
        storage: this.storage,
        onEnergy: throttle((rms) => this._onEnergy(rms), 16),
        onEvent: (event) => this._onEvent(event),
        onStatusChange: (status, info, extra) => this._onStatusChange(status, info, extra),
      });

      // Bind UI events
      this._bindNavigation();
      this._bindRecordButton();
      this._bindSettings();

      // Show app
      this._hideSplash();

      // Load latest report + history (charts self-guard until their screen shows)
      await this._loadLatestReport();
      this._loadHistory();
      this._updateStorageUsage();

      // restore the dB calibration
      try {
        const cal = await this.storage.getSetting('dbCalibration', null);
        if (cal && typeof cal.offset === 'number') this.engine.setDbCalibration(cal.offset, cal.calibrated);
      } catch (_) { /* default offset */ }
      this._syncDbCalibration();

      // restore the saved mic sensitivity
      try {
        // 'sensitivityV2' replaced 'sensitivity' when detection became
        // floor-relative; old saves were almost always the old 0.5 default,
        // so lift them to the new default once
        let saved = await this.storage.getSetting('sensitivityV2', null);
        if (saved == null) saved = Math.max(await this.storage.getSetting('sensitivity', 0.7), 0.7);
        const slider = document.getElementById('setting-sensitivity');
        if (slider) slider.value = Math.round(saved * 100);
        this.engine.setSensitivity(saved);
      } catch (_) { /* defaults are fine */ }
      this._syncSensitivityLabel();
      this._updateAccountUI();
      await this._initBedtimeReminder();

      // pull fresh cloud data whenever the app comes back to the foreground
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.sync && !this.isRecording) {
          this.sync.sync().then(() => {
            this._loadHistory();
            if (this.currentSessionId) this._loadReport(this.currentSessionId);
          }).catch(() => {});
        }
      });

    } catch (err) {
      console.error('App init failed:', err);
      const sub = document.querySelector('.splash-subtitle');
      if (sub) sub.textContent = 'Failed to initialize. Please refresh.';
      const app = document.getElementById('app');
      if (app && app.hasAttribute('hidden')) app.removeAttribute('hidden');
    }
  }

  // ========== ACCOUNTS / SYNC ==========

  async _setupAccounts() {
    try {
      await this.auth.init();
    } catch (e) {
      console.warn('[app] auth init failed:', e);
      return;
    }
    if (!this.auth.available) return; // local-only build — implicit guest

    this._bindAuthScreen();

    // wait for a user (guest or real); show the auth screen if none
    if (!this.auth.user) {
      const screen = document.getElementById('auth-screen');
      if (screen) screen.removeAttribute('hidden');
      // also lift the splash so the auth screen is visible
      document.getElementById('splash-screen')?.classList.add('hidden');
      await new Promise((resolve) => {
        const off = this.auth.onChange(({ user }) => {
          if (user) {
            off();
            resolve();
          }
        });
      });
      if (screen) screen.setAttribute('hidden', '');
    }

    await this._startSync();

    // keep sync + settings UI in step with account changes
    this.auth.onChange(async ({ user }) => {
      this._updateAccountUI();
      if (user && (!this.sync || this.sync.uid !== user.uid)) {
        await this._startSync();
        this._loadHistory();
        this._loadLatestReport();
      } else if (!user) {
        this.sync?.detach();
        this.sync = null;
        this._updateAccountUI();
      }
    });
  }

  async _startSync() {
    if (!this.auth.uid) return;
    try {
      const fb = await getFirebase();
      if (!fb) return;
      this.sync = new SyncManager(this.storage);
      this._bindSyncStatus();
      await this.sync.attach(fb, this.auth.uid);
    } catch (e) {
      console.warn('[app] sync attach failed:', e);
    }
  }

  _bindSyncStatus() {
    if (this._syncStatusBound) return;
    this._syncStatusBound = true;
    this.sync.onStatus((s) => {
      const el = document.getElementById('sync-status');
      if (!el) return;
      el.textContent = {
        syncing: 'Syncing…',
        synced: 'Synced to your account',
        offline: 'Offline — will sync later',
        error: 'Sync error — will retry',
        idle: '',
      }[s] || '';
    });
  }

  _bindAuthScreen() {
    if (this._authBound) return;
    this._authBound = true;
    const m = this.auth.methods;
    const showIf = (id, on) => document.getElementById(id)?.toggleAttribute('hidden', !on);
    showIf('auth-guest', m.guest);
    showIf('auth-google', m.google);
    showIf('auth-apple', m.apple);
    showIf('auth-email-toggle', m.email);

    const err = (msg) => {
      const e = document.getElementById('auth-error');
      if (e) {
        e.textContent = msg;
        e.hidden = !msg;
      }
    };
    const run = async (fn) => {
      err('');
      try {
        await fn();
      } catch (e) {
        err(this._authErrorText(e));
      }
    };

    document.getElementById('auth-guest')?.addEventListener('click', () => run(() => this.auth.signInGuest()));
    document.getElementById('auth-google')?.addEventListener('click', () => run(() => this.auth.signInGoogle()));
    document.getElementById('auth-apple')?.addEventListener('click', () => run(() => this.auth.signInApple()));

    const form = document.getElementById('auth-email-form');
    document.getElementById('auth-email-toggle')?.addEventListener('click', () => {
      form?.toggleAttribute('hidden');
    });
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.getElementById('auth-email').value.trim();
      const pw = document.getElementById('auth-password').value;
      const mode = form.dataset.mode || 'signin';
      run(() => (mode === 'signup' ? this.auth.signUpEmail(email, pw) : this.auth.signInEmail(email, pw)));
    });
    document.getElementById('auth-switch-mode')?.addEventListener('click', () => {
      const signup = (form.dataset.mode || 'signin') === 'signin';
      form.dataset.mode = signup ? 'signup' : 'signin';
      document.getElementById('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
      document.getElementById('auth-switch-mode').textContent = signup
        ? 'Have an account? Sign in'
        : 'New here? Create an account';
    });
    document.getElementById('auth-reset')?.addEventListener('click', () =>
      run(async () => {
        const email = document.getElementById('auth-email').value.trim();
        if (!email) throw new Error('Enter your email first.');
        await this.auth.sendPasswordReset(email);
        err('Password reset email sent.');
      })
    );
  }

  _authErrorText(e) {
    const code = e && e.code;
    const map = {
      'auth/invalid-email': 'That email address looks invalid.',
      'auth/missing-password': 'Enter a password.',
      'auth/weak-password': 'Password should be at least 6 characters.',
      'auth/email-already-in-use': 'That email already has an account — try signing in.',
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/wrong-password': 'Wrong email or password.',
      'auth/user-not-found': 'No account for that email.',
      'auth/too-many-requests': 'Too many attempts — wait a minute and try again.',
      'auth/popup-closed-by-user': 'Sign-in was cancelled.',
      'auth/network-request-failed': 'Network error — check your connection.',
    };
    return map[code] || (e && e.message) || 'Something went wrong.';
  }

  _updateAccountUI() {
    // privacy copy depends on whether cloud sync is active
    const priv = document.getElementById('about-privacy');
    if (priv) {
      priv.textContent = this.auth.available
        ? 'Audio is recorded and analysed on your device — clips never leave your phone. Your sleep stats sync to your account.'
        : 'Audio is recorded and analysed entirely on your device. Nothing is ever uploaded.';
    }
    const nameEl = document.getElementById('account-name');
    const statusEl = document.getElementById('account-status');
    const signInBtn = document.getElementById('account-signin-btn');
    const signOutBtn = document.getElementById('account-signout-btn');
    const section = document.getElementById('account-section');
    if (!section) return;

    section.hidden = !this.auth.available;
    if (!this.auth.available) return;

    if (this.auth.signedIn) {
      if (nameEl) nameEl.textContent = this.auth.displayName;
      if (statusEl) statusEl.textContent = this.auth.email || 'Signed in';
      signInBtn && (signInBtn.hidden = true);
      signOutBtn && (signOutBtn.hidden = false);
    } else if (this.auth.isGuest) {
      if (nameEl) nameEl.textContent = 'Guest';
      if (statusEl) statusEl.textContent = 'Sign in to keep your data and sync across devices';
      signInBtn && (signInBtn.hidden = false);
      signOutBtn && (signOutBtn.hidden = true);
    } else {
      if (nameEl) nameEl.textContent = 'Not signed in';
      if (statusEl) statusEl.textContent = '';
      signInBtn && (signInBtn.hidden = false);
      signOutBtn && (signOutBtn.hidden = true);
    }
  }

  _bindNavigation() {
    const nav = document.getElementById('bottom-nav');
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-btn');
      if (!btn) return;
      const screen = btn.dataset.screen;
      if (screen) this._showScreen(screen);
    });

    // Sample night button on empty report screen
    document.getElementById('report-load-sample-btn')?.addEventListener('click', () => {
      this._loadSampleSession();
    });
  }

  _showScreen(name) {
    this.currentScreen = name;

    // Update nav
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.screen === name);
    });

    // Update screens
    document.querySelectorAll('.screen').forEach(screen => {
      screen.classList.toggle('active', screen.id === `screen-${name}`);
    });

    // Trigger lazy loads + re-render canvases now that the screen has a size
    if (name === 'history') this._loadHistory();
    if (name === 'settings') {
      this._updateStorageUsage();
      this._updateAccountUI();
    }
    if (name === 'report' && this.currentSessionId) {
      requestAnimationFrame(() => this._loadReport(this.currentSessionId));
    }
  }

  _banner(text, { autoHideMs = 0 } = {}) {
    const banner = document.getElementById('status-banner');
    const t = document.getElementById('status-banner-text');
    if (!banner || !t) return;
    t.textContent = text;
    banner.removeAttribute('hidden');
    banner.setAttribute('role', 'status');
    banner.title = 'Tap to dismiss';
    banner.onclick = () => banner.setAttribute('hidden', '');
    clearTimeout(this._bannerTimeout);
    if (autoHideMs) this._bannerTimeout = setTimeout(() => banner.setAttribute('hidden', ''), autoHideMs);
  }

  _hideSplash() {
    const splash = document.getElementById('splash-screen');
    const app = document.getElementById('app');
    splash.classList.add('hidden');
    app.removeAttribute('hidden');
    // Remove splash from DOM after animation
    setTimeout(() => splash.remove(), 600);
  }

  // ========== RECORDING ==========

  _bindRecordButton() {
    const btn = document.getElementById('record-btn');
    btn.addEventListener('click', () => {
      if (this.isRecording) {
        this._stopRecording();
      } else {
        this._startRecording();
      }
    });
  }

  async _startRecording() {
    if (this.isRecording || !this.engine) return;

    try {
      await this.engine.start();
      this.isRecording = true;
      this.snoringCount = 0;
      this.bruxismCount = 0;
      this.noiseCount = 0;
      this.startTime = Date.now();

      // Update UI
      document.getElementById('app').classList.add('recording');
      document.getElementById('record-btn-label').textContent = 'Tap to stop monitoring';
      const recBtn = document.getElementById('record-btn');
      recBtn.setAttribute('aria-label', 'Stop monitoring');
      recBtn.setAttribute('aria-pressed', 'true');
      document.querySelector('.record-btn-icon--mic').setAttribute('hidden', '');
      document.querySelector('.record-btn-icon--stop').removeAttribute('hidden');
      document.getElementById('waveform-overlay').classList.add('hidden');
      document.getElementById('status-banner').setAttribute('hidden', '');
      document.getElementById('live-db-meter').removeAttribute('hidden');

      const guidance = document.getElementById('background-guidance');
      const g = this.engine.backgroundGuidance();
      guidance.textContent = g && g.text ? g.text : '';
      guidance.hidden = !guidance.textContent;

      // Reset stats
      document.getElementById('stat-snoring-count').textContent = '0';
      document.getElementById('stat-bruxism-count').textContent = '0';
      document.getElementById('stat-noise-count').textContent = '0';
      document.getElementById('stat-elapsed').textContent = '00:00:00';

      // Start elapsed timer
      this.elapsedInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        document.getElementById('stat-elapsed').textContent = formatTimer(elapsed);
      }, 1000);

      // Start waveform animation
      this._startWaveformAnimation();

    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  }

  async _stopRecording() {
    if (!this.isRecording || !this.engine) return;

    try {
      const summary = await this.engine.stop();
      this.isRecording = false;
      const prevSessionId = this.currentSessionId;
      this.currentSessionId = summary ? summary.sessionId : this.currentSessionId;

      // Update UI
      document.getElementById('app').classList.remove('recording');
      document.getElementById('record-btn-label').textContent = 'Tap to start monitoring';
      const recBtn = document.getElementById('record-btn');
      recBtn.setAttribute('aria-label', 'Start monitoring');
      recBtn.setAttribute('aria-pressed', 'false');
      document.querySelector('.record-btn-icon--mic').removeAttribute('hidden');
      document.querySelector('.record-btn-icon--stop').setAttribute('hidden', '');
      document.getElementById('waveform-overlay').classList.remove('hidden');
      document.getElementById('live-db-meter').setAttribute('hidden', '');
      document.getElementById('background-guidance').setAttribute('hidden', '');
      document.getElementById('status-banner').setAttribute('hidden', '');

      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
      this._stopWaveformAnimation();

      if (summary && summary.stopReason && summary.stopReason !== 'user') {
        const why =
          summary.stopReason === 'max-duration'
            ? 'Recording auto-stopped after 14 hours.'
            : summary.stopReason === 'storage-full'
            ? 'Recording stopped — device storage is full. Everything captured was saved.'
            : `Recording stopped (${summary.stopReason}).`;
        this._banner(why, { autoHideMs: 15000 });
      }

      // an accidental tap-and-stop shouldn't become a "night" with an Optimal report
      if (summary && summary.sessionId && summary.stopReason === 'user' && Date.now() - summary.startTime < (window.__ssMinSessionMs ?? 60000)) {
        await this.storage.deleteSession(summary.sessionId).catch(() => {});
        this.currentSessionId = prevSessionId === summary.sessionId ? null : prevSessionId;
        this._banner('Not saved: that was under a minute. Start monitoring at bedtime and stop it when you wake up.', { autoHideMs: 8000 });
        return;
      }

      // show the report screen first (so canvases have a size), then fill it
      if (this.currentSessionId) {
        this._showScreen('report');
        await this._loadReport(this.currentSessionId);
      }

      // push this night's stats to the user's account (audio clips stay local)
      if (this.sync && summary && summary.sessionId) {
        this.sync.pushSession(summary.sessionId).catch(() => {});
      }
    } catch (err) {
      console.error('Failed to stop recording:', err);
    }
  }

  // ========== WAVEFORM ==========

  _onEnergy(rms) {
    // Shift waveform data left and push new value
    this.waveformData.copyWithin(0, 1);
    this.waveformData[this.waveformData.length - 1] = rms;
  }

  _startWaveformAnimation() {
    const canvas = document.getElementById('waveform-canvas');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.parentElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0); // reset — scale() is not idempotent
      ctx.scale(dpr, dpr);
    };
    resize();
    this._waveformResize = resize;
    window.addEventListener('resize', resize);

    const draw = () => {
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      const data = this.waveformData;
      const barCount = data.length;
      const barWidth = w / barCount;
      const centerY = h / 2;

      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;

      // Center line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(w, centerY);
      ctx.stroke();

      // Bars
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      for (let i = 0; i < barCount; i++) {
        const amplitude = Math.min(data[i] * 8, 1);
        const barH = Math.max(2, amplitude * (h * 0.4));
        ctx.beginPath();
        if (roundRectPath(ctx, i * barWidth + 1, centerY - barH, Math.max(1, barWidth - 2), barH * 2, 3)) {
          ctx.fill();
        }
      }

      if (this.engine) {
        const level = this.engine.getLevel();
        const el = document.getElementById('db-value');
        if (el && level) {
          el.textContent = `${level.calibrated ? '' : '~'}${level.dbA} dBA`;
          el.title = `${Math.max(-99, Math.round(level.dbFS))} dBFS${level.calibrated ? '' : ' · uncalibrated estimate'}`;
        }
      }

      this.waveformAnimId = requestAnimationFrame(draw);
    };

    draw();
  }

  _stopWaveformAnimation() {
    if (this.waveformAnimId) {
      cancelAnimationFrame(this.waveformAnimId);
      this.waveformAnimId = null;
    }
    if (this._waveformResize) {
      window.removeEventListener('resize', this._waveformResize);
      this._waveformResize = null;
    }
    this.waveformData.fill(0);
  }

  // ========== EVENTS ==========

  _onEvent(event) {
    // a sound first logged as generic noise, now recognised as snoring/grinding
    if (event.upgradedFrom === 'noise' && this.noiseCount > 0) {
      this.noiseCount--;
      document.getElementById('stat-noise-count').textContent = this.noiseCount;
    }
    if (event.type === 'snoring') {
      this.snoringCount++;
      document.getElementById('stat-snoring-count').textContent = this.snoringCount;
    } else if (event.type === 'bruxism') {
      this.bruxismCount++;
      document.getElementById('stat-bruxism-count').textContent = this.bruxismCount;
    } else if (event.type === 'noise') {
      this.noiseCount++;
      document.getElementById('stat-noise-count').textContent = this.noiseCount;
    }
    this._showToast(event);
  }

  _showToast(event) {
    const toast = document.getElementById('event-toast');
    const typeEl = document.getElementById('toast-type');
    const confEl = document.getElementById('toast-confidence');
    const iconEl = toast.querySelector('.event-toast-icon');

    // Set content
    if (event.type === 'snoring') {
      typeEl.textContent = 'Snoring detected';
      iconEl.textContent = '😴';
    } else if (event.type === 'bruxism') {
      typeEl.textContent = 'Grinding detected';
      iconEl.textContent = '😬';
    } else if (event.type === 'noise') {
      typeEl.textContent = 'Noise detected';
      iconEl.textContent = '🔊';
    } else if (event.type === 'apnea') {
      typeEl.textContent = 'Breathing pause';
      iconEl.textContent = '🫁';
    }

    if (event.type === 'apnea') {
      confEl.textContent = `${Math.round(event.duration || 0)}s, then ${event.arousal === 'gasp' ? 'a gasp' : 'a snort'}`;
    } else if (event.type === 'noise') {
      confEl.textContent = loudnessLabel(event);
    } else {
      confEl.textContent = `${Math.round((event.confidence || 0) * 100)}% sure`;
    }

    // Set style
    toast.className = `event-toast toast--${event.type || 'noise'}`;
    toast.removeAttribute('hidden');

    // Animate in
    requestAnimationFrame(() => toast.classList.add('visible'));

    // Hide after 3s — clear BOTH timers so a fresh toast is never yanked away
    clearTimeout(this._toastTimeout);
    clearTimeout(this._toastHideTimeout);
    this._toastTimeout = setTimeout(() => {
      toast.classList.remove('visible');
      this._toastHideTimeout = setTimeout(() => {
        if (!toast.classList.contains('visible')) toast.setAttribute('hidden', '');
      }, 300);
    }, 3000);
  }

  _onStatusChange(status, info, extra) {
    const label = document.getElementById('record-btn-label');
    const banner = document.getElementById('status-banner');
    const hideBanner = () => banner && banner.setAttribute('hidden', '');

    if (status === 'error') {
      if (label) label.textContent = 'Microphone unavailable';
      this._banner(info || 'Could not access the microphone.');
      this.isRecording = false;
      document.getElementById('app').classList.remove('recording');
      document.querySelector('.record-btn-icon--mic')?.removeAttribute('hidden');
      document.querySelector('.record-btn-icon--stop')?.setAttribute('hidden', '');
      const recBtn = document.getElementById('record-btn');
      recBtn?.setAttribute('aria-label', 'Start monitoring');
      recBtn?.setAttribute('aria-pressed', 'false');
    } else if (status === 'requesting') {
      if (label) label.textContent = 'Requesting microphone access…';
    } else if (status === 'interrupted') {
      this._banner(info || 'Audio interrupted — it will resume automatically.');
    } else if (status === 'stalled') {
      this._banner(info || 'Audio stalled — keep the app open.', { autoHideMs: 8000 });
    } else if (status === 'recording') {
      if (label) label.textContent = 'Tap to stop monitoring';
      const warnings = (extra && extra.warnings) || [];
      if (warnings.length) this._banner(warnings[0], { autoHideMs: 20000 });
      else hideBanner();
    } else if (status === 'idle') {
      hideBanner();
    }
  }

  // ========== REPORT ==========

  async _loadLatestReport() {
    if (!this.storage) return;
    const sessions = await this.storage.getRecentSessions(1);
    if (sessions.length > 0 && sessions[0].endTime) {
      this.currentSessionId = sessions[0].id;
      await this._loadReport(sessions[0].id);
    }
  }

  async _loadReport(sessionId) {
    if (!this.storage) return;

    const session = await this.storage.getSession(sessionId);
    if (!session || !session.endTime) {
      document.getElementById('report-empty').removeAttribute('hidden');
      document.getElementById('report-content').setAttribute('hidden', '');
      return;
    }

    document.getElementById('report-empty').setAttribute('hidden', '');
    document.getElementById('report-content').removeAttribute('hidden');

    // Date (+ note if this night was recovered after a crash)
    document.getElementById('report-date').textContent =
      formatDate(session.startTime) + (session.recovered ? ' · ended unexpectedly' : '');

    // Summary cards
    const totalSleep = session.totalDuration || ((session.endTime - session.startTime) / 1000);
    document.getElementById('report-sleep-time').textContent = formatDuration(totalSleep);
    document.getElementById('report-snoring-time').textContent = formatDuration(session.snoringDuration || 0);
    document.getElementById('report-bruxism-time').textContent = formatDuration(session.bruxismDuration || 0);
    document.getElementById('report-snoring-pct').textContent = toPercent(session.snoringDuration || 0, totalSleep);
    document.getElementById('report-bruxism-pct').textContent = toPercent(session.bruxismDuration || 0, totalSleep);
    document.getElementById('report-noise-count').textContent = String(session.noiseEpisodes || 0);
    document.getElementById('report-loudest').textContent =
      typeof session.loudestDbA === 'number'
        ? `${session.dbCalibrated ? '' : '~'}${Math.round(session.loudestDbA)} dBA peak` +
          (typeof session.laeqDbA === 'number' ? ` · ${Math.round(session.laeqDbA)} avg` : '')
        : typeof session.loudestDb === 'number'
          ? `peak ${Math.round(session.loudestDb)} dBFS`
          : '';

    // Timeline
    const events = await this.storage.getEventsBySession(sessionId);
    if (!this.timeline) {
      this.timeline = new Timeline(document.getElementById('timeline-canvas'));
    }
    this.timeline.render(session, events);

    // Breathing pauses (estimated AHI) and their link to grinding
    this._renderBreathing(ApneaDetector.calculateAhiMetrics(events, totalSleep));

    // Severity breakdown (snoring / grinding / noise intensity — pauses have their own card)
    this._renderSeverityBars(events.filter((e) => e.type !== 'apnea'));

    // Event audio clips (highlight clips are shown in the Loudest Moments section)
    const clips = await this.storage.getClipsBySessionType(sessionId, 'event');
    this._renderClips(clips, events);

    // Loudest moments
    const highlights = await this.storage.getHighlightsBySession(sessionId);
    const highlightClips = await this.storage.getClipsBySessionType(sessionId, 'highlight');
    this._renderHighlights(highlights, highlightClips);
  }

  _renderBreathing(m) {
    document.getElementById('report-ahi').textContent = String(m.estimatedAhi);
    document.getElementById('report-ahi-sub').textContent =
      `${m.severityLabel} · ${m.apneaEvents} pause${m.apneaEvents === 1 ? '' : 's'}` +
      (m.apneaEvents ? ` · longest ${Math.round(m.longestPauseSec)}s` : '');
    const list = document.getElementById('respiratory-insights');
    list.innerHTML = '';
    for (const line of ApneaDetector.describeMetrics(m)) {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }
  }

  _renderHighlights(highlights, clips) {
    const container = document.getElementById('highlights-carousel');
    const emptyEl = document.getElementById('highlights-empty');

    if (!highlights || highlights.length === 0) {
      container.innerHTML = '';
      emptyEl.removeAttribute('hidden');
      return;
    }

    emptyEl.setAttribute('hidden', '');

    // Map clips by event ID
    const clipMap = new Map(clips.map(c => [c.eventId, c]));

    container.innerHTML = highlights.map(h => {
      const clip = clipMap.get(h.id);
      const time = formatTime(h.timestamp);
      const label =
        { snoring: 'Snoring', bruxism: 'Grinding', noise: 'Noise', unknown: 'Unknown sound' }[
          h.classifiedAs
        ] || 'Sound';
      const db = typeof h.db === 'number' ? `${Math.round(h.db)} dB` : '';

      return `
        <div class="highlight-card">
          <div class="highlight-header">
            <span class="highlight-type">${label}</span>
            ${db ? `<span class="highlight-db">${db}</span>` : ''}
          </div>
          <span class="highlight-meta">${time}</span>
          ${clip ? `
          <button class="clip-play-btn" style="margin-top:auto; align-self:flex-start;" data-clip-id="${clip.id}" aria-label="Play highlight">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <polygon points="6,4 20,12 6,20"/>
            </svg>
          </button>` : ''}
        </div>
      `;
    }).join('');

    container.querySelectorAll('.clip-play-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._playClip(btn.dataset.clipId, btn);
      });
    });
  }

  _renderSeverityBars(events) {
    const container = document.getElementById('severity-bars');
    const counts = { mild: 0, moderate: 0, severe: 0 };
    for (const e of events) {
      if (counts[e.severity] !== undefined) counts[e.severity]++;
    }
    const total = events.length || 1;

    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    container.innerHTML = ['mild', 'moderate', 'severe'].map(sev => {
      const pct = Math.max(0, Math.min(100, (counts[sev] / total) * 100));
      return `
      <div class="severity-bar-row">
        <span class="severity-bar-label">${cap(sev)}</span>
        <div class="severity-bar-track">
          <div class="severity-bar-fill severity-bar-fill--${sev}" style="width: ${pct}%"></div>
        </div>
        <span class="severity-bar-value">${counts[sev]}</span>
      </div>`;
    }).join('');
  }

  _renderClips(clips, events) {
    const container = document.getElementById('clips-list');
    const emptyEl = document.getElementById('clips-empty');

    if (!clips || clips.length === 0) {
      container.innerHTML = '';
      emptyEl.removeAttribute('hidden');
      return;
    }

    emptyEl.setAttribute('hidden', '');

    // Map events by ID for lookup
    const eventMap = new Map(events.map(e => [e.id, e]));

    const labels = { snoring: 'Snoring', bruxism: 'Grinding', noise: 'Noise', apnea: 'Breathing pause' };
    const icons = { snoring: '😴', bruxism: '😬', noise: '🔊', apnea: '🫁' };

    container.innerHTML = clips.map(clip => {
      const event = eventMap.get(clip.eventId) || {};
      const type = event.type || 'noise';
      const icon = icons[type] || '🔊';
      const time = formatTime(clip.timestamp);
      const duration = clip.duration ? `${clip.duration.toFixed(1)}s` : '--';

      let meta = time;
      if (type === 'noise') {
        meta += ` · ${loudnessLabel(event)}`;
      } else if (type === 'apnea') {
        meta += ` · ${Math.round(event.duration || 0)}s pause`;
      } else if (typeof event.confidence === 'number') {
        meta += ` · ${Math.round(event.confidence * 100)}% sure`;
      }

      return `
        <div class="clip-card clip-card--${type}" data-clip-id="${clip.id}">
          <button class="clip-play-btn" data-clip-id="${clip.id}" aria-label="Play ${labels[type] || 'clip'} clip">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6,4 20,12 6,20"/>
            </svg>
          </button>
          <div class="clip-info">
            <div class="clip-type">${icon} ${labels[type] || 'Sound'}</div>
            <div class="clip-meta">${meta}</div>
          </div>
          <span class="clip-duration">${duration}</span>
        </div>
      `;
    }).join('');

    // Bind play buttons
    container.querySelectorAll('.clip-play-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._playClip(btn.dataset.clipId, btn);
      });
    });
  }

  _playIcon() {
    return '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
  }
  _pauseIcon() {
    return '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  }

  _stopCurrentClip() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.onended = null;
      if (this._currentUrl) URL.revokeObjectURL(this._currentUrl);
      this._currentUrl = null;
    }
    if (this.currentPlayBtn) this.currentPlayBtn.innerHTML = this._playIcon();
    this.currentAudio = null;
    this.currentPlayBtn = null;
  }

  async _playClip(clipId, btnEl) {
    if (!this.storage) return;
    const wasSame = this.currentPlayBtn === btnEl;
    this._stopCurrentClip();
    if (wasSame) return; // toggled off

    const clip = await this.storage.getClip(clipId);
    if (!clip || !clip.audioBlob) return;

    const url = URL.createObjectURL(clip.audioBlob);
    this._currentUrl = url;
    this.currentAudio = new Audio(url);
    this.currentPlayBtn = btnEl;
    btnEl.innerHTML = this._pauseIcon();

    this.currentAudio.onended = () => this._stopCurrentClip();
    this.currentAudio.onerror = () => this._stopCurrentClip();
    this.currentAudio.play().catch(() => this._stopCurrentClip());
  }

  // ========== HISTORY ==========

  async _loadHistory() {
    if (!this.storage) return;

    const sessions = await this.storage.getRecentSessions(30);

    // Trend chart
    if (!this.trendChart) {
      this.trendChart = new TrendChart(document.getElementById('trend-chart'));
    }
    this.trendChart.render(sessions);

    // Donut chart
    if (!this.donutChart) {
      this.donutChart = new DonutChart(document.getElementById('donut-chart'));
    }

    // Aggregate donut data
    let totalQuiet = 0, totalSnoring = 0, totalBruxism = 0, totalNoise = 0;
    for (const s of sessions) {
      const sleep = s.totalDuration || ((s.endTime - s.startTime) / 1000) || 0;
      totalSnoring += s.snoringDuration || 0;
      totalBruxism += s.bruxismDuration || 0;
      totalNoise += s.noiseDuration || 0;
      totalQuiet += Math.max(0, sleep - (s.snoringDuration || 0) - (s.bruxismDuration || 0) - (s.noiseDuration || 0));
    }
    this.donutChart.render({ quiet: totalQuiet, snoring: totalSnoring, bruxism: totalBruxism, noise: totalNoise });

    // Donut center
    document.querySelector('.donut-value').textContent = sessions.length;
    document.querySelector('.donut-label').textContent = sessions.length === 1 ? 'night' : 'nights';

    // Session list
    this._renderSessionList(sessions);
  }

  _renderSessionList(sessions) {
    const container = document.getElementById('session-list');
    const emptyEl = document.getElementById('history-empty');

    if (!sessions || sessions.length === 0) {
      container.innerHTML = '';
      emptyEl.removeAttribute('hidden');
      return;
    }

    emptyEl.setAttribute('hidden', '');

    container.innerHTML = sessions.map(s => {
      const day = getDayOfMonth(s.startTime);
      const month = getMonthAbbr(s.startTime);
      const timeRange = `${formatTime(s.startTime)} — ${s.endTime ? formatTime(s.endTime) : 'In progress'}`;
      const snoringMin = Math.round((s.snoringDuration || 0) / 60);
      const bruxismMin = Math.round((s.bruxismDuration || 0) / 60);
      const noiseMin = Math.round((s.noiseDuration || 0) / 60);

      return `
        <div class="session-item" data-session-id="${s.id}" role="button" tabindex="0">
          <div class="session-date-badge">
            <span class="session-date-day">${day}</span>
            <span class="session-date-month">${month}</span>
          </div>
          <div class="session-info">
            <div class="session-time">${timeRange}</div>
            <div class="session-stats">
              <span class="session-stat session-stat--snoring">
                <span class="session-stat-dot"></span>
                ${snoringMin}m snoring
              </span>
              <span class="session-stat session-stat--bruxism">
                <span class="session-stat-dot"></span>
                ${bruxismMin}m grinding
              </span>
              <span class="session-stat session-stat--noise">
                <span class="session-stat-dot"></span>
                ${noiseMin}m noise
              </span>
            </div>
          </div>
          <svg class="session-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      `;
    }).join('');

    // Bind click to open the report for that session
    container.querySelectorAll('.session-item').forEach(item => {
      const open = () => {
        this.currentSessionId = item.dataset.sessionId;
        this._showScreen('report'); // re-renders the report on the next frame
      };
      item.addEventListener('click', open);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  }

  // ========== SETTINGS ==========

  _syncSensitivityLabel() {
    const slider = document.getElementById('setting-sensitivity');
    if (!slider || !this.engine) return;
    const d = this.engine.describeSensitivity(slider.value / 100);
    document.getElementById('setting-sensitivity-desc').textContent = d.label;
    document.getElementById('setting-sensitivity-detail').textContent = d.detail;
  }

  _syncDbCalibration() {
    const status = document.getElementById('setting-db-status');
    if (!status || !this.engine) return;
    status.textContent = this.engine.dbCalibrated
      ? `Calibrated (offset ${this.engine.dbOffset.toFixed(1)} dB).`
      : 'Not calibrated: dB readings are estimates (±10 dB).';
    // live reading next to the calibration box
    clearInterval(this._dbLiveTimer);
    this._dbLiveTimer = setInterval(() => {
      const el = document.getElementById('setting-db-live');
      if (!el || !this.engine) return;
      if (!this.engine.isRecording()) {
        el.textContent = 'Phone now reads: -- dBA (start monitoring to see it)';
        return;
      }
      const lv = this.engine.getLevel();
      el.textContent = `Phone now reads: ${lv.calibrated ? '' : '~'}${lv.dbA} dBA`;
    }, 500);
  }

  _bindSettings() {
    // Sensitivity slider
    const slider = document.getElementById('setting-sensitivity');
    slider.addEventListener('input', () => {
      if (!this.engine) return;
      this.engine.setSensitivity(slider.value / 100);
      this._syncSensitivityLabel();
    });

    // dB calibration against a reference sound level meter
    document.getElementById('setting-db-calibrate')?.addEventListener('click', () => {
      if (!this.engine) return;
      const input = document.getElementById('setting-db-ref');
      const ref = parseFloat(input.value);
      const status = document.getElementById('setting-db-status');
      if (!Number.isFinite(ref) || ref < 20 || ref > 120) {
        status.textContent = 'Enter the meter reading in dBA (20–120).';
        return;
      }
      if (!this.engine.isRecording() || this.engine.calibrateTo(ref) == null) {
        status.textContent = 'Start monitoring first so the mic is listening, then calibrate.';
        return;
      }
      input.value = '';
      this._syncDbCalibration();
    });
    document.getElementById('setting-db-reset')?.addEventListener('click', () => {
      this.engine?.resetDbCalibration();
      this._syncDbCalibration();
    });

    // Sample Night loader (reviewer / testing feature)
    document.getElementById('setting-sample-btn')?.addEventListener('click', () => {
      this._loadSampleSession();
    });

    // Export
    document.getElementById('setting-export-btn').addEventListener('click', async () => {
      if (!this.storage) return;
      const btn = document.getElementById('setting-export-btn');
      btn.disabled = true;
      try {
        const sessions = await this.storage.getAllSessions();
        // include events + highlights per session (clips are large binaries — skip)
        const full = [];
        for (const s of sessions) {
          const [ev, hl] = await Promise.all([
            this.storage.getEventsBySession(s.id),
            this.storage.getHighlightsBySession(s.id),
          ]);
          full.push({ ...s, events: ev, highlights: hl });
        }
        const data = { app: 'SleepSensor', exportedAt: new Date().toISOString(), sessions: full };
        const fileName = `sleepsensor-export-${toDateKey(new Date())}.json`;
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });

        // iOS WKWebView does not download blob: URLs via <a> click.
        // Use Web Share API if supported.
        let shared = false;
        if (typeof navigator !== 'undefined' && navigator.canShare) {
          try {
            const file = new File([blob], fileName, { type: 'application/json' });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({
                title: 'SleepSensor Export',
                files: [file],
              });
              shared = true;
            }
          } catch (shareErr) {
            if (shareErr && shareErr.name === 'AbortError') return; // User cancelled share sheet
            console.warn('Native file share failed, falling back to download:', shareErr);
          }
        }

        if (!shared) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(url);
          }, 1500);
        }
      } catch (e) {
        console.warn('export failed:', e);
        this._banner('Export failed — try again.');
      } finally {
        btn.disabled = false;
      }
    });

    // Clear data
    document.getElementById('setting-clear-btn').addEventListener('click', () => {
      const synced = this.sync && this.auth.uid;
      this._showConfirm(
        'Clear All Data',
        synced
          ? 'This permanently deletes every sleep session, event and audio clip — on this device AND from your account. This cannot be undone.'
          : 'This permanently deletes all sleep sessions, events, and audio clips. This cannot be undone.',
        async () => {
          if (synced) {
            try {
              await this.sync.purgeRemote();
            } catch (e) {
              console.warn('purgeRemote failed:', e);
            }
          }
          await this.storage.clearAll();
          this.currentSessionId = null;
          this._stopCurrentClip();
          document.getElementById('report-empty').removeAttribute('hidden');
          document.getElementById('report-content').setAttribute('hidden', '');
          this._loadHistory();
          this._updateStorageUsage();
          this._banner('All data cleared.', { autoHideMs: 4000 });
        }
      );
    });

    // Account: sign in (guests) / sign out
    document.getElementById('account-signin-btn')?.addEventListener('click', () => {
      const screen = document.getElementById('auth-screen');
      if (screen) screen.removeAttribute('hidden');
    });
    document.getElementById('account-signout-btn')?.addEventListener('click', () => {
      this._showConfirm(
        'Sign Out',
        'Your synced data stays in your account. Sessions and clips on this device are kept until you clear them.',
        async () => {
          await this.auth.signOut();
          await this.auth.signInGuest().catch(() => {});
        }
      );
    });
    document.getElementById('auth-close')?.addEventListener('click', () => {
      // only allowed to dismiss once we already have a user
      if (this.auth.user) document.getElementById('auth-screen')?.setAttribute('hidden', '');
    });
  }

  async _updateStorageUsage() {
    if (!this.storage) return;
    try {
      const usage = await this.storage.getStorageUsage();
      const desc = document.getElementById('setting-storage-used');
      const parts = [`${usage.sessions} session${usage.sessions === 1 ? '' : 's'}`, `${usage.events} events`, `${usage.clips} clips`];
      if (usage.clips > 0) parts.push(formatBytes(usage.totalBytes || 0));
      desc.textContent = parts.join(' · ');
    } catch {
      document.getElementById('setting-storage-used').textContent = 'Unable to calculate';
    }
  }

  // ========== SAMPLE SESSION (REVIEWER / TEST FEATURE) ==========

  async _loadSampleSession() {
    if (!this.storage) return;
    try {
      this._banner('Loading sample sleep session…');
      const now = Date.now();
      const eightHoursAgo = now - 8 * 3600 * 1000;
      const sessionId = 'sample-' + Date.now();

      // Breathing pauses in snoring clusters (~6/h → "mild"). The 17600 cluster
      // ends just before the 18000 grinding episode to show the correlation.
      const apneaDefs = [];
      for (const [base, n] of [[4200, 8], [14400, 14], [17600, 7], [21600, 10], [25000, 6]]) {
        for (let i = 0; i < n; i++) {
          const dur = 12 + ((apneaDefs.length * 7) % 17);
          const start = eightHoursAgo + (base + i * 55) * 1000;
          apneaDefs.push({
            type: 'apnea',
            startTime: start,
            endTime: start + dur * 1000,
            duration: dur,
            confidence: 0.7 + ((apneaDefs.length * 3) % 25) / 100,
            severity: dur < 20 ? 'mild' : dur < 40 ? 'moderate' : 'severe',
            arousal: i % 3 === 2 ? 'gasp' : 'snort',
          });
        }
      }
      const ahi = ApneaDetector.calculateAhiMetrics(apneaDefs, 7.5 * 3600);

      // Sample session record
      const session = {
        id: sessionId,
        startTime: eightHoursAgo,
        endTime: now - 30 * 60 * 1000,
        totalDuration: 7.5 * 3600,
        snoringDuration: 38 * 60,
        bruxismDuration: 11 * 60,
        snoringEpisodes: 16,
        bruxismEpisodes: 5,
        noiseDuration: 8 * 60,
        noiseEpisodes: 7,
        snoringPercentage: 8.4,
        bruxismPercentage: 2.4,
        loudestDb: -14.2,
        loudestDbA: 71.5,
        laeqDbA: 34.8,
        apneaEvents: ahi.apneaEvents,
        apneaDuration: ahi.totalPauseSec,
        estimatedAhi: ahi.estimatedAhi,
        ahiSeverity: ahi.severity,
      };
      await this.storage.createSession(session);
      await this.storage.updateSession(sessionId, {
        endTime: session.endTime,
        totalDuration: session.totalDuration,
        snoringDuration: session.snoringDuration,
        bruxismDuration: session.bruxismDuration,
        snoringEpisodes: session.snoringEpisodes,
        bruxismEpisodes: session.bruxismEpisodes,
        noiseDuration: session.noiseDuration,
        noiseEpisodes: session.noiseEpisodes,
        snoringPercentage: session.snoringPercentage,
        bruxismPercentage: session.bruxismPercentage,
        loudestDb: session.loudestDb,
        loudestDbA: session.loudestDbA,
        laeqDbA: session.laeqDbA,
        apneaEvents: session.apneaEvents,
        apneaDuration: session.apneaDuration,
        estimatedAhi: session.estimatedAhi,
        ahiSeverity: session.ahiSeverity,
      });

      // Synthetic WAV generator helper
      const makeWavBlob = (freq = 180, duration = 1.8) => {
        const sampleRate = 22050;
        const numSamples = Math.floor(sampleRate * duration);
        const buf = new ArrayBuffer(44 + numSamples * 2);
        const view = new DataView(buf);
        view.setUint32(0, 0x52494646, false); // "RIFF"
        view.setUint32(4, 36 + numSamples * 2, true);
        view.setUint32(8, 0x57415645, false); // "WAVE"
        view.setUint32(12, 0x666d7420, false); // "fmt "
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, 1, true); // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        view.setUint32(36, 0x64617461, false); // "data"
        view.setUint32(40, numSamples * 2, true);
        for (let i = 0; i < numSamples; i++) {
          const t = i / sampleRate;
          const env = Math.sin((Math.PI * i) / numSamples);
          const sample = Math.sin(2 * Math.PI * freq * t) * 0.25 * env;
          view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, sample * 32767)), true);
        }
        return new Blob([buf], { type: 'audio/wav' });
      };

      // Add events spread across the session
      const sampleEvents = [
        { type: 'snoring', offsetSec: 2400, dur: 120, conf: 0.94, sev: 'mild' },
        { type: 'snoring', offsetSec: 4200, dur: 240, conf: 0.96, sev: 'moderate' },
        { type: 'bruxism', offsetSec: 7200, dur: 85, conf: 0.88, sev: 'moderate' },
        { type: 'noise', offsetSec: 10800, dur: 45, conf: 0.75, sev: 'mild', peakDb: -22 },
        { type: 'snoring', offsetSec: 14400, dur: 360, conf: 0.98, sev: 'severe' },
        { type: 'bruxism', offsetSec: 18000, dur: 140, conf: 0.91, sev: 'severe' },
        { type: 'snoring', offsetSec: 21600, dur: 180, conf: 0.92, sev: 'moderate' },
        { type: 'noise', offsetSec: 24000, dur: 30, conf: 0.80, sev: 'moderate', peakDb: -14 },
      ];

      for (const ev of sampleEvents) {
        const start = eightHoursAgo + ev.offsetSec * 1000;
        const end = start + ev.dur * 1000;
        const evRec = await this.storage.addEvent({
          sessionId,
          type: ev.type,
          startTime: start,
          endTime: end,
          duration: ev.dur,
          confidence: ev.conf,
          severity: ev.sev,
          timestamp: start,
          hasClip: true,
          peakDb: ev.peakDb ?? -20,
          peakDbA: Math.round((ev.peakDb ?? -20) + 86),
        });

        // Add playable audio clip for the event
        const clipBlob = makeWavBlob(ev.type === 'snoring' ? 140 : ev.type === 'bruxism' ? 520 : 300, 2.0);
        await this.storage.saveClip({
          sessionId,
          eventId: evRec.id,
          clipType: 'event',
          audioBlob: clipBlob,
          duration: 2.0,
          format: 'wav',
          timestamp: start,
        });
      }

      // Breathing pauses — the first two get playable clips
      for (const [i, ev] of apneaDefs.entries()) {
        const evRec = await this.storage.addEvent({
          sessionId,
          ...ev,
          timestamp: ev.startTime,
          hasClip: i < 2,
          peakDb: -18,
          peakDbA: 68,
        });
        if (i < 2) {
          await this.storage.saveClip({
            sessionId,
            eventId: evRec.id,
            clipType: 'event',
            audioBlob: makeWavBlob(110, 2.0),
            duration: 2.0,
            format: 'wav',
            timestamp: ev.startTime,
          });
        }
      }

      // Add highlights (loudest moments)
      const highlightDefs = [
        { offsetSec: 14420, peak: 0.82, db: -14.2, label: 'snoring' },
        { offsetSec: 18010, peak: 0.74, db: -16.8, label: 'bruxism' },
        { offsetSec: 24010, peak: 0.68, db: -18.5, label: 'noise' },
      ];
      for (const h of highlightDefs) {
        const ts = eightHoursAgo + h.offsetSec * 1000;
        const hlRec = await this.storage.saveHighlight({
          sessionId,
          timestamp: ts,
          peak: h.peak,
          db: h.db,
          classifiedAs: h.label,
          confidence: 0.93,
          hasClip: true,
        });
        const hBlob = makeWavBlob(h.label === 'snoring' ? 130 : 480, 2.0);
        await this.storage.saveClip({
          sessionId,
          eventId: hlRec.id,
          clipType: 'highlight',
          audioBlob: hBlob,
          duration: 2.0,
          format: 'wav',
          timestamp: ts,
        });
      }

      this.currentSessionId = sessionId;
      this._showScreen('report');
      await this._loadReport(sessionId);
      await this._loadHistory();
      await this._updateStorageUsage();
      this._banner('Sample sleep session loaded! Review timeline and playable clips.', { autoHideMs: 5000 });
    } catch (err) {
      console.error('Failed to load sample session:', err);
      this._banner('Could not load sample data.');
    }
  }

  // ========== BEDTIME REMINDER ==========

  async _initBedtimeReminder() {
    const toggle = document.getElementById('setting-bedtime-enabled');
    const timeInput = document.getElementById('setting-bedtime-time');
    const desc = document.getElementById('setting-bedtime-desc');
    if (!toggle || !timeInput) return;

    if (!bedtimeReminder.supported) {
      // the browser can't schedule notifications while the page is closed
      toggle.disabled = true;
      timeInput.disabled = true;
      if (desc) desc.textContent = 'Available in the SleepSensor iOS / Android app.';
      return;
    }

    try {
      toggle.checked = !!(await this.storage.getSetting('bedtimeReminder', false));
      timeInput.value = await this.storage.getSetting('bedtimeTime', '23:00');
    } catch (_) { /* defaults are fine */ }

    const apply = async () => {
      const time = parseTime(timeInput.value);
      if (!toggle.checked || !time) {
        await bedtimeReminder.disable();
        return;
      }
      const res = await bedtimeReminder.enable(time);
      if (res.ok) return;
      toggle.checked = false;
      await this.storage.setSetting('bedtimeReminder', false);
      this._banner(
        res.reason === 'permission'
          ? 'Allow notifications for SleepSensor in your phone settings to get bedtime reminders.'
          : 'Could not schedule the bedtime reminder.',
        { autoHideMs: 8000 }
      );
    };

    toggle.addEventListener('change', async () => {
      await this.storage.setSetting('bedtimeReminder', toggle.checked);
      await apply();
      if (toggle.checked) this._banner(`Bedtime reminder set for ${timeInput.value} every night.`, { autoHideMs: 4000 });
    });
    timeInput.addEventListener('change', async () => {
      if (!parseTime(timeInput.value)) return;
      await this.storage.setSetting('bedtimeTime', timeInput.value);
      await apply();
    });

    bedtimeReminder.onAction((actionId) => this._onBedtimeAction(actionId));

    // re-schedule on launch so a changed OS / reinstall never leaves it stale
    if (toggle.checked) apply();
  }

  _onBedtimeAction(actionId) {
    if (actionId === 'later' || this.isRecording) return;
    this._showScreen('record');
    if (actionId === 'start') {
      this._startRecording();
      return;
    }
    // tapped the notification itself — ask first
    this._showConfirm('Start SleepSensor?', "It's bedtime. Start monitoring your sleep now?", () => {
      this._startRecording();
    });
  }

  // ========== CONFIRM DIALOG ==========

  _showConfirm(title, message, onConfirm) {
    const dialog = document.getElementById('confirm-dialog');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;

    const cancelBtn = document.getElementById('confirm-cancel');
    const okBtn = document.getElementById('confirm-ok');
    let confirmed = false;

    const cleanup = () => {
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      dialog.removeEventListener('close', onClose);
    };
    const onClose = () => {
      // fires for the OK/Cancel buttons AND for the ESC key
      cleanup();
      if (confirmed) onConfirm();
    };
    const onCancel = () => dialog.close();
    const onOk = () => {
      confirmed = true;
      dialog.close();
    };

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
    dialog.addEventListener('close', onClose);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else if (confirm(`${title}\n\n${message}`)) { confirmed = true; onClose(); } // <dialog> unsupported
  }
}

// ========== BOOT ==========
const app = new App();

// Wait for DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => app.init());
} else {
  app.init();
}

// Register service worker — web / PWA only. Inside the Capacitor native shell
// the app is served from the bundle and a SW just adds a stale-cache layer.
const _isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
if ('serviceWorker' in navigator && !_isNative) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}
