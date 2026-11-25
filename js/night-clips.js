/*
 * night-clips.js — SleepSensor
 *
 * The "Night clips" panel of the morning report (also what Settings → Export
 * night opens): a night summary, a timeline strip, and the clips grouped by
 * kind (snoring, grinding, breathing pauses, talking, other) — only the
 * longest few per kind until "Show all", which lists every clip by hour.
 * Compact rows: time, duration, play, select. Share all or the selection.
 *
 * Pure model + HTML string rendering (testable without a DOM); app.js binds it.
 */

export const KINDS = [
  { key: 'snore', label: 'Snoring', color: 'var(--nc-snore)' },
  { key: 'grind', label: 'Grinding', color: 'var(--nc-grind)' },
  { key: 'apnea', label: 'Breathing pauses', color: 'var(--nc-apnea)' },
  { key: 'talk', label: 'Talking', color: 'var(--nc-talk)' },
  { key: 'other', label: 'Other sounds', color: 'var(--nc-other)' },
];
export const TOP_PER_KIND = 3;

export function kindOf(type) {
  switch (type) {
    case 'snoring': return 'snore';
    case 'bruxism': return 'grind';
    case 'apnea': return 'apnea';
    case 'talk': case 'talking': case 'speech': return 'talk';
    default: return 'other';
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
export function clock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function dur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m ${pad(s % 60)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Build the panel model from storage rows. */
export function buildNightModel({ session, events = [], highlights = [], clips = [] }) {
  const evById = new Map(events.map((e) => [e.id, e]));
  const hlById = new Map(highlights.map((h) => [h.id, h]));
  const items = [];
  for (const c of clips) {
    const ev = evById.get(c.eventId);
    const hl = hlById.get(c.eventId);
    const type = ev ? ev.type : hl ? hl.classifiedAs : 'noise';
    const t = (ev && ev.timestamp) || (hl && hl.timestamp) || c.timestamp;
    items.push({
      clipId: c.id,
      kind: kindOf(type),
      time: t,
      dur: ev && ev.duration ? ev.duration : c.duration || 0,
      clipDur: c.duration || 0,
      loudest: !ev && !!hl,
      db: ev ? ev.peakDb : hl ? hl.db : null,
    });
  }
  items.sort((a, b) => a.time - b.time);

  const groups = [];
  for (const k of KINDS) {
    const all = items.filter((i) => i.kind === k.key);
    const evs = events.filter((e) => kindOf(e.type) === k.key);
    if (!all.length && !evs.length) continue;
    const top = [...all].sort((a, b) => b.dur - a.dur || (b.db ?? -99) - (a.db ?? -99)).slice(0, TOP_PER_KIND);
    const hours = [];
    for (const i of all) {
      const h = clock(i.time).slice(0, 2) + ':00';
      if (!hours.length || hours[hours.length - 1].label !== h) hours.push({ label: h, items: [] });
      hours[hours.length - 1].items.push(i);
    }
    groups.push({
      ...k,
      events: evs.length,
      totalSec: evs.reduce((a, e) => a + (e.duration || 0), 0),
      clips: all.length,
      top,
      hours,
    });
  }

  const start = session.startTime;
  const end = session.endTime || (session.totalDuration ? start + session.totalDuration * 1000 : Math.max(start + 3600e3, ...events.map((e) => e.timestamp + (e.duration || 0) * 1000)));
  const count = (k) => events.filter((e) => kindOf(e.type) === k).length;
  const secs = (k) => events.filter((e) => kindOf(e.type) === k).reduce((a, e) => a + (e.duration || 0), 0);
  const summary = {
    start, end,
    length: (end - start) / 1000,
    snoreSec: session.snoringDuration ?? secs('snore'),
    grindSec: session.bruxismDuration ?? secs('grind'),
    pauses: session.apneaEvents ?? count('apnea'),
    other: count('other') + count('talk'),
    micOffSec: session.deafSec || 0,
    clips: items.length,
  };
  const timeline = events
    .filter((e) => typeof e.timestamp === 'number')
    .map((e) => ({ kind: kindOf(e.type), t: e.timestamp, dur: e.duration || 2 }));
  const gaps = (session.listenGaps || []).map((g) => ({ t: g.start, dur: g.sec }));
  return { summary, groups, timeline, gaps, items };
}

function timelineSvg(m) {
  const { start, end } = m.summary;
  const span = Math.max(60e3, end - start);
  const lanes = KINDS.filter((k) => m.timeline.some((e) => e.kind === k.key));
  const W = 1000, laneH = 44, top = 6, H = top + Math.max(1, lanes.length) * laneH + 40;
  const x = (t) => Math.max(0, Math.min(W, ((t - start) / span) * W));
  let s = `<svg class="nc-timeline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Night timeline">`;
  for (const g of m.gaps) s += `<rect class="nc-gap" x="${x(g.t)}" y="0" width="${Math.max(2, x(g.t + g.dur * 1000) - x(g.t))}" height="${H - 36}"/>`;
  lanes.forEach((k, li) => {
    const y = top + li * laneH;
    s += `<rect class="nc-lane" x="0" y="${y + 3}" width="${W}" height="${laneH - 6}" rx="3"/>`;
    for (const e of m.timeline.filter((e) => e.kind === k.key)) {
      s += `<rect x="${x(e.t)}" y="${y + 2}" width="${Math.max(3, x(e.t + e.dur * 1000) - x(e.t))}" height="${laneH - 4}" rx="2" style="fill:${k.color}"/>`;
    }
  });
  // hour ticks
  const first = new Date(start); first.setMinutes(0, 0, 0);
  const step = span > 8 * 3600e3 ? 2 * 3600e3 : 3600e3;
  for (let t = first.getTime() + 3600e3; t < end; t += step) {
    s += `<line class="nc-tick" x1="${x(t)}" x2="${x(t)}" y1="0" y2="${H - 34}"/><text class="nc-tick-label" x="${x(t)}" y="${H - 6}">${clock(t).slice(0, 2)}</text>`;
  }
  s += '</svg>';
  const legend = lanes.map((k) => `<span class="nc-legend-item"><i style="background:${k.color}"></i>${k.label}</span>`).join('') +
    (m.gaps.length ? '<span class="nc-legend-item"><i class="nc-legend-gap"></i>Mic off</span>' : '');
  return `<div class="nc-chart">${s}<div class="nc-legend">${legend}</div></div>`;
}

function row(i, selected, playIcon) {
  const sel = selected.has(i.clipId);
  return `<div class="nc-row${sel ? ' nc-row--sel' : ''}" data-clip-id="${esc(i.clipId)}">
      <button class="clip-play-btn nc-play" data-clip-id="${esc(i.clipId)}" aria-label="Play clip at ${clock(i.time)}">${playIcon}</button>
      <span class="nc-time">${clock(i.time)}</span>
      <span class="nc-dur">${dur(i.dur)}${i.loudest ? ' · loudest' : ''}</span>
      <label class="nc-check"><input type="checkbox" data-select="${esc(i.clipId)}"${sel ? ' checked' : ''} aria-label="Select clip at ${clock(i.time)}"></label>
    </div>`;
}

/**
 * @param {object} m          buildNightModel() result
 * @param {{expanded?:Set<string>, selected?:Set<string>, playIcon?:string}} state
 */
export function renderNightClips(m, { expanded = new Set(), selected = new Set(), playIcon = '▶' } = {}) {
  const s = m.summary;
  const stat = (v, l) => `<div class="nc-stat"><span class="nc-stat-v">${v}</span><span class="nc-stat-l">${l}</span></div>`;
  let h = `<div class="nc-summary">
    <div class="nc-range">${clock(s.start)} – ${clock(s.end)} · ${dur(s.length)}${s.micOffSec >= 120 ? ` · <span class="nc-warn">mic off ${dur(s.micOffSec)}</span>` : ''}</div>
    <div class="nc-stats">${stat(dur(s.snoreSec), 'snoring')}${stat(dur(s.grindSec), 'grinding')}${stat(s.pauses, 'pauses')}${stat(s.other, 'other')}</div>
  </div>`;
  h += timelineSvg(m);
  if (!m.items.length) return h + '<p class="nc-empty">No clips saved this night.</p>';

  h += `<div class="nc-actions">
    <button class="nc-btn nc-btn--primary" data-action="share-all">Share all (${m.items.length})</button>
    <button class="nc-btn" data-action="share-selected"${selected.size ? '' : ' disabled'}>Share selected${selected.size ? ` (${selected.size})` : ''}</button>
  </div>`;
  for (const g of m.groups) {
    if (!g.clips) continue;
    const open = expanded.has(g.key);
    h += `<section class="nc-group" data-kind="${g.key}">
      <header class="nc-group-head"><i class="nc-dot" style="background:${g.color}"></i><span class="nc-group-title">${g.label}</span>
        <span class="nc-group-meta">${g.events} event${g.events === 1 ? '' : 's'}${g.totalSec ? ` · ${dur(g.totalSec)}` : ''}</span></header>`;
    if (!open) {
      h += `<div class="nc-sub">${g.clips > g.top.length ? 'Longest' : ''}</div>`;
      h += g.top.map((i) => row(i, selected, playIcon)).join('');
    } else {
      for (const hr of g.hours) {
        h += `<div class="nc-sub">${hr.label}</div>` + hr.items.map((i) => row(i, selected, playIcon)).join('');
      }
    }
    if (g.clips > g.top.length) {
      h += `<button class="nc-more" data-toggle="${g.key}">${open ? 'Show less' : `Show all ${g.clips}`}</button>`;
    }
    h += '</section>';
  }
  return h;
}
