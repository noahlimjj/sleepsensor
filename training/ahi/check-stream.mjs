// The streaming tracker in the app must find exactly the prototype's candidates.
import { loadAll, levels } from './hours.mjs';
import { candidates, P } from './dips.mjs';
import { BreathPauseTracker } from '../../js/apnea-detector.js';
let bad = 0, total = 0;
for (const d of loadAll()) {
  const lv = levels(d.frames, [5]);
  const off = candidates(lv, P);
  const tr = new BreathPauseTracker();
  const on = [];
  for (let i = 0; i < lv.length; i += 20) on.push(...tr.push(lv.slice(i, i + 20)));
  const a = off.filter((c) => c.t <= lv.length / 10 - 31).map((c) => `${c.t}:${c.gap}:${c.f.map((x) => x.toFixed(3)).join(',')}`);
  const b = on.map((c) => `${c.t}:${c.gap}`);
  const bset = new Set(b);
  const miss = a.filter((x) => !bset.has(x.split(':').slice(0, 2).join(':'))).length;
  total += a.length; bad += miss + Math.abs(a.length - b.length);
  console.log(d.id.slice(4, 8), d.seg, 'offline', a.length, 'stream', b.length, 'missing', miss);
}
console.log(bad ? `MISMATCH ${bad}/${total}` : `streaming == offline on ${total} candidates`);
