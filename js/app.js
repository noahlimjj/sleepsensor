/* ============================================================
   SleepSensor — Main App Controller
   Handles screen routing, UI state, and wires everything together
   ============================================================ */

import { formatDuration, formatTimer, formatTime, formatDate, formatBytes, toDateKey, getMonthAbbr, getDayOfMonth, throttle, toPercent } from './utils.js';
import { Timeline } from './timeline.js';
import { DonutChart, TrendChart } from './charts.js';

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
    this.elapsedInterval = null;
    this.startTime = null;
    this.currentSessionId = null;

    // Charts
    this.timeline = null;
    this.donutChart = null;
    this.trendChart = null;

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

      // Initialize classifier
      this.classifier = new Classifier();
      await this.classifier.load();

      // Initialize audio engine
      this.engine = new AudioEngine({
        classifier: this.classifier,
        storage: this.storage,
        onEnergy: throttle((rms) => this._onEnergy(rms), 16),
        onEvent: (event) => this._onEvent(event),
        onStatusChange: (status, error) => this._onStatusChange(status, error),
      });

      // Bind UI events
      this._bindNavigation();
      this._bindRecordButton();
      this._bindSettings();

      // Show app
      this._hideSplash();

      // Load latest report if exists
      this._loadLatestReport();
      this._loadHistory();
      this._updateStorageUsage();

    } catch (err) {
      console.error('App init failed:', err);
      document.querySelector('.splash-subtitle').textContent = 'Failed to initialize. Please refresh.';
    }
  }

  // ========== NAVIGATION ==========

  _bindNavigation() {
    const nav = document.getElementById('bottom-nav');
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-btn');
      if (!btn) return;
      const screen = btn.dataset.screen;
      if (screen) this._showScreen(screen);
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

    // Trigger lazy loads
    if (name === 'history') this._loadHistory();
    if (name === 'settings') this._updateStorageUsage();
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
      this.startTime = Date.now();

      // Update UI
      document.getElementById('app').classList.add('recording');
      document.getElementById('record-btn-label').textContent = 'Tap to stop monitoring';
      document.querySelector('.record-btn-icon--mic').setAttribute('hidden', '');
      document.querySelector('.record-btn-icon--stop').removeAttribute('hidden');
      document.getElementById('waveform-overlay').classList.add('hidden');

      // Reset stats
      document.getElementById('stat-snoring-count').textContent = '0';
      document.getElementById('stat-bruxism-count').textContent = '0';
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
      this.currentSessionId = summary.sessionId;

      // Update UI
      document.getElementById('app').classList.remove('recording');
      document.getElementById('record-btn-label').textContent = 'Tap to start monitoring';
      document.querySelector('.record-btn-icon--mic').removeAttribute('hidden');
      document.querySelector('.record-btn-icon--stop').setAttribute('hidden', '');
      document.getElementById('waveform-overlay').classList.remove('hidden');

      // Stop elapsed timer
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;

      // Stop waveform
      this._stopWaveformAnimation();

      // Load report for this session
      await this._loadReport(summary.sessionId);
      this._showScreen('report');

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
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.scale(dpr, dpr);
    };
    resize();

    const draw = () => {
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      const data = this.waveformData;
      const barCount = data.length;
      const barWidth = Math.floor(w / barCount);
      const centerY = Math.floor(h / 2);

      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;

      // Center line — dotted pixel style
      ctx.fillStyle = '#2a2a2a';
      for (let x = 0; x < w; x += 6) {
        ctx.fillRect(x, centerY, 3, 1);
      }

      // Bars — sharp white rectangles, pixel perfect
      for (let i = 0; i < barCount; i++) {
        const amplitude = Math.min(data[i] * 8, 1);
        const barH = Math.max(1, Math.floor(amplitude * (h * 0.38)));

        // Main bar — white
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(
          Math.floor(i * barWidth) + 1,
          centerY - barH,
          Math.max(1, barWidth - 2),
          barH * 2
        );

        // Scanline effect on tall bars
        if (barH > 4) {
          ctx.fillStyle = '#0a0a0a';
          for (let y = centerY - barH; y < centerY + barH; y += 3) {
            ctx.fillRect(Math.floor(i * barWidth) + 1, y, Math.max(1, barWidth - 2), 1);
          }
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
    this.waveformData.fill(0);
  }

  // ========== EVENTS ==========

  _onEvent(event) {
    if (event.type === 'snoring') {
      this.snoringCount++;
      document.getElementById('stat-snoring-count').textContent = this.snoringCount;
    } else if (event.type === 'bruxism') {
      this.bruxismCount++;
      document.getElementById('stat-bruxism-count').textContent = this.bruxismCount;
    }
    this._showToast(event);
  }

  _showToast(event) {
    const toast = document.getElementById('event-toast');
    const typeEl = document.getElementById('toast-type');
    const confEl = document.getElementById('toast-confidence');
    const iconEl = toast.querySelector('.event-toast-icon');

    // Set content
    typeEl.textContent = event.type === 'snoring' ? 'Snoring detected' : 'Grinding detected';
    confEl.textContent = `${Math.round(event.confidence * 100)}%`;
    iconEl.textContent = event.type === 'snoring' ? '😴' : '😬';

    // Set style
    toast.className = `event-toast toast--${event.type}`;
    toast.removeAttribute('hidden');

    // Animate in
    requestAnimationFrame(() => {
      toast.classList.add('visible');
    });

    // Hide after 3 seconds
    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.setAttribute('hidden', ''), 300);
    }, 3000);
  }

  _onStatusChange(status, error) {
    const label = document.getElementById('record-btn-label');
    if (status === 'error') {
      label.textContent = error || 'Microphone error';
      this.isRecording = false;
      document.getElementById('app').classList.remove('recording');
    } else if (status === 'requesting') {
      label.textContent = 'Requesting microphone access...';
    }
  }

  // ========== REPORT ==========

  async _loadLatestReport() {
    if (!this.storage) return;
    const sessions = await this.storage.getRecentSessions(1);
    if (sessions.length > 0) {
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

    // Date
    document.getElementById('report-date').textContent = formatDate(session.startTime);

    // Summary cards
    const totalSleep = session.totalDuration || ((session.endTime - session.startTime) / 1000);
    document.getElementById('report-sleep-time').textContent = formatDuration(totalSleep);
    document.getElementById('report-snoring-time').textContent = formatDuration(session.snoringDuration || 0);
    document.getElementById('report-bruxism-time').textContent = formatDuration(session.bruxismDuration || 0);
    document.getElementById('report-snoring-pct').textContent = toPercent(session.snoringDuration || 0, totalSleep);
    document.getElementById('report-bruxism-pct').textContent = toPercent(session.bruxismDuration || 0, totalSleep);

    // Timeline
    const events = await this.storage.getEventsBySession(sessionId);
    if (!this.timeline) {
      this.timeline = new Timeline(document.getElementById('timeline-canvas'));
    }
    this.timeline.render(session, events);

    // Severity breakdown
    this._renderSeverityBars(events);

    // Audio clips
    const clips = await this.storage.getClipsBySession(sessionId);
    this._renderClips(clips, events);
  }

  _renderSeverityBars(events) {
    const container = document.getElementById('severity-bars');
    const counts = { mild: 0, moderate: 0, severe: 0 };
    for (const e of events) {
      if (counts[e.severity] !== undefined) counts[e.severity]++;
    }
    const total = events.length || 1;

    container.innerHTML = ['mild', 'moderate', 'severe'].map(sev => `
      <div class="severity-bar-row">
        <span class="severity-bar-label">${sev}</span>
        <div class="severity-bar-track">
          <div class="severity-bar-fill severity-bar-fill--${sev}" style="width: ${(counts[sev] / total) * 100}%"></div>
        </div>
        <span class="severity-bar-value">${counts[sev]}</span>
      </div>
    `).join('');
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

    container.innerHTML = clips.map(clip => {
      const event = eventMap.get(clip.eventId) || {};
      const type = event.type || 'snoring';
      const icon = type === 'snoring' ? '😴' : '😬';
      const time = formatTime(clip.timestamp);
      const duration = clip.duration ? `${clip.duration.toFixed(1)}s` : '--';
      const confidence = event.confidence ? `${Math.round(event.confidence * 100)}%` : '';

      return `
        <div class="clip-card clip-card--${type}" data-clip-id="${clip.id}">
          <button class="clip-play-btn" data-clip-id="${clip.id}" aria-label="Play clip">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6,4 20,12 6,20"/>
            </svg>
          </button>
          <div class="clip-info">
            <div class="clip-type">${icon} ${type === 'snoring' ? 'Snoring' : 'Grinding'}</div>
            <div class="clip-meta">${time} · ${confidence} confidence</div>
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

  async _playClip(clipId, btnEl) {
    if (!this.storage) return;

    // Stop current audio if playing
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
      if (this.currentPlayBtn) {
        this.currentPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
      }
      // If clicking the same button, just stop
      if (this.currentPlayBtn === btnEl) {
        this.currentPlayBtn = null;
        return;
      }
    }

    const clip = await this.storage.getClip(clipId);
    if (!clip || !clip.audioBlob) return;

    const url = URL.createObjectURL(clip.audioBlob);
    this.currentAudio = new Audio(url);
    this.currentPlayBtn = btnEl;

    // Update button to pause icon
    btnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

    this.currentAudio.play();
    this.currentAudio.onended = () => {
      URL.revokeObjectURL(url);
      btnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
      this.currentAudio = null;
      this.currentPlayBtn = null;
    };
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
    let totalQuiet = 0, totalSnoring = 0, totalBruxism = 0;
    for (const s of sessions) {
      const sleep = s.totalDuration || ((s.endTime - s.startTime) / 1000) || 0;
      totalSnoring += s.snoringDuration || 0;
      totalBruxism += s.bruxismDuration || 0;
      totalQuiet += Math.max(0, sleep - (s.snoringDuration || 0) - (s.bruxismDuration || 0));
    }
    this.donutChart.render({ quiet: totalQuiet, snoring: totalSnoring, bruxism: totalBruxism });

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
            </div>
          </div>
          <svg class="session-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      `;
    }).join('');

    // Bind click to load report
    container.querySelectorAll('.session-item').forEach(item => {
      item.addEventListener('click', () => {
        this._loadReport(item.dataset.sessionId);
        this._showScreen('report');
      });
    });
  }

  // ========== SETTINGS ==========

  _bindSettings() {
    // Sensitivity slider
    const slider = document.getElementById('setting-sensitivity');
    slider.addEventListener('input', () => {
      if (this.engine) {
        this.engine.setSensitivity(slider.value / 100);
      }
    });

    // Export
    document.getElementById('setting-export-btn').addEventListener('click', async () => {
      if (!this.storage) return;
      const sessions = await this.storage.getAllSessions();
      const data = { sessions, exportedAt: new Date().toISOString() };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sleepsensor-export-${toDateKey(new Date())}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // Clear data
    document.getElementById('setting-clear-btn').addEventListener('click', () => {
      this._showConfirm(
        'Clear All Data',
        'This will permanently delete all sleep sessions, events, and audio clips. This cannot be undone.',
        async () => {
          await this.storage.clearAll();
          this._loadHistory();
          this._loadLatestReport();
          this._updateStorageUsage();
        }
      );
    });
  }

  async _updateStorageUsage() {
    if (!this.storage) return;
    try {
      const usage = await this.storage.getStorageUsage();
      const desc = document.getElementById('setting-storage-used');
      desc.textContent = `${usage.sessions} sessions · ${usage.events} events · ${usage.clips} clips · ${formatBytes(usage.totalBytes || 0)}`;
    } catch {
      document.getElementById('setting-storage-used').textContent = 'Unable to calculate';
    }
  }

  // ========== CONFIRM DIALOG ==========

  _showConfirm(title, message, onConfirm) {
    const dialog = document.getElementById('confirm-dialog');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;

    const cancelBtn = document.getElementById('confirm-cancel');
    const okBtn = document.getElementById('confirm-ok');

    const cleanup = () => {
      dialog.close();
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
    };

    const onCancel = () => cleanup();
    const onOk = () => {
      cleanup();
      onConfirm();
    };

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
    dialog.showModal();
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

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}
