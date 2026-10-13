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
import { existsSync, readFileSync, writeFileSync } from 'fs';
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

// App Store Export Compliance (no encryption used)
if (has('ITSAppUsesNonExemptEncryption')) {
  plist('Set :ITSAppUsesNonExemptEncryption false');
} else {
  plist('Add :ITSAppUsesNonExemptEncryption bool false');
}
console.log('  ✓ ITSAppUsesNonExemptEncryption → false');

// Replace legacy armv7 with arm64
try {
  plist('Delete :UIRequiredDeviceCapabilities');
} catch {}
plist('Add :UIRequiredDeviceCapabilities array');
plist('Add :UIRequiredDeviceCapabilities:0 string arm64');
console.log('  ✓ UIRequiredDeviceCapabilities → [arm64]');

// --- project.pbxproj patches -------------------------------------------------
const PBXPROJ = join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj');
if (existsSync(PBXPROJ)) {
  let content = readFileSync(PBXPROJ, 'utf8');
  // Disable user script sandboxing for CocoaPods scripts (Xcode 15+)
  content = content.replace(/ENABLE_USER_SCRIPT_SANDBOXING = YES;/g, 'ENABLE_USER_SCRIPT_SANDBOXING = NO;');
  // Ensure deployment target is at least 15.0 for modern Xcode / Xcode Cloud
  content = content.replace(/IPHONEOS_DEPLOYMENT_TARGET = 13\.0;/g, 'IPHONEOS_DEPLOYMENT_TARGET = 15.0;');
  writeFileSync(PBXPROJ, content, 'utf8');
  console.log('  ✓ ENABLE_USER_SCRIPT_SANDBOXING → NO and IPHONEOS_DEPLOYMENT_TARGET → 15.0 in project.pbxproj');
}

console.log('\niOS Info.plist and project.pbxproj patched.');
