# SleepSensor — native app (Capacitor)

The web app pauses audio when the phone screen locks — a hard browser rule
(absolute on iOS, common on Android). The Capacitor build removes that limit so
SleepSensor records the **whole night with the screen off**.

## How it stays alive

| | Mechanism |
| --- | --- |
| **iOS** | `UIBackgroundModes: audio` + an **active `AVAudioSession` (`.playAndRecord`)** with a silent buffer looping through `AVAudioEngine`. iOS keeps the app running because it is continuously producing/consuming audio. The WebView's own `getUserMedia` + `AudioWorklet` keep running inside that session. A lock-screen "Now Playing" tile reinforces the audio-app status. |
| **Android** | A **foreground `Service`** (`RecordingService`) with a persistent low-priority notification + `foregroundServiceType="microphone"` + a `PARTIAL_WAKE_LOCK`. The process (and the WebView audio graph) can't be frozen while the service runs. `START_STICKY` restarts it if the OS kills it. |

The JS side (`js/native-bridge.js`) auto-detects Capacitor; on the plain web
every call is a no-op and the app falls back to the Screen Wake Lock + watchdog.

## One-time build

```bash
npm install                     # pulls @capacitor/* dev deps
npx cap init                    # only if capacitor.config.json is missing (it isn't)
npm run cap:setup               # adds ios/ + android/, copies the native plugin
```

Then finish the two platform-specific bits the script can't safely auto-merge:

### iOS  (`npx cap open ios`)

1. **Info.plist** — merge `native/ios/Info.plist.additions.xml`:
   - `NSMicrophoneUsageDescription`
   - `UIBackgroundModes` → `audio`
2. Confirm `BackgroundRecorder.swift` + `BackgroundRecorder.m` are in the
   `App` target (Xcode → target → Build Phases → Compile Sources).
3. Signing: set your Apple team. Capabilities → **Background Modes → Audio**.
4. Run on a real device (background audio doesn't work in the simulator).

### Android  (`npx cap open android`)

1. **MainActivity** — add `registerPlugin(BackgroundRecorderPlugin.class);` to
   `onCreate` (see `native/android/MainActivity.additions.java`).
2. **AndroidManifest.xml** — merge `native/android/AndroidManifest.additions.xml`
   (6 permissions + the `<service>` entry).
3. `minSdkVersion` ≥ 24 (Capacitor default is fine).
4. Optional: add a monochrome `ic_stat_name` drawable for the notification icon
   (falls back to a system icon otherwise).

After any web change: `npx cap copy` (or `npm run cap:sync`).

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
- The bundled web assets load `tf.min.js` from the jsdelivr CDN. For a fully
  offline app, vendor it locally (`vendor/tf.min.js`) and point `index.html` at
  it — otherwise the first launch needs a connection to cache it.
- Some Android OEMs (Xiaomi, Huawei, OnePlus…) have extra "app lock" / "auto
  start" settings beyond battery optimisation. Point users to
  [dontkillmyapp.com](https://dontkillmyapp.com) if they see gaps.
- A true belt-and-braces design would also capture audio **natively** as a
  fallback for the rare case the WebView audio graph dies anyway. The plugin
  interface is structured to allow adding that later without touching the JS
  engine.
