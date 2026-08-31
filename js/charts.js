/* ============================================================
   SleepSensor — Chart Renderers (Retro B&W)
   Pixel-art monochrome donut and trend charts
   ============================================================ */

export class DonutChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this._resize();
  }

  _resize() {
    const size = 180;
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
    const outerR = s / 2 - 8;
    const innerR = outerR - 22;
    const total = (data.quiet || 0) + (data.snoring || 0) + (data.bruxism || 0);

    ctx.clearRect(0, 0, s, s);
    ctx.imageSmoothingEnabled = false;

    if (!total) {
      // Empty ring — dashed circle
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 22;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, outerR - 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const segments = [
      { value: data.quiet || 0, color: '#444', pattern: null },
      { value: data.snoring || 0, color: '#e8e8e8', pattern: null },
      { value: data.bruxism || 0, color: '#888', pattern: 'dither' },
    ];

    let startAngle = -Math.PI / 2;
    const gap = 0.04;
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

      // Add dither pattern for bruxism segment
      if (seg.pattern === 'dither') {
        ctx.save();
        ctx.clip();
        ctx.fillStyle = '#444';
        for (let x = 0; x < s; x += 4) {
          for (let y = 0; y < s; y += 4) {
            if ((x + y) % 8 === 0) {
              ctx.fillRect(x, y, 2, 2);
            }
          }
        }
        ctx.restore();
      }

      startAngle += sweepAngle + gap;
    }

    // Inner ring border
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.stroke();
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
    this.width = rect.width - 24;
    this.height = 180;
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
    const padTop = 20;
    const padBottom = 28;
    const padLeft = 36;
    const padRight = 12;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;

    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;

    if (!sessions || sessions.length === 0) {
      ctx.fillStyle = '#444';
      ctx.font = '8px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO DATA YET', w / 2, h / 2 - 8);
      ctx.fillText('RECORD YOUR', w / 2, h / 2 + 8);
      ctx.fillText('FIRST NIGHT!', w / 2, h / 2 + 24);
      return;
    }

    const maxVal = Math.max(
      ...sessions.map(s => Math.max(s.snoringDuration || 0, s.bruxismDuration || 0)),
      60
    );
    const yMax = Math.ceil(maxVal / 60) * 60;

    // Grid lines — pixel dotted
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = Math.floor(padTop + (chartH / gridLines) * i);
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 1;
      // Dotted line
      for (let x = padLeft; x < w - padRight; x += 4) {
        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(x, y, 2, 1);
      }

      // Y label
      const val = yMax - (yMax / gridLines) * i;
      ctx.fillStyle = '#555';
      ctx.font = '8px "Press Start 2P", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round(val / 60)}m`, padLeft - 4, y);
    }

    // Axes
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop);
    ctx.lineTo(padLeft, padTop + chartH);
    ctx.lineTo(w - padRight, padTop + chartH);
    ctx.stroke();

    // Plot lines — stepped/pixelated style
    const datasets = [
      { key: 'snoringDuration', color: '#e8e8e8', label: 'SNORE' },
      { key: 'bruxismDuration', color: '#666', label: 'GRIND' },
    ];

    for (const ds of datasets) {
      const points = sessions.map((s, i) => ({
        x: Math.floor(padLeft + (chartW / Math.max(sessions.length - 1, 1)) * i),
        y: Math.floor(padTop + chartH - ((s[ds.key] || 0) / yMax) * chartH),
      }));

      // Stepped line (retro style)
      ctx.strokeStyle = ds.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        if (i === 0) {
          ctx.moveTo(points[i].x, points[i].y);
        } else {
          // Step: horizontal then vertical
          ctx.lineTo(points[i].x, points[i - 1].y);
          ctx.lineTo(points[i].x, points[i].y);
        }
      }
      ctx.stroke();

      // Square dots (pixel points)
      for (const pt of points) {
        ctx.fillStyle = ds.color;
        ctx.fillRect(pt.x - 3, pt.y - 3, 6, 6);
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(pt.x - 1, pt.y - 1, 2, 2);
      }
    }

    // X labels
    ctx.fillStyle = '#555';
    ctx.font = '7px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.floor(sessions.length / 6));
    for (let i = 0; i < sessions.length; i += step) {
      const x = Math.floor(padLeft + (chartW / Math.max(sessions.length - 1, 1)) * i);
      const d = new Date(sessions[i].startTime || sessions[i].date);
      const label = `${d.getDate()}/${d.getMonth() + 1}`;
      ctx.fillText(label, x, padTop + chartH + 6);
    }

    // Legend — top right
    let legendX = w - padRight;
    const legendY = 6;
    for (let i = datasets.length - 1; i >= 0; i--) {
      const ds = datasets[i];
      ctx.font = '7px "Press Start 2P", monospace';
      const textW = ctx.measureText(ds.label).width;
      legendX -= textW;
      ctx.fillStyle = ds.color;
      ctx.textAlign = 'left';
      ctx.fillText(ds.label, legendX, legendY);
      legendX -= 14;
      ctx.fillRect(legendX, legendY, 8, 8);
      legendX -= 10;
    }
  }

  destroy() {
    this._resizeObserver?.disconnect();
  }
}
