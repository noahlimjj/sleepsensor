// Leave-one-patient-out check of the shipped recipe: fit the weights and the
// probability cut-off without one patient, then count that patient's events.
import { prepare } from './data.mjs';
import { P } from './dips.mjs';
import { fit, prob } from './logistic.mjs';
for (const mj of [4]) {
  const data = prepare({ ...P, minJump: mj });
  const pts = []; const thrs = [];
  for (const id of [...new Set(data.map((d) => d.id))]) {
    const tr = data.filter((x) => x.id !== id);
    const w = fit(tr.flatMap((x) => x.c.map((c) => c.f)), tr.flatMap((x) => x.y), { l2: 0.003 });
    const ps = tr.flatMap((h) => h.c.map((c) => prob(w, c.f))).sort((a, b) => b - a);
    const total = tr.reduce((s, h) => s + h.resp.length, 0);
    const thr = ps[Math.min(ps.length - 1, total)] ?? 0; thrs.push(thr);
    for (const d of data.filter((x) => x.id === id)) pts.push([d.resp.length / d.hours, d.c.filter((c) => prob(w, c.f) > thr).length / d.hours]);
  }
  const m = pts.length; const tier = (a) => (a < 5 ? 0 : a < 15 ? 1 : a < 30 ? 2 : 3);
  const mx = pts.reduce((s, x) => s + x[1], 0) / m, my = pts.reduce((s, x) => s + x[0], 0) / m;
  const r = pts.reduce((s, x) => s + (x[1] - mx) * (x[0] - my), 0) / Math.sqrt(pts.reduce((s, x) => s + (x[1] - mx) ** 2, 0) * pts.reduce((s, x) => s + (x[0] - my) ** 2, 0));
  console.log(`minJump ${mj} thr ${Math.min(...thrs).toFixed(2)}-${Math.max(...thrs).toFixed(2)} mae ${(pts.reduce((s, x) => s + Math.abs(x[0] - x[1]), 0) / m).toFixed(1)} bias ${(mx - my).toFixed(1)} r ${r.toFixed(2)} tierExact ${(pts.filter((x) => tier(x[0]) === tier(x[1])).length / m).toFixed(2)} within1 ${(pts.filter((x) => Math.abs(tier(x[0]) - tier(x[1])) <= 1).length / m).toFixed(2)} sens15 ${(pts.filter((x) => x[0] >= 15 && x[1] >= 15).length / pts.filter((x) => x[0] >= 15).length).toFixed(2)} spec15 ${(pts.filter((x) => x[0] < 15 && x[1] < 15).length / pts.filter((x) => x[0] < 15).length).toFixed(2)}`);
  console.log(pts.map((x) => `${x[0].toFixed(0)}:${x[1].toFixed(0)}`).join(' '));
}
