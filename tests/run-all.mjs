// Runs every backend unit test suite in one process.
import { summary } from './lib.mjs';
import { run as dsp } from './test-dsp.mjs';
import { run as features } from './test-features.mjs';
import { run as model } from './test-model.mjs';
import { run as classifier } from './test-classifier.mjs';
import { run as storage } from './test-storage.mjs';
import { run as wav } from './test-wav.mjs';
import { run as engine } from './test-engine.mjs';

console.log('SleepSensor backend test suite');
console.log('='.repeat(48));

try {
  await dsp();
  await features();
  await model();
  await classifier();
  await storage();
  await wav();
  await engine();
} catch (err) {
  console.error('\nFATAL:', err);
  process.exit(1);
}

summary();
