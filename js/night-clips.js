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
  { key: 'click', label: 'Clicks / snaps', color: 'var(--nc-click)' },
  { key: 'apnea', label: 'Possible breathing pauses', color: 'var(--nc-apnea)' },
  { key: 'movement', label: 'Movement', color: 'var(--nc-move)' },
  { key: 'buzz', label: 'Buzzing', color: 'var(--nc-buzz)' },
  { key: 'talk', label: 'Talking', color: 'var(--nc-talk)' },
  { key: 'other', label: 'Other sounds', color: 'var(--nc-other)' },
];
export const TOP_PER_KIND = 3;

export function kindOf(type, subtype) {
  switch (type) {
    case 'snoring': return 'snore';
    case 'bruxism': return 'grind';
    case 'apnea': return 'apnea';
    case 'click': return 'click';
    case 'movement': return 'movement';
    case 'buzz': return 'buzz';
    case 'talk': case 'talking': case 'speech': return 'talk';
    default:
      if (subtype === 'movement' || subtype === 'buzz' || subtype === 'talk') return subtype;
      return 'other';
  }
}
const kindOfEv = (e) => kindOf(e.type, e.subtype);

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
// single pauses below this probability are mostly false on ordinary nights:
// they count towards the hourly estimate but are not listed (see audio-engine)
export const APNEA_SHOW_PROB = 0.6;

export function buildNightModel({ session, events: allEvents = [], highlights = [], clips = [] }) {
  // filtered = hidden by default but never deleted: old junk clean-up, phone
  // handling at start/stop, and unlikely breathing pauses ("Show filtered-out")
  const filterReason = (e) => e.filtered || (e.type === 'apnea' && (e.confidence ?? 0) < APNEA_SHOW_PROB ? 'unlikely pause' : null);
  const events = allEvents.filter((e) => !filterReason(e));
  const filtered = [];
  const evById = new Map(events.map((e) => [e.id, e]));
  const hlById = new Map(highlights.map((h) => [h.id, h]));
  const items = [];
  const hidden = new Set(allEvents.filter((e) => !events.includes(e)).map((e) => e.id));
  const allById = new Map(allEvents.map((e) => [e.id, e]));
  for (const c of clips) {
    if (hidden.has(c.eventId)) {
      const fe = allById.get(c.eventId);
      filtered.push({ clipId: c.id, kind: kindOf(fe.type, fe.subtype), time: fe.timestamp || c.timestamp, dur: fe.duration || c.duration || 0, db: fe.peakDb, reason: filterReason(fe) });
      continue;
    }
    const ev = evById.get(c.eventId);
    const hl = hlById.get(c.eventId);
    const type = ev ? ev.type : hl ? hl.classifiedAs : 'noise';
    const t = (ev && ev.timestamp) || (hl && hl.timestamp) || c.timestamp;
    items.push({
      clipId: c.id,
      kind: kindOf(type, ev && ev.subtype),
      count: ev && ev.count,
      tmj: !!(ev && ev.nearGrind),
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
    const evs = events.filter((e) => kindOfEv(e) === k.key);
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
  const count = (k) => events.filter((e) => kindOfEv(e) === k).length;
  const secs = (k) => events.filter((e) => kindOfEv(e) === k).reduce((a, e) => a + (e.duration || 0), 0);
  const summary = {
    start, end,
    length: (end - start) / 1000,
    snoreSec: session.snoringDuration ?? secs('snore'),
    grindSec: session.bruxismDuration ?? secs('grind'),
    pauses: count('apnea'),
    other: count('other') + count('talk') + count('movement') + count('buzz'),
    micOffSec: session.deafSec || 0,
    clips: items.length,
    resp: session.respRate && session.respRate.avg ? session.respRate : null,
    clicks: clickSummary(session, events, start),
  };
  const timeline = events
    .filter((e) => typeof e.timestamp === 'number')
    .filter((e) => e.type !== 'click')
    .map((e) => ({ kind: kindOfEv(e), t: e.timestamp, dur: e.duration || 2 }));
  const clickTimes = ((session.clicks && session.clicks.times) || []).map((ms) => start + ms);
  const rr = (session.trace || []).filter((r) => typeof r.rr === 'number').map((r) => ({ t: start + r.m * 60000, bpm: r.rr }));
  const gaps = (session.listenGaps || []).map((g) => ({ t: g.start, dur: g.sec }));
  filtered.sort((a, b) => a.time - b.time);
  return { summary, groups, timeline, gaps, items, clickTimes, rr, filtered };
}

/** Clicks: count, how many sit within 2 min of grinding, and the busiest hour. */
function clickSummary(session, events, start) {
  const c = session.clicks;
  const evs = events.filter((e) => e.type === 'click');
  const count = c ? c.count : evs.reduce((a, e) => a + (e.count || 1), 0);
  if (!count) return null;
  const near = c ? c.nearGrind : evs.filter((e) => e.nearGrind).reduce((a, e) => a + (e.count || 1), 0);
  const times = c && c.times && c.times.length ? c.times.map((ms) => start + ms) : evs.map((e) => e.timestamp);
  const perHour = new Map();
  for (const t of times) {
    const h = new Date(t).getHours();
    perHour.set(h, (perHour.get(h) || 0) + 1);
  }
  let peakHour = null, peakN = 0;
  for (const [h, n] of perHour) if (n > peakN) { peakN = n; peakHour = h; }
  return { count, near, peakHour, peakN, first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null };
}

function timelineSvg(m) {
  const { start, end } = m.summary;
  const span = Math.max(60e3, end - start);
  const lanes = KINDS.filter((k) => m.timeline.some((e) => e.kind === k.key) || (k.key === 'click' && m.clickTimes && m.clickTimes.length));
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
    if (k.key === 'click') {
      // one thin tick per click (bucketed to the pixel so hundreds stay cheap)
      const seen = new Set();
      for (const t of m.clickTimes) {
        const px = Math.round(x(t) / 2) * 2;
        if (seen.has(px)) continue;
        seen.add(px);
        s += `<rect x="${px}" y="${y + 2}" width="2" height="${laneH - 4}" style="fill:${k.color}"/>`;
      }
    }
  });
  // hour ticks
  const first = new Date(start); first.setMinutes(0, 0, 0);
  const step = span > 8 * 3600e3 ? 2 * 3600e3 : 3600e3;
  for (let t = first.getTime() + 3600e3; t < end; t += step) {
    s += `<line class="nc-tick" x1="${x(t)}" x2="${x(t)}" y1="0" y2="${H - 34}"/><text class="nc-tick-label" x="${x(t)}" y="${H - 6}">${clock(t).slice(0, 2)}</text>`;
  }
  s += '</svg>';
  s += rrTrend(m, x, W);
  const legend = lanes.map((k) => `<span class="nc-legend-item"><i style="background:${k.color}"></i>${k.label}</span>`).join('') +
    (m.gaps.length ? '<span class="nc-legend-item"><i class="nc-legend-gap"></i>Mic off</span>' : '');
  return `<div class="nc-chart">${s}<div class="nc-legend">${legend}</div></div>`;
}

/** Breaths per minute over the night, as a small line under the timeline. */
function rrTrend(m, x, W) {
  if (!m.rr || m.rr.length < 3) return '';
  const H = 90, pad = 10;
  const v = m.rr.map((p) => p.bpm);
  const lo = Math.max(0, Math.floor(Math.min(...v) - 2));
  const hi = Math.ceil(Math.max(...v) + 2);
  const y = (b) => pad + (1 - (b - lo) / Math.max(1, hi - lo)) * (H - 2 * pad);
  const pts = m.rr.map((p) => `${x(p.t).toFixed(1)},${y(p.bpm).toFixed(1)}`).join(' ');
  return `<svg class="nc-rr" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Breathing rate over the night">
    <polyline points="${pts}" class="nc-rr-line"/>
    <text x="4" y="${pad + 18}" class="nc-rr-label">${hi}</text><text x="4" y="${H - 4}" class="nc-rr-label">${lo}</text>
    <text x="${W - 4}" y="${pad + 18}" class="nc-rr-label nc-rr-label--end">breaths/min</text>
  </svg>`;
}

function row(i, selected, playIcon) {
  const sel = selected.has(i.clipId);
  return `<div class="nc-row${sel ? ' nc-row--sel' : ''}" data-clip-id="${esc(i.clipId)}">
      <button class="clip-play-btn nc-play" data-clip-id="${esc(i.clipId)}" aria-label="Play clip at ${clock(i.time)}">${playIcon}</button>
      <span class="nc-time">${clock(i.time)}</span>
      <span class="nc-dur">${i.kind === 'click' && i.count ? `${i.count} click${i.count === 1 ? '' : 's'}` : dur(i.dur)}${i.loudest ? ' · loudest' : ''}${i.tmj ? ' · <span class="nc-tmj">near grinding</span>' : ''}</span>
      <label class="nc-check"><input type="checkbox" data-select="${esc(i.clipId)}"${sel ? ' checked' : ''} aria-label="Select clip at ${clock(i.time)}"></label>
    </div>`;
}

function clickMeta(m) {
  const c = m.summary.clicks;
  if (!c) return '';
  return `${c.count} click${c.count === 1 ? '' : 's'}${c.near ? ` · ${c.near} near grinding` : ''}`;
}

function clickLine(c) {
  if (!c || !c.count) return '';
  const hour = c.peakHour != null ? ` · most around ${pad(c.peakHour)}:00` : '';
  const span = c.first != null && c.last != null && c.last - c.first > 60000 ? ` · ${clock(c.first)}–${clock(c.last)}` : '';
  const tmj = c.near ? `<div class="nc-tmj-line">${c.near} click${c.near === 1 ? '' : 's'} within 2 min of grinding: possible TMJ / bruxism-related</div>` : '';
  return `<div class="nc-click-line">${c.count} click${c.count === 1 ? '' : 's'}/snaps${span}${hour}</div>${tmj}`;
}

/**
 * @param {object} m          buildNightModel() result
 * @param {{expanded?:Set<string>, selected?:Set<string>, playIcon?:string}} state
 */
const REASON = { junk: 'quiet background', handling: 'phone handling', 'unlikely pause': 'unlikely pause' };
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.key, k.label]));

function filteredSection(m, showFiltered, selected, playIcon) {
  const f = m.filtered || [];
  if (!f.length) return '';
  let h = `<button class="nc-more nc-filtered-toggle" data-toggle-filtered="1">${showFiltered ? 'Hide filtered-out' : `Show filtered-out (${f.length})`}</button>`;
  if (!showFiltered) return h;
  h += '<section class="nc-group nc-group--filtered"><header class="nc-group-head"><span class="nc-group-title">Filtered out</span><span class="nc-group-meta">kept on the phone</span></header>';
  for (const i of f) {
    h += row({ ...i, loudest: false }, selected, playIcon).replace('<span class="nc-dur">', `<span class="nc-dur">${KIND_LABEL[i.kind] || 'Sound'} · ${REASON[i.reason] || i.reason} · `);
  }
  return h + '</section>';
}

export function renderNightClips(m, { expanded = new Set(), selected = new Set(), playIcon = '▶', showFiltered = false } = {}) {
  const s = m.summary;
  const stat = (v, l) => `<div class="nc-stat"><span class="nc-stat-v">${v}</span><span class="nc-stat-l">${l}</span></div>`;
  let h = `<div class="nc-summary">
    <div class="nc-range">${clock(s.start)} – ${clock(s.end)} · ${dur(s.length)}${s.micOffSec >= 120 ? ` · <span class="nc-warn">mic off ${dur(s.micOffSec)}</span>` : ''}</div>
    <div class="nc-stats">${stat(dur(s.snoreSec), 'snoring')}${stat(dur(s.grindSec), 'grinding')}${
      s.resp ? stat(`${Math.round(s.resp.avg)}<small>/min</small>`, `breathing ${Math.round(s.resp.min)}–${Math.round(s.resp.max)}`) : stat(s.pauses, 'pauses')
    }${stat(s.clicks ? s.clicks.count : 0, 'clicks')}</div>
    ${clickLine(s.clicks)}
  </div>`;
  h += timelineSvg(m);
  if (!m.items.length) return h + '<p class="nc-empty">No clips saved this night.</p>' + filteredSection(m, showFiltered, selected, playIcon);

  h += `<div class="nc-actions">
    <button class="nc-btn nc-btn--primary" data-action="share-all">Share all (${m.items.length})</button>
    <button class="nc-btn" data-action="share-selected"${selected.size ? '' : ' disabled'}>${selected.size ? `Share ${selected.size} clip${selected.size === 1 ? '' : 's'} (.wav)` : 'Select clips to share'}</button>
    <button class="nc-btn nc-btn--ghost" data-action="select-all">${selected.size ? 'Clear' : 'Select all'}</button>
  </div>`;
  for (const g of m.groups) {
    if (!g.clips) continue;
    const open = expanded.has(g.key);
    h += `<section class="nc-group" data-kind="${g.key}">
      <header class="nc-group-head"><i class="nc-dot" style="background:${g.color}"></i><span class="nc-group-title">${g.label}</span>
        <span class="nc-group-meta">${g.key === 'click' ? clickMeta(m) : `${g.events} event${g.events === 1 ? '' : 's'}${g.totalSec ? ` · ${dur(g.totalSec)}` : ''}`}</span></header>`;
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
  h += filteredSection(m, showFiltered, selected, playIcon);
  return h;
}
