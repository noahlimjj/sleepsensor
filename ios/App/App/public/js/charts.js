/* ============================================================
   SleepSensor — Chart Renderers
   Smooth monochrome donut + bezier trend charts
   ============================================================ */

import { isVisible } from './utils.js';

export class DonutChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this._last = null;
    this._resize();
  }

  _resize() {
    const size = 220;
    this.size = size;
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);
  }

  render(data) {
    this._last = data;
    if (!isVisible(this.canvas)) return;
    this._resize();

    const ctx = this.ctx;
    const s = this.size;
    const cx = s / 2;
    const cy = s / 2;
    const outerR = s / 2 - 12;
    const innerR = outerR - 16;
    const total = (data.quiet || 0) + (data.snoring || 0) + (data.bruxism || 0) + (data.noise || 0);

    ctx.clearRect(0, 0, s, s);
    ctx.imageSmoothingEnabled = true;

    if (!total) {
      ctx.strokeStyle = '#222222';
      ctx.lineWidth = 16;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR - 8, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    const segments = [
      { value: data.quiet || 0, color: '#222222' },
      { value: data.bruxism || 0, color: '#888888' },
      { value: data.noise || 0, color: '#555555' },
      { value: data.snoring || 0, color: '#ffffff' },
    ];
    const activeSegs = segments.filter((seg) => seg.value > 0);
    const gap = activeSegs.length > 1 ? 0.03 : 0;
    let startAngle = -Math.PI / 2;

    for (const seg of segments) {
      if (seg.value <= 0) continue;
      const sweepAngle = (seg.value / total) * (Math.PI * 2 - gap * activeSegs.length);
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, startAngle, startAngle + sweepAngle);
      ctx.arc(cx, cy, innerR, startAngle + sweepAngle, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = seg.color;
      ctx.fill();

      const capRadius = (outerR - innerR) / 2;
      const capCenterR = innerR + capRadius;
      for (const a of [startAngle, startAngle + sweepAngle]) {
        ctx.beginPath();
        ctx.arc(cx + capCenterR * Math.cos(a), cy + capCenterR * Math.sin(a), capRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      startAngle += sweepAngle + gap;
    }
  }
}

export class TrendChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this._last = null;

    this._resizeObserver = new ResizeObserver(() => {
      this._resize();
      if (this._last) this.render(this._last);
    });
    if (canvas.parentElement) this._resizeObserver.observe(canvas.parentElement);
    this._resize();
  }

  _resize() {
    const rect = this.canvas.parentElement
      ? this.canvas.parentElement.getBoundingClientRect()
      : { width: 0 };
    this.width = Math.max(0, rect.width - 32);
    this.height = 200;
    if (this.width === 0) return;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);
  }

  render(sessions) {
    this._last = sessions;
    if (!isVisible(this.canvas.parentElement)) return;
    this._resize();

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return;

    const padTop = 30;
    const padBottom = 30;
    const padLeft = 34;
    const padRight = 10;
    const chartW = Math.max(1, w - padLeft - padRight);
    const chartH = Math.max(1, h - padTop - padBottom);

    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;

    const completed = (sessions || []).filter((s) => s.endTime);
    if (completed.length === 0) {
      ctx.fillStyle = '#666';
      ctx.font = '500 12px "Inter", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No history yet — record a night to see trends.', w / 2, h / 2);
      return;
    }
    // oldest -> newest along the x axis
    const rows = completed.slice().reverse();

    const maxVal = Math.max(
      ...rows.map((s) => Math.max(s.snoringDuration || 0, s.bruxismDuration || 0, s.noiseDuration || 0)),
      60
    );
    const yMax = Math.ceil(maxVal / 60) * 60;

    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = padTop + (chartH / gridLines) * i;
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight, y);
      ctx.stroke();
      const val = yMax - (yMax / gridLines) * i;
      ctx.fillStyle = '#666';
      ctx.font = '500 10px "Inter", system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round(val / 60)}m`, padLeft - 8, y);
    }

    const datasets = [
      { key: 'bruxismDuration', color: '#888888', label: 'Grinding' },
      { key: 'noiseDuration', color: '#555555', label: 'Noise' },
      { key: 'snoringDuration', color: '#ffffff', label: 'Snoring' },
    ];
    const xAt = (i) => padLeft + (chartW / Math.max(rows.length - 1, 1)) * i;

    for (const ds of datasets) {
      const points = rows.map((s, i) => ({
        x: xAt(i),
        y: padTop + chartH - ((s[ds.key] || 0) / yMax) * chartH,
      }));
      ctx.strokeStyle = ds.color;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (points.length === 1) {
        ctx.arc(points[0].x, points[0].y, 3, 0, Math.PI * 2);
        ctx.fillStyle = ds.color;
        ctx.fill();
      } else {
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 0; i < points.length - 1; i++) {
          const xc = (points[i].x + points[i + 1].x) / 2;
          const yc = (points[i].y + points[i + 1].y) / 2;
          ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
        }
        ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
        ctx.stroke();
      }
      for (const pt of points) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = ds.color;
        ctx.stroke();
      }
    }

    ctx.fillStyle = '#666';
    ctx.font = '500 10px "Inter", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.floor(rows.length / 5));
    for (let i = 0; i < rows.length; i += step) {
      const d = new Date(rows[i].startTime || rows[i].date);
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, xAt(i), padTop + chartH + 10);
    }

    // legend
    let legendX = w - padRight;
    const legendY = 10;
    for (let i = datasets.length - 1; i >= 0; i--) {
      const ds = datasets[i];
      ctx.font = '500 11px "Inter", system-ui, sans-serif';
      const textW = ctx.measureText(ds.label).width;
      legendX -= textW;
      ctx.fillStyle = ds.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(ds.label, legendX, legendY);
      legendX -= 10;
      ctx.beginPath();
      ctx.arc(legendX, legendY, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = ds.color;
      ctx.fill();
      legendX -= 14;
    }
  }

  destroy() {
    this._resizeObserver?.disconnect();
  }
}
