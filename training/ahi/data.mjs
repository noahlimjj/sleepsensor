// Candidates and labels for every labelled hour.
import { loadAll, levels } from './hours.mjs';
import { candidates, label, P } from './dips.mjs';

export function prepare(p = P) {
  return loadAll().map((d) => {
    const c = candidates(levels(d.frames, p.band), p);
    return { ...d, c, y: c.map((x) => label(x, d)) };
  });
}
