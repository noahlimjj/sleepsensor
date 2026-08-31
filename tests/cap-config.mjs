// cap-config.mjs — static sanity checks for the Capacitor / native-app setup.
// Runs with no Android SDK / Xcode: it validates the wiring that CI depends on.
import { readFileSync, existsSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let fails = 0;
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

// Mirror of Capacitor CLI's fixName() (plugin.js) — pod / gradle module name.
function fixName(name) {
  name = name.replace(/\//g, '_').replace(/-/g, '_').replace(/@/g, '').replace(/_\w/g, (m) => m[1].toUpperCase());
  return name.charAt(0).toUpperCase() + name.slice(1);
}

console.log('\n▸ capacitor.config.json');
const cfg = json('capacitor.config.json');
check(cfg.webDir === 'www', 'webDir is "www"');
check(cfg.appId === 'app.sleepsensor.monitor', 'appId is app.sleepsensor.monitor');
check(cfg.ios && cfg.ios.limitsNavigationsToAppBoundDomains === false, 'app-bound-domains limit off (Firebase/OAuth need it)');

console.log('\n▸ local plugin package');
const pkg = json('plugins/background-recorder/package.json');
check(pkg.name === '@sleepsensor/background-recorder', 'package name');
check(!!pkg.capacitor && !!pkg.capacitor.ios && !!pkg.capacitor.android, 'has capacitor.ios + capacitor.android manifest');
const podName = fixName(pkg.name);
check(podName === 'SleepsensorBackgroundRecorder', `derived native module name = ${podName}`);
check(existsSync(join(ROOT, `plugins/background-recorder/${podName}.podspec`)), `${podName}.podspec exists (name must match)`);
const podspec = read(`plugins/background-recorder/${podName}.podspec`);
check(podspec.includes(`s.name = '${podName}'`), 'podspec s.name matches derived name');
check(podspec.includes("s.dependency 'Capacitor'"), 'podspec depends on Capacitor');

console.log('\n▸ iOS plugin sources');
for (const f of ['ios/Sources/BackgroundRecorderPlugin/BackgroundRecorder.swift', 'ios/Sources/BackgroundRecorderPlugin/BackgroundRecorder.m']) {
  check(existsSync(join(ROOT, 'plugins/background-recorder', f)), f);
}
const swift = read('plugins/background-recorder/ios/Sources/BackgroundRecorderPlugin/BackgroundRecorder.swift');
check(/@objc\(BackgroundRecorder\)/.test(swift), 'Swift class registered as @objc(BackgroundRecorder)');
const objc = read('plugins/background-recorder/ios/Sources/BackgroundRecorderPlugin/BackgroundRecorder.m');
check(/CAP_PLUGIN\(BackgroundRecorder, "BackgroundRecorder"/.test(objc), 'CAP_PLUGIN macro exports "BackgroundRecorder"');

console.log('\n▸ Android plugin module');
const gradle = read('plugins/background-recorder/android/build.gradle');
check(/namespace "app\.sleepsensor\.backgroundrecorder"/.test(gradle), 'gradle namespace set');
check(/project\(':capacitor-android'\)/.test(gradle), 'depends on :capacitor-android');
const amanifest = read('plugins/background-recorder/android/src/main/AndroidManifest.xml');
check(/RECORD_AUDIO/.test(amanifest) && /FOREGROUND_SERVICE_MICROPHONE/.test(amanifest), 'manifest declares mic + FGS permissions');
check(/RecordingService/.test(amanifest) && /foregroundServiceType="microphone"/.test(amanifest), 'manifest declares the <service>');
const plugin = read('plugins/background-recorder/android/src/main/java/app/sleepsensor/backgroundrecorder/BackgroundRecorderPlugin.java');
check(/package app\.sleepsensor\.backgroundrecorder;/.test(plugin), 'plugin java package matches namespace');
check(/@CapacitorPlugin\(\s*name = "BackgroundRecorder"/.test(plugin), '@CapacitorPlugin name = "BackgroundRecorder"');
const svc = read('plugins/background-recorder/android/src/main/java/app/sleepsensor/backgroundrecorder/RecordingService.java');
check(/package app\.sleepsensor\.backgroundrecorder;/.test(svc), 'service java package matches');

console.log('\n▸ native-bridge talks to the same plugin id');
const bridge = read('js/native-bridge.js');
check(/registerPlugin\('BackgroundRecorder'\)|plugin\('BackgroundRecorder'\)/.test(bridge), "native-bridge resolves 'BackgroundRecorder'");

console.log('\n▸ service worker is disabled under Capacitor');
const app = read('js/app.js');
check(/isNativePlatform\(\)/.test(app) && /!_isNative/.test(app), 'app.js skips SW registration when native');

console.log('\n▸ build-web.mjs output');
execFileSync('node', [join(ROOT, 'scripts/build-web.mjs')], { stdio: 'pipe' });
for (const f of ['www/index.html', 'www/js/app.js', 'www/js/native-bridge.js', 'www/css/index.css', 'www/manifest.json', 'www/build-info.json']) {
  check(existsSync(join(ROOT, f)), f);
}
check(!existsSync(join(ROOT, 'www/node_modules')) && !existsSync(join(ROOT, 'www/tests')), 'www/ excludes node_modules + tests');

console.log('\n▸ prepare-ios.mjs (syntax + plist logic, dry run)');
// can't run PlistBuddy logic without ios/, but ensure the script parses
try {
  execFileSync('node', ['--check', join(ROOT, 'scripts/prepare-ios.mjs')], { stdio: 'pipe' });
  check(true, 'prepare-ios.mjs parses');
} catch (e) {
  check(false, 'prepare-ios.mjs parses: ' + e.message);
}

console.log('\n▸ CI workflow');
const wf = read('.github/workflows/build.yml');
check(/runs-on: macos-14/.test(wf), 'iOS job on macos runner');
check(/CODE_SIGNING_ALLOWED=NO/.test(wf), 'iOS build is unsigned (SideStore/AltStore re-sign on install)');
check(/assembleDebug/.test(wf), 'Android job builds debug APK');
check(/npx cap add ios/.test(wf) && /npx cap add android/.test(wf), 'CI regenerates both platforms');

console.log(`\n${'─'.repeat(48)}`);
console.log(fails ? `  cap-config: ${fails} failed` : '  cap-config: all checks passed');
// leave www/ in place (gitignored); nothing to clean
process.exit(fails ? 1 : 0);
