// The audio worklet is a *classic* script (no import/export — that's required
// for AudioWorklet.addModule and Safari). It exposes its pure DSP helpers via a
// CommonJS guard for testing. Since the app package is ESM, we evaluate that
// classic script in a CJS-shaped sandbox here to pull the helpers out.
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../js/audio-worklet-processor.js', import.meta.url), 'utf8');
const mod = { exports: {} };
// eslint-disable-next-line no-new-func
const factory = new Function('module', 'exports', `${src}\nreturn module.exports;`);
export const dsp = factory(mod, mod.exports);
