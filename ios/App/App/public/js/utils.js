/* ============================================================
   SleepSensor — Shared Utilities
   ============================================================ */

/**
 * Format seconds into human-readable duration string.
 * @param {number} seconds
 * @returns {string} e.g. "2h 34m", "45m", "12s"
 */
export function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Format seconds into HH:MM:SS timer string.
 * @param {number} seconds
 * @returns {string} e.g. "02:34:12"
 */
export function formatTimer(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

/**
 * Format a timestamp into a time string.
 * @param {number} timestamp - Unix ms
 * @returns {string} e.g. "11:34 PM"
 */
export function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Format a timestamp into a date string.
 * @param {number} timestamp - Unix ms
 * @returns {string} e.g. "Aug 31, 2026"
 */
export function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format a date into YYYY-MM-DD string.
 * @param {Date} date
 * @returns {string}
 */
export function toDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().split('T')[0];
}

/**
 * Get month abbreviation from date.
 * @param {number} timestamp
 * @returns {string} e.g. "AUG"
 */
export function getMonthAbbr(timestamp) {
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
}

/**
 * Get day of month from date.
 * @param {number} timestamp
 * @returns {number}
 */
export function getDayOfMonth(timestamp) {
  return new Date(timestamp).getDate();
}

/**
 * Format bytes into human-readable size.
 * @param {number} bytes
 * @returns {string} e.g. "1.5 MB"
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Debounce a function.
 * @param {Function} fn
 * @param {number} delay - ms
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Throttle a function.
 * @param {Function} fn
 * @param {number} interval - ms
 * @returns {Function}
 */
export function throttle(fn, interval) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= interval) {
      last = now;
      fn(...args);
    }
  };
}

/**
 * Map a value from one range to another.
 * @param {number} value
 * @param {number} inMin
 * @param {number} inMax
 * @param {number} outMin
 * @param {number} outMax
 * @returns {number}
 */
export function mapRange(value, inMin, inMax, outMin, outMax) {
  return ((value - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin;
}

/**
 * Clamp a value between min and max.
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Generate a percentage string.
 * @param {number} part
 * @param {number} total
 * @returns {string} e.g. "34.5%"
 */
export function toPercent(part, total) {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

/**
 * Simple lerp (linear interpolation).
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Trace a rounded rectangle path, clamping every value so a canvas that is
 * momentarily 0-sized (hidden screen) can never throw "Radius value is negative".
 * Returns false if the rect has no area (caller should skip the fill/stroke).
 */
export function roundRectPath(ctx, x, y, w, h, r) {
  w = Math.max(0, w);
  h = Math.max(0, h);
  if (w === 0 || h === 0) return false;
  const rr = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rr);
  } else {
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  return true;
}

/**
 * True when an element is actually laid out (has a non-zero box). Canvas
 * renderers bail early when their container is display:none.
 */
export function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
