#!/usr/bin/env node
/*
 * prepare-ios.mjs — idempotent patches to the generated ios/ project that a
 * Capacitor plugin can't contribute itself.
 *
 * Run after `npx cap add ios` (and safe to re-run):
 *   - Info.plist: microphone + background-audio + bluetooth usage keys
 *   - App target: enable the "Audio" background mode (Info.plist only — no
 *     entitlement needed, so this works with free / personal-team signing)
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLIST = join(ROOT, 'ios/App/App/Info.plist');

if (!existsSync(PLIST)) {
  console.error(`✖ ${PLIST} not found — run "npx cap add ios" first.`);
  process.exit(1);
}

const MIC_DESC =
  'SleepSensor listens through the microphone while you sleep to detect snoring and teeth grinding. All audio is processed on your device and never uploaded.';

function plist(...args) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', args.join(' '), PLIST], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function has(key) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, PLIST], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function setString(key, value) {
  if (has(key)) plist(`Set :${key}`, `"${value}"`);
  else plist(`Add :${key} string`, `"${value}"`);
  console.log(`  ✓ ${key}`);
}

// --- usage-description strings ------------------------------------------------
setString('NSMicrophoneUsageDescription', MIC_DESC);
setString(
  'NSBluetoothAlwaysUsageDescription',
  'SleepSensor can listen through Bluetooth headphones or a paired mic while you sleep.'
);

// --- background audio mode --------------------------------------------------
if (!has('UIBackgroundModes')) {
  plist('Add :UIBackgroundModes array');
}
// rebuild the array so re-runs stay clean
try {
  plist('Delete :UIBackgroundModes');
} catch {
  /* wasn't there */
}
plist('Add :UIBackgroundModes array');
plist('Add :UIBackgroundModes:0 string audio');
console.log('  ✓ UIBackgroundModes → [audio]');

// keep the app responsive to lock-screen audio-session events
if (!has('UIApplicationSupportsIndirectInputEvents')) {
  plist('Add :UIApplicationSupportsIndirectInputEvents bool true');
  console.log('  ✓ UIApplicationSupportsIndirectInputEvents');
}

console.log('\niOS Info.plist patched.');
