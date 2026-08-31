/* ============================================================
   SleepSensor — Canvas Sleep Timeline (Modern)
   Sleek, rounded horizontal bar timeline
   ============================================================ */

import { formatTime } from './utils.js';

export class Timeline {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this._resize();

    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(canvas.parentElement);
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.width = rect.width - 32; // padding
    this.height = 70;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.scale(this.dpr, this.dpr);
  }

  render(session, events) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const barY = 24;
    const barH = 16;
    const radius = barH / 2;
    const totalMs = session.endTime - session.startTime;

    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;

    if (!totalMs || totalMs <= 0) return;

    // Background bar (quiet) — soft dark pill
    ctx.fillStyle = '#222222';
    ctx.beginPath();
    ctx.roundRect(0, barY, w, barH, radius);
    ctx.fill();

    // Event segments
    const colors = {
      snoring: '#ffffff',
      bruxism: '#888888',
      noise: '#555555',
    };

    for (const event of events) {
      const x = Math.max(0, Math.min(w, ((event.startTime - session.startTime) / totalMs) * w));
      let eventW = Math.max(4, ((event.endTime - event.startTime) / totalMs) * w);
      if (x + eventW > w) eventW = Math.max(0, w - x);

      ctx.fillStyle = colors[event.type] || '#cccccc';
      ctx.beginPath();
      // Draw sub-pills for each event to keep it round
      ctx.roundRect(x, barY, eventW, barH, Math.min(radius, eventW / 2));
      ctx.fill();
    }

    // Time labels — smooth modern font
    ctx.fillStyle = '#888888';
    ctx.font = '500 11px "Inter", sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(session.startTime), 4, barY - 6);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(session.endTime), w - 4, barY - 6);

    // Hour markers
    const startHour = new Date(session.startTime);
    startHour.setMinutes(0, 0, 0);
    let marker = startHour.getTime() + 3600000;

    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 1;

    while (marker < session.endTime) {
      const x = ((marker - session.startTime) / totalMs) * w;
      if (x > 30 && x < w - 30) {
        // Vertical tick
        ctx.beginPath();
        ctx.moveTo(x, barY + barH + 4);
        ctx.lineTo(x, barY + barH + 8);
        ctx.stroke();

        // Hour label
        ctx.fillStyle = '#666666';
        ctx.font = '400 10px "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(formatTime(marker), x, barY + barH + 20);
      }
      marker += 3600000;
    }
  }

  destroy() {
    this._resizeObserver?.disconnect();
  }
}
