# SleepSensor — installing the native app

The web app pauses audio when the phone screen locks (a hard browser rule —
absolute on iOS). The installable iOS / Android build removes that limit so
SleepSensor records the whole night with the screen off.

There is no App Store / Play Store listing. You install the build produced by
`.github/workflows/build.yml` yourself. The easiest starting point is the
platform-aware page at <https://sleepsensor.vercel.app/install>, which points at
the latest GitHub release.

## TL;DR

| Platform | Method | Cost | Lasts |
| --- | --- | --- | --- |
| iPhone | SideStore + free Apple ID | free | 7 days, auto-renews on-device |
| iPhone | AltStore + free Apple ID | free | 7 days, needs a computer to refresh |
| iPhone | Ad-hoc `itms-services` (see `docs/ADHOC-IOS.md`) | $99/yr dev program | 1 year |
| iPhone | TestFlight (see `docs/ADHOC-IOS.md`) | $99/yr dev program | 90 days per build |
| Android | Sideload `SleepSensor.apk` | free | no expiry |
| Android | Play Store internal testing | $25 once | no expiry |

The build files come from
<https://github.com/noahlimjj/sleepsensor/releases/latest>:
`SleepSensor.apk` and `SleepSensor-unsigned.ipa`.

## iPhone — SideStore (free)

SideStore re-signs the app every 7 days in the background over an on-device
WireGuard VPN, so after the one-time setup you never need a computer. A free
Apple ID allows 3 sideloaded apps at once.

Background audio (`UIBackgroundModes: audio`) is an Info.plist key, not a paid
entitlement, so it works with free personal-team signing — the whole-night
recording behaves exactly like a paid build.

1. Install SideStore: follow <https://sidestore.io> (one-time, ~15 min — it
   pairs with a computer once, then runs standalone).
2. On the iPhone, download `SleepSensor-unsigned.ipa` — from the
   [/install](https://sleepsensor.vercel.app/install) page or straight from the
   [latest release](https://github.com/noahlimjj/sleepsensor/releases/latest/download/SleepSensor-unsigned.ipa).
3. In SideStore: **+** (top-left) → pick the `.ipa` → sign in with your Apple ID
   when prompted. SideStore re-signs and installs it.
4. First launch: allow the microphone. See "After install" below.

SideStore refreshes the app automatically. If it ever shows as expired, open
SideStore → **My Apps** → refresh.

**Desktop alternative — AltStore.** Same free-Apple-ID model, but the 7-day
refresh needs AltServer running on a computer on the same Wi-Fi; otherwise the
steps are identical. Use it if you already run AltStore.

## iPhone — paid options (brief)

If you have the $99/yr Apple Developer Program, you can distribute a properly
signed build that lasts much longer:

- **Ad-hoc** — a signed `.ipa` + an `itms-services://` manifest; tapping the
  link on a registered device installs it, valid 1 year. The
  [/install](https://sleepsensor.vercel.app/install) page shows an "Install now"
  button once `install.html`'s `CONFIG.itmsManifestUrl` is filled in.
- **TestFlight** — upload to App Store Connect, invite testers by email; each
  build is good for 90 days, up to 100 internal / 10,000 external testers.

Both are covered in `docs/ADHOC-IOS.md`.

## Android — sideload the APK

The APK is debug-signed, which is enough to install directly.

1. Download `SleepSensor.apk` — from the
   [/install](https://sleepsensor.vercel.app/install) page or the
   [latest release](https://github.com/noahlimjj/sleepsensor/releases/latest/download/SleepSensor.apk).
2. Open it. Android asks to allow installs from this source — tap
   **Settings → Allow from this source**, go back, **Install**.
3. First launch: grant the **microphone** permission.
4. When SleepSensor asks, allow it to **ignore battery optimisation** — the
   system dialog is triggered by the app (`requestBatteryOptimizationExemption`
   in the plugin). Without this, Android may freeze the recording service after
   the screen has been off for a while.

## After install

- **Microphone prompt** on the first recording — required; audio is processed
  on the device and never uploaded.
- **Android**: a persistent low-priority notification stays in the shade for the
  whole session. That is the foreground service keeping the process alive — do
  not swipe it away.
- **iOS**: the status bar shows the orange microphone dot the entire time the
  session runs. This is enforced by iOS and cannot be hidden.
- **Keep it plugged in.** All-night recording plus on-device inference draws
  roughly 10 % battery per hour.
- **Auto-stop**: a session ends itself after 14 hours
  (`stopReason: 'max-duration'`) so a forgotten recording never runs
  indefinitely.
- Normal screen-lock and pressing the home button are fine on both platforms.
  Force-quitting the app is not (see Troubleshooting).

## Troubleshooting

**iOS — "Untrusted Developer" / app won't open.** Settings → General → **VPN &
Device Management** → tap your Apple ID / developer profile → **Trust**. Then
relaunch.

**iOS — app expired ("Unable to Verify App" / it was deleted).** The 7-day free
signature lapsed. Open SideStore → **My Apps** → refresh (AltStore: make sure
AltServer is running on the same Wi-Fi). Your data is untouched — refreshing
re-signs the same install.

**iOS — recording stops overnight.** Check you did not force-quit (swipe up)
the app before sleeping — iOS permanently stops background audio for a
force-quit app; there is no workaround. A locked screen with the app still
running in the background is fine.

**Android — recording has gaps / stops.** Confirm the battery-optimisation
exemption is granted: Settings → Apps → SleepSensor → Battery → **Unrestricted**.
Aggressive OEMs (Xiaomi, OnePlus, Huawei, Samsung to a lesser degree) have extra
"auto-start" / "app lock" screens beyond that — see
<https://dontkillmyapp.com> for the exact path on your device. The foreground
service is `START_STICKY`, so on a stock Android it restarts itself after a
low-memory kill.

## Build it yourself

```bash
npm install                     # installs @capacitor/* + links the local plugin
bash scripts/setup-capacitor.sh # build-web → cap add android/ios → prepare-ios → cap sync
```

Then:

- **Android**: `cd android && ./gradlew assembleDebug`
  (APK in `android/app/build/outputs/apk/debug/`), or open `android/` in Android
  Studio.
- **iOS**: `cd ios/App && pod install && open App.xcworkspace`, set your signing
  team, run on a device.

Or just push to `main` (or open a PR) — `.github/workflows/build.yml` builds the
APK and an unsigned IPA and uploads them as artifacts. Pushing a `v*` tag also
attaches both to a GitHub Release, which is what the `/install` page links to.

See `docs/CAPACITOR.md` for the architecture.
