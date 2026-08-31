# SleepSensor — native app (Capacitor)

The web app pauses audio when the phone screen locks — a hard browser rule
(absolute on iOS, common on Android). The Capacitor build removes that limit so
SleepSensor records the **whole night with the screen off**.

`ios/` and `android/` are **generated** — they are not hand-edited and can be
deleted and re-created at any time. All the native code lives in a local
Capacitor plugin package (`plugins/background-recorder/`); `npx cap sync` wires
it into both platforms with no manual Xcode / Gradle steps. The only project
file a plugin cannot contribute — the app's `Info.plist` — is patched by
`scripts/prepare-ios.mjs`.

## How it stays alive

| | Mechanism |
| --- | --- |
| **iOS** | `UIBackgroundModes: audio` + an **active `AVAudioSession` (`.playAndRecord`)** with a silent buffer looping through `AVAudioEngine`. iOS keeps the app running because it is continuously producing/consuming audio. The WebView's own `getUserMedia` + `AudioWorklet` keep running inside that session. A lock-screen "Now Playing" tile reinforces the audio-app status. |
| **Android** | A **foreground `Service`** (`RecordingService`) with a persistent low-priority notification + `foregroundServiceType="microphone"` + a `PARTIAL_WAKE_LOCK`. The process (and the WebView audio graph) can't be frozen while the service runs. `START_STICKY` restarts it if the OS kills it. |

`UIBackgroundModes: audio` is an Info.plist key, **not** a paid entitlement, so
the background recording works with free / personal-team signing. The $99/yr
Apple Developer Program is only needed for App Store / TestFlight / public
ad-hoc distribution.

The JS side (`js/native-bridge.js`) auto-detects Capacitor; on the plain web
every call is a no-op and the app falls back to the Screen Wake Lock + watchdog.

## The plugin package

`plugins/background-recorder/` — an npm package `@sleepsensor/background-recorder`,
linked from the root `package.json` as `"file:plugins/background-recorder"`.

```
plugins/background-recorder/
  package.json                     name + the "capacitor": { ios, android } manifest
  SleepsensorBackgroundRecorder.podspec   pod name MUST equal Capacitor's fixName(pkg.name)
  dist/esm/index.d.ts              the JS plugin interface (start/stop/update/…perms)
  ios/Sources/BackgroundRecorderPlugin/
      BackgroundRecorder.swift     @objc(BackgroundRecorder) — AVAudioSession + silent buffer
      BackgroundRecorder.m         CAP_PLUGIN(BackgroundRecorder, "BackgroundRecorder", …)
  android/
      build.gradle                 com.android.library, namespace app.sleepsensor.backgroundrecorder
      src/main/AndroidManifest.xml permissions + the <service> (merged into the app manifest)
      src/main/java/app/sleepsensor/backgroundrecorder/
          BackgroundRecorderPlugin.java   @CapacitorPlugin(name = "BackgroundRecorder")
          RecordingService.java           foreground Service + PARTIAL_WAKE_LOCK + START_STICKY
```

The JS plugin id is `"BackgroundRecorder"` everywhere — the `@objc` name, the
`CAP_PLUGIN` macro, the `@CapacitorPlugin` annotation, and
`Capacitor.registerPlugin('BackgroundRecorder')` in `js/native-bridge.js`.

### How `cap sync` wires it in

Because the package is a dependency with a `capacitor` manifest, `npx cap sync`:

- **iOS** — adds the podspec to `ios/App/Podfile` and runs `pod install`, so the
  Swift/ObjC sources compile into the app. The `.m` file's `CAP_PLUGIN` macro
  registers the plugin with the bridge automatically — no `registerPlugin` call
  in `AppDelegate` / `MainViewController`.
- **Android** — adds `include ':background-recorder'` (+ `project(...)`) to
  `android/settings.gradle` and the `app/build.gradle` dependency, and Capacitor
  auto-discovers the `@CapacitorPlugin` class, so no edit to `MainActivity`. The
  plugin's `AndroidManifest.xml` (permissions + `<service>`) is manifest-merged
  into the app.

`scripts/prepare-ios.mjs` then patches `ios/App/App/Info.plist` (idempotent):
`NSMicrophoneUsageDescription`, `NSBluetoothAlwaysUsageDescription`,
`UIBackgroundModes → [audio]`, `UIApplicationSupportsIndirectInputEvents`.

`scripts/build-web.mjs` assembles the runtime web files (`index.html`, `js/`,
`css/`, `assets/`, `manifest.json`, `sw.js`) into `www/` — Capacitor's `webDir`.
Vercel keeps serving the repo root; `www/` only feeds the native builds.

`capacitor.config.json`: appId `app.sleepsensor.monitor`, `webDir: "www"`,
`ios.limitsNavigationsToAppBoundDomains: false` (Firebase + Google OAuth need it
off).

## Build locally

```bash
npm install                      # installs @capacitor/* and links the local plugin
bash scripts/setup-capacitor.sh  # build-web → cap add android/ios → prepare-ios → cap sync
```

`setup-capacitor.sh` is re-run safe. Then:

- **Android**: `cd android && ./gradlew assembleDebug`
  (APK → `android/app/build/outputs/apk/debug/`), or `npm run cap:android` to
  open Android Studio.
- **iOS** (macOS only): `cd ios/App && pod install && open App.xcworkspace`, set
  a signing team, run on a real device (background audio does not work in the
  simulator). `npm run cap:ios` opens Xcode.

After any web-only change: `npm run cap:sync` (or `npx cap copy`).

## CI

`.github/workflows/build.yml` (push to `main`, `v*` tags, or manual):

- **`android`** (ubuntu) — `npm ci` → `build-web` → `cap add android` →
  `cap sync android` → `./gradlew assembleDebug` → uploads `SleepSensor.apk`.
- **`ios`** (macos-14) — `npm ci` → `build-web` → `cap add ios` →
  `prepare-ios` → `cap sync ios` → `pod install` → unsigned
  `xcodebuild … CODE_SIGNING_ALLOWED=NO` → packages `SleepSensor-unsigned.ipa`.
  Unsigned is intentional: SideStore / AltStore re-sign on install (see
  `docs/SIDELOAD.md`).
- **`release`** (on `v*` tags) — attaches both files to a GitHub Release, which
  is what `install.html` (`/install`) links to.

`.github/workflows/ci.yml` runs `npm test` + `npm run test:cap`
(`tests/cap-config.mjs` — static checks on the plugin wiring: config, podspec
name, plugin ids, manifest permissions, workflow shape; needs no SDK/Xcode).

## Iterating on the native code

1. Edit files under `plugins/background-recorder/**` (or the JS in
   `js/native-bridge.js`).
2. `npm run cap:sync` to pull the changes into a local `ios/` / `android/`, or
   just push — CI regenerates both platforms from scratch every run, so
   `plugins/**` is the single source of truth.
3. If you change the plugin's JS interface, keep `dist/esm/index.d.ts` and
   `js/native-bridge.js` in sync; `tests/cap-config.mjs` checks the plugin id
   matches on both sides.

You do **not** commit `ios/` or `android/` — they are gitignored generated
output.

## Everything that keeps it running all night

Built into the engine (`js/audio-engine.js`) and bridge — no extra wiring:

1. **Native keep-alive** (above) — the core fix.
2. **Screen Wake Lock** (web API) — still acquired; keeps a dimmed screen on if
   the user leaves it unlocked.
3. **Silent keep-alive `AudioBufferSourceNode`** inside the WebAudio graph —
   helps some browsers keep the audio thread hot.
4. **`AudioContext` `statechange` watcher** — auto-`resume()` if the OS
   suspends it, and reports the gap length.
5. **`visibilitychange` / native `appStateChange` / `resume`** — re-acquire the
   wake lock, resume the context, re-arm the native session on foreground.
6. **Audio-interruption handling** — phone call, alarm, Siri, or another app
   grabbing the mic fires `interruptionBegan`/`interruptionEnded`; the engine
   pauses cleanly and auto-resumes (re-activating the session on iOS,
   re-requesting audio focus on Android).
7. **Stall watchdog** — if no audio frames arrive for 9 s while recording, it
   forces a context resume + wake-lock re-acquire and surfaces a `stalled`
   status.
8. **Session checkpointing** — the open session row is persisted every 60 s
   with its running tallies + a `lastCheckpoint` timestamp.
9. **Crash recovery** (`js/session-recovery.js`) — on next launch,
   `recoverStale()` finds any session left open by a crash / OS kill / dead
   battery and finalises it from its last checkpoint, so a partial night still
   shows up in the report (flagged `recovered: true`). **The frontend must call
   this on app init** — see `docs/FRONTEND_INTEGRATION.md` §11.
10. **Battery-optimisation exemption (Android)** — `nativeBridge.prepare()`
    detects if SleepSensor is battery-optimised and returns a warning;
    `requestIgnoreBatteryOptimizations()` opens the system dialog.
11. **Charge check** — `prepare()` warns if the battery is < 50 % and not
    charging (all-night recording is ~8-15 %/hr).
12. **Safety auto-stop** — a session self-terminates after 14 h
    (`stopReason: 'max-duration'`) so a forgotten recording doesn't run forever.
13. **Storage-full guard** — a quota error mid-night stops the session cleanly
    (`stopReason: 'storage-full'`) keeping everything captured so far.
14. **Foreground-service `START_STICKY`** (Android) — the OS restarts the
    service after a low-memory kill.

## Known limits / notes

- **iOS still shows the orange mic dot** in the status bar while recording —
  required by the OS, unavoidable, worth explaining in onboarding.
- Battery: budget a full charge. Recording + on-device inference is ~10 %/hr.
- Some Android OEMs (Xiaomi, Huawei, OnePlus…) have extra "app lock" / "auto
  start" settings beyond battery optimisation. Point users to
  [dontkillmyapp.com](https://dontkillmyapp.com) if they see gaps.
- **Force-quit**: on iOS, swiping the app away permanently stops its background
  audio — unavoidable. On Android the foreground service auto-restarts
  (`START_STICKY`) except on the aggressive OEMs above. Normal screen-lock /
  home-button is fine on both.
- A true belt-and-braces design would also capture audio **natively** as a
  fallback for the rare case the WebView audio graph dies anyway. The plugin
  interface is structured to allow adding that later without touching the JS
  engine.
