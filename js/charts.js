/* ============================================================
   SleepSensor — Chart Renderers (Donut, Trend Line, Bar)
   All rendered on <canvas> for lightweight performance
   ============================================================ */

export class DonutChart {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this._resize();
  }

  _resize() {
    const size = 200;
    this.size = size;
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.ctx.scale(this.dpr, this.dpr);
  }

  /**
   * Render donut chart.
   * @param {object} data - { quiet, snoring, bruxism } in seconds
   */
  render(data) {
    const ctx = this.ctx;
    const s = this.size;
    const cx = s / 2;
    const cy = s / 2;
    const outerR = s / 2 - 8;
    const innerR = outerR - 24;
    const total = (data.quiet || 0) + (data.snoring || 0) + (data.bruxism || 0);

    ctx.clearRect(0, 0, s, s);

    if (!total) {
      // Empty state ring
      ctx.strokeStyle = 'rgba(92, 97, 150, 0.15)';
      ctx.lineWidth = 24;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR - 12, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    const segments = [
      { value: data.quiet || 0, color: '#4ECDC4' },
      { value: data.snoring || 0, color: '#F5A623' },
      { value: data.bruxism || 0, color: '#FF6B6B' },
    ];

    let startAngle = -Math.PI / 2; // Start from top
    const gap = 0.03; // Small gap between segments

    for (const seg of segments) {
      if (seg.value <= 0) continue;
      const sweepAngle = (seg.value / total) * (Math.PI * 2 - gap * segments.filter(s => s.value > 0).length);

      ctx.beginPath();
      ctx.arc(cx, cy, outerR, startAngle, startAngle + sweepAngle);
      ctx.arc(cx, cy, innerR, startAngle + sweepAngle, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = seg.color;
      ctx.fill();

      startAngle += sweepAngle + gap;
    }
  }
}

export class TrendChart {
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
    this.width = rect.width - 32;
    this.height = 180;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.scale(this.dpr, this.dpr);
  }

  /**
   * Render trend line chart.
   * @param {Array} sessions - [{ date, snoringDuration, bruxismDuration }]
   */
  render(sessions) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const padTop = 20;
    const padBottom = 30;
    const padLeft = 40;
    const padRight = 16;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;

    ctx.clearRect(0, 0, w, h);

    if (!sessions || sessions.length === 0) {
      ctx.fillStyle = '#5c6196';
      ctx.font = '500 12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data yet — record your first night!', w / 2, h / 2);
      return;
    }

    // Calculate max value for Y axis
    const maxVal = Math.max(
      ...sessions.map(s => Math.max(s.snoringDuration || 0, s.bruxismDuration || 0)),
      60 // minimum 1 minute
    );
    const yMax = Math.ceil(maxVal / 60) * 60; // Round up to nearest minute

    // Draw grid lines
    ctx.strokeStyle = 'rgba(92, 97, 150, 0.12)';
    ctx.lineWidth = 1;
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = padTop + (chartH / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight, y);
      ctx.stroke();

      // Y label
      const val = yMax - (yMax / gridLines) * i;
      ctx.fillStyle = '#5c6196';
      ctx.font = '400 9px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round(val / 60)}m`, padLeft - 6, y);
    }

    // Plot lines
    const datasets = [
      { key: 'snoringDuration', color: '#F5A623', label: 'Snoring' },
      { key: 'bruxismDuration', color: '#FF6B6B', label: 'Bruxism' },
    ];

    for (const ds of datasets) {
      const points = sessions.map((s, i) => ({
        x: padLeft + (chartW / Math.max(sessions.length - 1, 1)) * i,
        y: padTop + chartH - ((s[ds.key] || 0) / yMax) * chartH,
      }));

      // Line
      ctx.beginPath();
      ctx.strokeStyle = ds.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (let i = 0; i < points.length; i++) {
        if (i === 0) ctx.moveTo(points[i].x, points[i].y);
        else ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();

      // Gradient fill under line
      if (points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.lineTo(points[points.length - 1].x, padTop + chartH);
        ctx.lineTo(points[0].x, padTop + chartH);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
        grad.addColorStop(0, ds.color + '20');
        grad.addColorStop(1, ds.color + '00');
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Dots
      for (const pt of points) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = ds.color;
        ctx.fill();
        ctx.strokeStyle = '#111638';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // X labels (dates)
    ctx.fillStyle = '#5c6196';
    ctx.font = '400 9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.floor(sessions.length / 7));
    for (let i = 0; i < sessions.length; i += step) {
      const x = padLeft + (chartW / Math.max(sessions.length - 1, 1)) * i;
      const d = new Date(sessions[i].startTime || sessions[i].date);
      const label = `${d.getDate()}/${d.getMonth() + 1}`;
      ctx.fillText(label, x, padTop + chartH + 8);
    }

    // Legend
    const legendY = 6;
    let legendX = w - padRight;
    for (let i = datasets.length - 1; i >= 0; i--) {
      const ds = datasets[i];
      ctx.font = '500 9px Inter, sans-serif';
      const textW = ctx.measureText(ds.label).width;
      legendX -= textW;
      ctx.fillStyle = ds.color;
      ctx.textAlign = 'left';
      ctx.fillText(ds.label, legendX, legendY);
      legendX -= 14;
      ctx.beginPath();
      ctx.arc(legendX + 4, legendY + 4, 3, 0, Math.PI * 2);
      ctx.fill();
      legendX -= 12;
    }
  }

  destroy() {
    this._resizeObserver?.disconnect();
  }
}
