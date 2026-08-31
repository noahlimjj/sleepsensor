// smoothing.js — HMM forward-filter temporal smoothing.
import { section, ok, eq, pass } from './lib.mjs';
import { HmmSmoother } from '../js/smoothing.js';

export function run() {
  section('smoothing.js — HMM temporal smoothing');

  const S = () => new HmmSmoother({ classes: ['quiet', 'snoring', 'bruxism', 'noise'] });

  // --- a single noisy window does not flip a stable state ---
  {
    const s = S();
    for (let i = 0; i < 5; i++) s.push({ snoring: 0.9, noise: 0.1 });
    const before = s.peek().type;
    const out = s.push({ bruxism: 0.55, snoring: 0.25, noise: 0.2 }); // one bad frame
    eq(before, 'snoring', 'settled into snoring');
    eq(out.type, 'snoring', 'one conflicting window does not flip the state');
  }

  // --- a sustained change does switch, after a short lag ---
  {
    const s = S();
    for (let i = 0; i < 6; i++) s.push({ snoring: 0.9, noise: 0.1 });
    let t;
    let switched = -1;
    for (let i = 0; i < 6; i++) {
      t = s.push({ bruxism: 0.85, noise: 0.15 });
      if (t.type === 'bruxism' && switched < 0) switched = i;
    }
    eq(t.type, 'bruxism', 'sustained bruxism eventually wins');
    ok(switched >= 1 && switched <= 4, `switch takes a couple of windows (after ${switched})`);
  }

  // --- smoothing raises confidence on a consistent signal ---
  {
    const s = S();
    let last;
    for (let i = 0; i < 8; i++) last = s.push({ snoring: 0.7, noise: 0.3 });
    ok(last.confidence > 0.9, `confidence firms up on consistent input (${last.confidence.toFixed(2)})`);
  }

  // --- accepts array or object scores; probs sum to 1 ---
  {
    const s = S();
    const r = s.push([0.1, 0.6, 0.2, 0.1]);
    ok(Math.abs(r.probs.reduce((a, b) => a + b, 0) - 1) < 1e-6, 'smoothed probs are normalised');
    eq(r.type, 'snoring', 'array scores handled (index 1 = snoring)');
  }

  // --- reset clears state ---
  {
    const s = S();
    for (let i = 0; i < 8; i++) s.push({ bruxism: 0.95, noise: 0.05 });
    s.reset();
    eq(s.peek().type, 'quiet', 'reset returns to the quiet prior');
  }

  // --- quiet pulls back after an event ends ---
  {
    const s = S();
    for (let i = 0; i < 6; i++) s.push({ snoring: 0.9, noise: 0.1 });
    let t;
    for (let i = 0; i < 6; i++) t = s.push({ quiet: 1 });
    eq(t.type, 'quiet', 'returns to quiet once the sound stops');
  }

  pass('HMM smoother behaves correctly');
}
