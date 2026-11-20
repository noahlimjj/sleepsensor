// Loads the labelled hours: band envelopes (bands.mjs) plus the scored events.
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseRml } from './rml.mjs';

const ROOT = process.env.PSG_AUDIO_DIR || `${process.env.HOME}/datasets/psg-audio`;
export function levels(frames, bands) {
  return frames.map((f) => 10 * Math.log10(bands.reduce((s, b) => s + 10 ** (f[b] / 100), 0)));
}

export function loadAll() {
  const out = [];
  for (const f of readdirSync(join(ROOT, 'feat')).filter((x) => x.endsWith('.bands.json'))) {
    const B = JSON.parse(readFileSync(join(ROOT, 'feat', f), 'utf8'));
    const ref = parseRml(join(ROOT, 'rml', `${B.id}.rml`));
    for (const seg of B.segments) {
      const t0 = (seg - 1) * 3600;
      const frames = B.env[seg];
      const t1 = t0 + frames.length / 10;
      const resp = ref.resp.filter((e) => e.start + e.dur / 2 >= t0 && e.start + e.dur / 2 < t1);
      let sleep = 0;
      for (let i = 0; i < ref.stages.length; i++) {
        const st = ref.stages[i];
        const end = i + 1 < ref.stages.length ? ref.stages[i + 1].start : ref.durationSec;
        if (st.type === 'Wake' || st.type === 'NotScored') continue;
        sleep += Math.max(0, Math.min(end, t1) - Math.max(st.start, t0));
      }
      out.push({ id: B.id, seg, t0, frames, resp, sleepH: sleep / 3600, hours: frames.length / 36000, nightAhi: ref.ahi });
    }
  }
  return out;
}
