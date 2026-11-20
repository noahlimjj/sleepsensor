// Offline reference for the detector: "sound dip then recovery". For every second, compare the
// breathing-band level in three windows — before (breathing), pause (≥ 10 s
// low) and recovery — relative to a rolling noise floor. Local maxima of the
// recovery jump are candidates; a small logistic model scores them.
// js/apnea-detector.js is the streaming version (check-stream.mjs proves they agree).

export const P = { band: [5], floorWin: 120, floorPct: 0.2, pause: 10, pre: 30, post: 5, minJump: 4, refractory: 15, act: 3 };

export function perSecond(lv, p = P) {
  const n = Math.floor(lv.length / 10);
  const pw = new Float64Array(n); // mean power per second
  const fl = new Float64Array(n); // rolling floor (power)
  for (let s = 0; s < n; s++) {
    let a = 0;
    for (let k = 0; k < 10; k++) a += 10 ** (lv[s * 10 + k] / 10);
    pw[s] = a / 10;
  }
  for (let s = 0; s < n; s++) {
    const w = Array.from(lv.slice(Math.max(0, (s + 1 - p.floorWin) * 10), (s + 1) * 10)).sort((x, y) => x - y);
    fl[s] = 10 ** (w[Math.floor(w.length * p.floorPct)] / 10);
  }
  return { pw, fl, n };
}

export function candidates(lv, p = P) {
  const { pw, fl, n } = perSecond(lv, p);
  const cum = new Float64Array(n + 1);
  for (let s = 0; s < n; s++) cum[s + 1] = cum[s] + pw[s];
  const mean = (a, b) => (cum[Math.min(n, b)] - cum[Math.max(0, a)]) / Math.max(1, Math.min(n, b) - Math.max(0, a));
  const dB = (x, f) => 10 * Math.log10(Math.max(x / f, 1e-3));
  const rows = [];
  for (let t = p.pre + p.pause; t + p.post <= n; t++) {
    const f = fl[t - 1];
    const lPause = dB(mean(t - p.pause, t), f);
    const lPre = dB(mean(t - p.pause - p.pre, t - p.pause), f);
    const lPost = dB(mean(t, t + p.post), f);
    rows.push({ t, lPause, lPre, lPost, jump: lPost - lPause, drop: lPre - lPause });
    void 0;
  }
  // local maxima of the recovery jump
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.jump < p.minJump) continue;
    let top = true;
    for (let j = Math.max(0, i - p.refractory); j <= Math.min(rows.length - 1, i + p.refractory); j++) {
      if (rows[j].jump > r.jump || (rows[j].jump === r.jump && j < i)) { top = false; break; }
    }
    if (top) out.push(r);
  }
  for (let i = 0; i < out.length; i++) {
    let near = 0;
    for (let j = i - 1; j >= 0 && out[i].t - out[j].t <= 180; j--) near++;
    const c = out[i];
    c.end = c.t;
    const ex = (s) => (s >= 0 && s < n ? 10 * Math.log10(Math.max(pw[s] / fl[s], 1e-3)) : 0);
    let gap = 0; // how long it had really been quiet
    while (gap < 90 && ex(c.t - 1 - gap) < p.act) gap++;
    const g0 = c.t - gap; // quiet began here
    let preAct = 0;
    for (let s2 = g0 - 30; s2 < g0; s2++) if (ex(s2) >= p.act) preAct++;
    let postAct = 0;
    for (let s2 = c.t; s2 < c.t + 30; s2++) if (ex(s2) >= p.act) postAct++;
    c.gap = gap;
    c.start = g0;
    c.f = [
      Math.min(c.jump, 15) / 5,
      Math.max(-5, Math.min(c.drop, 15)) / 5,
      Math.min(c.lPause, 10) / 5,
      Math.min(near, 8) / 4,
      Math.min(gap, 40) / 20,
      gap >= 15 ? 1 : 0,
      preAct / 15,
      postAct / 15,
      postAct >= 20 ? 1 : 0,
    ];
  }
  return out;
}
export const FEATS = ['jump', 'drop', 'lPause', 'near', 'gap', 'gap15', 'preAct', 'postAct', 'postLong'];

export function label(c, d) {
  // the recovery should fall at the end of a scored event (allowing scorer/sensor lag)
  const t = c.t + d.t0;
  return d.resp.some((r) => t >= r.start + 5 && t <= r.start + r.dur + 8) ? 1 : 0;
}
