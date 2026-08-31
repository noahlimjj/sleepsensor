/* ============================================================
   SleepSensor — Chart Renderers (Modern)
   Smooth monochrome donut and bezier trend charts
   ============================================================ */

export class DonutChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this._resize();
  }

  _resize() {
    const size = 220;
    this.size = size;
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.ctx.scale(this.dpr, this.dpr);
  }

  render(data) {
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
      // Empty ring
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

    let startAngle = -Math.PI / 2;
    const gap = 0.03;
    const activeSegs = segments.filter(s => s.value > 0);

    for (const seg of segments) {
      if (seg.value <= 0) continue;
      const sweepAngle = (seg.value / total) * (Math.PI * 2 - gap * activeSegs.length);

      ctx.beginPath();
      ctx.arc(cx, cy, outerR, startAngle, startAngle + sweepAngle);
      ctx.arc(cx, cy, innerR, startAngle + sweepAngle, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = seg.color;
      ctx.fill();

      // Rounded caps for segments
      const capRadius = (outerR - innerR) / 2;
      const capCenterR = innerR + capRadius;
      
      // Start cap
      ctx.beginPath();
      ctx.arc(
        cx + capCenterR * Math.cos(startAngle),
        cy + capCenterR * Math.sin(startAngle),
        capRadius, 0, Math.PI * 2
      );
      ctx.fill();

      // End cap
      ctx.beginPath();
      ctx.arc(
        cx + capCenterR * Math.cos(startAngle + sweepAngle),
        cy + capCenterR * Math.sin(startAngle + sweepAngle),
        capRadius, 0, Math.PI * 2
      );
      ctx.fill();

      startAngle += sweepAngle + gap;
    }
  }
}

export class TrendChart {
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
    this.height = 200;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.scale(this.dpr, this.dpr);
  }

  render(sessions) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const padTop = 30;
    const padBottom = 30;
    const padLeft = 32;
    const padRight = 10;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;

    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;

    if (!sessions || sessions.length === 0) {
      ctx.fillStyle = '#666';
      ctx.font = '500 12px "Inter", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No history available yet.', w / 2, h / 2);
      return;
    }

    const maxVal = Math.max(
      ...sessions.map(s => Math.max(s.snoringDuration || 0, s.bruxismDuration || 0, s.noiseDuration || 0)),
      60
    );
    const yMax = Math.ceil(maxVal / 60) * 60;

    // Grid lines
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
      ctx.font = '500 10px "Inter", sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round(val / 60)}m`, padLeft - 8, y);
    }

    const datasets = [
      { key: 'bruxismDuration', color: '#888888', label: 'Grinding' },
      { key: 'noiseDuration', color: '#555555', label: 'Noise' },
      { key: 'snoringDuration', color: '#ffffff', label: 'Snoring' },
    ];

    for (const ds of datasets) {
      const points = sessions.map((s, i) => ({
        x: padLeft + (chartW / Math.max(sessions.length - 1, 1)) * i,
        y: padTop + chartH - ((s[ds.key] || 0) / yMax) * chartH,
      }));

      // Smooth curve
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
      }
      ctx.stroke();

      // Plot dots
      for (const pt of points) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = ds.color;
        ctx.stroke();
      }
    }

    // X labels
    ctx.fillStyle = '#666';
    ctx.font = '500 10px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.floor(sessions.length / 5));
    for (let i = 0; i < sessions.length; i += step) {
      const x = padLeft + (chartW / Math.max(sessions.length - 1, 1)) * i;
      const d = new Date(sessions[i].startTime || sessions[i].date);
      const label = `${d.getMonth() + 1}/${d.getDate()}`;
      ctx.fillText(label, x, padTop + chartH + 10);
    }

    // Legend
    let legendX = w - padRight;
    const legendY = 10;
    for (let i = datasets.length - 1; i >= 0; i--) {
      const ds = datasets[i];
      ctx.font = '500 11px "Inter", sans-serif';
      const textW = ctx.measureText(ds.label).width;
      legendX -= textW;
      ctx.fillStyle = ds.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(ds.label, legendX, legendY);
      legendX -= 12;
      ctx.beginPath();
      ctx.arc(legendX + 4, legendY, 4, 0, Math.PI * 2);
      ctx.fillStyle = ds.color;
      ctx.fill();
      legendX -= 12;
    }
  }

  destroy() {
    this._resizeObserver?.disconnect();
  }
}
