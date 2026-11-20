// Fits the shipped weights on every labelled hour and picks the probability
// cut-off at which the number of kept events equals the number scored in the
// sleep studies. Paste the output into js/apnea-detector.js.
import { prepare } from './data.mjs';
import { P, FEATS } from './dips.mjs';
import { fit, prob } from './logistic.mjs';
const data = prepare(P);
const w = fit(data.flatMap((x) => x.c.map((c) => c.f)), data.flatMap((x) => x.y), { l2: 0.003, iters: 6000 });
const ps = data.flatMap((h) => h.c.map((c) => prob(w, c.f))).sort((a, b) => b - a);
const total = data.reduce((s, h) => s + h.resp.length, 0);
const thr = (ps[total - 1] + ps[total]) / 2;
console.log('features', FEATS.join(', '), ', bias');
console.log('BREATH_WEIGHTS =', JSON.stringify(Array.from(w, (x) => +x.toFixed(3))));
console.log('minProb =', thr.toFixed(3), ` (${data.length} hours, ${new Set(data.map((d) => d.id)).size} patients, ${total} scored events)`);
