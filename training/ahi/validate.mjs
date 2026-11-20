// End-to-end: plays every labelled hour through the app's ApneaDetector (the
// same class the engine uses) and compares events per hour with the sleep study.
import { loadAll, levels } from './hours.mjs';
import { ApneaDetector } from '../../js/apnea-detector.js';

const pts = [];
let tp = 0, nEst = 0, nRef = 0;
for (const d of loadAll()) {
  const lv = levels(d.frames, [5]);
  const det = new ApneaDetector();
  let wall = 0;
  for (let i = 0; i < lv.length; i += 20) {
    wall += 2000;
    det.feed({ type: 'other', confidence: 0 }, { breath: lv.slice(i, i + 20), rms: 0, peak: 0, zcr: 0 }, wall);
  }
  // event level: a detected pause counts when its recovery falls at the end of a scored event
  const used = new Set();
  for (const e of det.events) {
    const t = e.endTime / 1000 + d.t0;
    const j = d.resp.findIndex((r, i) => !used.has(i) && t >= r.start + 5 && t <= r.start + r.dur + 8);
    if (j >= 0) { used.add(j); tp++; }
  }
  nEst += det.events.length;
  nRef += d.resp.length;
  const ref = d.resp.length / d.hours;
  const est = det.events.length / d.hours;
  pts.push([ref, est]);
  console.log(`${d.id.slice(4, 8)} hour ${d.seg}  sleep study ${ref.toFixed(0).padStart(3)}/h  app ${est.toFixed(0).padStart(3)}/h`);
}
const m = pts.length;
const mx = pts.reduce((s, x) => s + x[1], 0) / m, my = pts.reduce((s, x) => s + x[0], 0) / m;
const r = pts.reduce((s, x) => s + (x[1] - mx) * (x[0] - my), 0) / Math.sqrt(pts.reduce((s, x) => s + (x[1] - mx) ** 2, 0) * pts.reduce((s, x) => s + (x[0] - my) ** 2, 0));
const tier = (a) => (a < 5 ? 0 : a < 15 ? 1 : a < 30 ? 2 : 3);
console.log(`${m} hours (weights were fitted on these same hours; see lopo.mjs for the held-out numbers)`);
console.log(`r ${r.toFixed(2)}  mean abs error ${(pts.reduce((s, x) => s + Math.abs(x[0] - x[1]), 0) / m).toFixed(1)}/h  bias ${(mx - my).toFixed(1)}  same tier ${pts.filter((x) => tier(x[0]) === tier(x[1])).length}/${m}  within one tier ${pts.filter((x) => Math.abs(tier(x[0]) - tier(x[1])) <= 1).length}/${m}`);
console.log(`event level: ${tp} of ${nEst} detected pauses match a scored event (precision ${(tp / nEst).toFixed(2)}), ${tp} of ${nRef} scored events found (recall ${(tp / nRef).toFixed(2)})`);
