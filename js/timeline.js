/* ============================================================
   SleepSensor — Canvas Sleep Timeline
   Sleek, rounded horizontal bar timeline
   ============================================================ */

import { formatTime, roundRectPath, isVisible } from './utils.js';

const COLORS = {
  snoring: '#ffffff',
  bruxism: '#888888',
  noise: '#555555',
};

export class Timeline {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this._last = null; // { session, events } — for re-render on resize/show

    this._resizeObserver = new ResizeObserver(() => {
      this._resize();
      if (this._last) this.render(this._last.session, this._last.events);
    });
    if (canvas.parentElement) this._resizeObserver.observe(canvas.parentElement);
    this._resize();
  }

  _resize() {
    const rect = this.canvas.parentElement
      ? this.canvas.parentElement.getBoundingClientRect()
      : { width: 0 };
    this.width = Math.max(0, rect.width - 32);
    this.height = 70;
    if (this.width === 0) return;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);
  }

  render(session, events) {
    if (!session) return;
    this._last = { session, events: events || [] };
    if (!isVisible(this.canvas.parentElement)) return; // hidden screen — render on show
    this._resize();

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return;

    const barY = 24;
    const barH = 16;
    const radius = barH / 2;
    const totalMs = session.endTime - session.startTime;

    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    if (!totalMs || totalMs <= 0) return;

    // background pill (quiet)
    ctx.fillStyle = '#222222';
    ctx.beginPath();
    if (roundRectPath(ctx, 0, barY, w, barH, radius)) ctx.fill();

    // event segments
    for (const event of events) {
      const x = Math.max(0, Math.min(w, ((event.startTime - session.startTime) / totalMs) * w));
      let eventW = Math.max(3, ((event.endTime - event.startTime) / totalMs) * w);
      if (x + eventW > w) eventW = w - x;
      if (eventW <= 0) continue;
      ctx.fillStyle = COLORS[event.type] || '#cccccc';
      ctx.beginPath();
      if (roundRectPath(ctx, x, barY, eventW, barH, radius)) ctx.fill();
    }

    // start / end labels
    ctx.fillStyle = '#888888';
    ctx.font = '500 11px "Inter", system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(session.startTime), 4, barY - 6);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(session.endTime), w - 4, barY - 6);

    // hour ticks
    const startHour = new Date(session.startTime);
    startHour.setMinutes(0, 0, 0);
    let marker = startHour.getTime() + 3600000;
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 1;
    while (marker < session.endTime) {
      const x = ((marker - session.startTime) / totalMs) * w;
      if (x > 30 && x < w - 30) {
        ctx.beginPath();
        ctx.moveTo(x, barY + barH + 4);
        ctx.lineTo(x, barY + barH + 8);
        ctx.stroke();
        ctx.fillStyle = '#666666';
        ctx.font = '400 10px "Inter", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(formatTime(marker), x, barY + barH + 12);
      }
      marker += 3600000;
    }
  }

  destroy() {
    this._resizeObserver?.disconnect();
  }
}
