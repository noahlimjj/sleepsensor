/* ============================================================
   SleepSensor — Canvas Sleep Timeline (Retro B&W)
   Pixel-art style horizontal bar
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
    this.width = rect.width - 24;
    this.height = 60;
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
    const barY = 18;
    const barH = 20;
    const totalMs = session.endTime - session.startTime;

    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;

    if (!totalMs || totalMs <= 0) return;

    // Background bar (quiet) — dark fill with border
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(0, barY, w, barH);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, barY, w, barH);

    // Event segments — solid blocks, no rounding
    const colors = {
      snoring: '#e8e8e8',
      bruxism: '#888',
    };

    for (const event of events) {
      const x = Math.floor(((event.startTime - session.startTime) / totalMs) * w);
      const eventW = Math.max(2, Math.floor(((event.endTime - event.startTime) / totalMs) * w));
      ctx.fillStyle = colors[event.type] || '#ccc';
      ctx.fillRect(x, barY, eventW, barH);
    }

    // Time labels — pixel font style
    ctx.fillStyle = '#777';
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(session.startTime), 0, barY - 3);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(session.endTime), w, barY - 3);

    // Hour markers — dashed lines
    const startHour = new Date(session.startTime);
    startHour.setMinutes(0, 0, 0);
    let marker = startHour.getTime() + 3600000;

    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;

    while (marker < session.endTime) {
      const x = Math.floor(((marker - session.startTime) / totalMs) * w);
      if (x > 20 && x < w - 20) {
        // Dotted line (pixel style — alternating pixels)
        for (let py = barY; py < barY + barH; py += 3) {
          ctx.fillStyle = '#555';
          ctx.fillRect(x, py, 1, 1);
        }

        // Hour label
        ctx.fillStyle = '#555';
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(formatTime(marker), x, barY + barH + 12);
      }
      marker += 3600000;
    }
  }

  destroy() {
    this._resizeObserver?.disconnect();
  }
}
