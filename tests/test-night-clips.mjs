// night-clips.js — grouped, scannable clip panel model + rendering.
import { section, ok, eq, pass } from './lib.mjs';
import { buildNightModel, renderNightClips, kindOf, TOP_PER_KIND } from '../js/night-clips.js';

export async function run() {
  section('night-clips.js — summary, timeline, grouped clips');
  const t0 = new Date(2026, 10, 23, 23, 30).getTime();
  const H = 3600e3;
  const events = [], clips = [];
  for (let i = 0; i < 12; i++) { // 12 snoring events across the night, varied lengths
    events.push({ id: `s${i}`, type: 'snoring', timestamp: t0 + i * 0.5 * H, duration: 10 + i * 3, peakDb: -40 });
    clips.push({ id: `cs${i}`, eventId: `s${i}`, clipType: 'event', timestamp: t0 + i * 0.5 * H, duration: 20 });
  }
  events.push({ id: 'g1', type: 'bruxism', timestamp: t0 + 5.8 * H, duration: 14 });
  clips.push({ id: 'cg1', eventId: 'g1', clipType: 'event', timestamp: t0 + 5.8 * H, duration: 24 });
  events.push({ id: 'a1', type: 'apnea', timestamp: t0 + 5.85 * H, duration: 18, confidence: 0.72 });
  events.push({ id: 'a2', type: 'apnea', timestamp: t0 + 3 * H, duration: 12, confidence: 0.35 }); // unlikely: hidden
  clips.push({ id: 'ca2', eventId: 'a2', clipType: 'event', timestamp: t0 + 3 * H, duration: 20 });
  clips.push({ id: 'ca1', eventId: 'a1', clipType: 'event', timestamp: t0 + 5.85 * H, duration: 26 });
  const highlights = [{ id: 'h1', timestamp: t0 + 2 * H, classifiedAs: 'noise', db: -20 }];
  clips.push({ id: 'ch1', eventId: 'h1', clipType: 'highlight', timestamp: t0 + 2 * H, duration: 6 });
  const session = { id: 'n', startTime: t0, endTime: t0 + 7 * H, snoringDuration: 400, bruxismDuration: 14, apneaEvents: 1, deafSec: 600, listenGaps: [{ start: t0 + 6 * H, sec: 600 }] };

  eq(kindOf('bruxism'), 'grind', 'bruxism -> grind');
  eq(kindOf('speech'), 'talk', 'speech -> talk');
  const m = buildNightModel({ session, events, highlights, clips });
  ok(!m.items.some((i) => i.clipId === 'ca2'), 'unlikely breathing pause (p < 0.6) not listed');
  eq(m.groups.map((g) => g.key).join(','), 'snore,grind,apnea,other', 'groups in kind order, empty kinds hidden');
  const snore = m.groups[0];
  eq(snore.clips, 12, 'all snoring clips grouped');
  eq(snore.top.length, TOP_PER_KIND, 'top N by default');
  eq(snore.top[0].clipId, 'cs11', 'longest first');
  ok(snore.hours.length >= 6, `grouped by hour of night (${snore.hours.length} hours)`);
  ok(m.groups[3].top[0].loudest, 'highlight clip flagged loudest');
  eq(m.summary.clips, 15, 'summary clip count');

  const collapsed = renderNightClips(m);
  eq((collapsed.match(/class="nc-row/g) || []).length, 3 + 1 + 1 + 1, 'collapsed: 6 compact rows instead of 15');
  ok(collapsed.includes('Show all 12'), 'show-all button for snoring');
  ok(collapsed.includes('nc-timeline') && collapsed.includes('nc-gap'), 'timeline with mic-off gap');
  ok(collapsed.includes('Share all (15)'), 'share all');
  ok(/data-action="share-selected" disabled/.test(collapsed), 'share selected disabled with nothing selected');
  ok(collapsed.includes('mic off'), 'summary warns about mic off');

  const open = renderNightClips(m, { expanded: new Set(['snore']), selected: new Set(['cs1', 'cg1']) });
  eq((open.match(/class="nc-row/g) || []).length, 12 + 3, 'expanded snoring lists all 12');
  ok(open.includes('Share selected (2)'), 'selection count on share');
  ok(open.includes('Show less'), 'collapse button');
  ok(!renderNightClips(buildNightModel({ session, events: [], highlights: [], clips: [] })).includes('nc-row'), 'empty night: no rows');
  pass('night clips are grouped, summarised and compact');
}
