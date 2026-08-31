/* ============================================================
   SleepSensor — Canvas Sleep Timeline Renderer
   Draws a horizontal bar showing sleep events over time
   ============================================================ */

import { formatTime } from './utils.js';

export class Timeline {
  /**
   * @param {HTMLCanvasElement} canvas
   */
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
    this.width = rect.width - 32; // account for padding
    this.height = 60;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.scale(this.dpr, this.dpr);
  }

  /**
   * Render the timeline.
   * @param {object} session - { startTime, endTime }
   * @param {Array} events - [{ type, startTime, endTime }]
   */
  render(session, events) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const barY = 18;
    const barH = 22;
    const totalMs = session.endTime - session.startTime;

    ctx.clearRect(0, 0, w, h);

    if (!totalMs || totalMs <= 0) return;

    // Background bar (quiet)
    ctx.fillStyle = 'rgba(78, 205, 196, 0.15)';
    ctx.beginPath();
    ctx.roundRect(0, barY, w, barH, 6);
    ctx.fill();

    // Event segments
    const colors = {
      snoring: '#F5A623',
      bruxism: '#FF6B6B',
    };

    for (const event of events) {
      const x = ((event.startTime - session.startTime) / totalMs) * w;
      const eventW = Math.max(2, ((event.endTime - event.startTime) / totalMs) * w);
      ctx.fillStyle = colors[event.type] || '#6C63FF';
      ctx.beginPath();
      ctx.roundRect(x, barY, eventW, barH, 3);
      ctx.fill();
    }

    // Time labels
    ctx.fillStyle = '#5c6196';
    ctx.font = '500 10px Inter, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(session.startTime), 0, barY - 4);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(session.endTime), w, barY - 4);

    // Hour markers
    const startHour = new Date(session.startTime);
    startHour.setMinutes(0, 0, 0);
    let marker = startHour.getTime() + 3600000; // next full hour

    ctx.strokeStyle = 'rgba(92, 97, 150, 0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);

    while (marker < session.endTime) {
      const x = ((marker - session.startTime) / totalMs) * w;
      if (x > 20 && x < w - 20) {
        ctx.beginPath();
        ctx.moveTo(x, barY);
        ctx.lineTo(x, barY + barH);
        ctx.stroke();

        // Hour label below bar
        ctx.fillStyle = '#5c6196';
        ctx.textAlign = 'center';
        ctx.font = '400 9px Inter, sans-serif';
        ctx.fillText(formatTime(marker), x, barY + barH + 14);
      }
      marker += 3600000;
    }

    ctx.setLineDash([]);
  }

  destroy() {
    this._resizeObserver?.disconnect();
  }
}
