#!/usr/bin/env bash
# One-shot Capacitor setup for SleepSensor. Adds the iOS + Android projects and
# copies the native BackgroundRecorder plugin + manifest/plist changes into place.
#
#   npm install            # first, to get @capacitor/* dev deps
#   bash scripts/setup-capacitor.sh
#
# Re-run safe: it re-copies the native files (does not re-add existing platforms).
set -euo pipefail
cd "$(dirname "$0")/.."

have() { command -v "$1" >/dev/null 2>&1; }

echo "▸ capacitor sync (web assets)"
npx cap copy || true

# ---------- iOS ----------
if [ "$(uname)" = "Darwin" ]; then
  if [ ! -d ios ]; then
    echo "▸ adding iOS platform"
    npx cap add ios
  fi
  DEST="ios/App/App"
  echo "▸ copying iOS plugin -> $DEST"
  cp native/ios/BackgroundRecorder.swift "$DEST/"
  cp native/ios/BackgroundRecorder.m "$DEST/"
  echo "  ! merge native/ios/Info.plist.additions.xml into $DEST/Info.plist (see docs/CAPACITOR.md)"
  npx cap sync ios || true
else
  echo "▸ skipping iOS (not macOS)"
fi

# ---------- Android ----------
if [ ! -d android ]; then
  echo "▸ adding Android platform"
  npx cap add android
fi
PKG_DIR="android/app/src/main/java/app/sleepsensor/monitor"
mkdir -p "$PKG_DIR"
echo "▸ copying Android plugin -> $PKG_DIR"
cp native/android/BackgroundRecorderPlugin.java "$PKG_DIR/"
cp native/android/RecordingService.java "$PKG_DIR/"
echo "  ! add 'registerPlugin(BackgroundRecorderPlugin.class);' to MainActivity.onCreate"
echo "  ! merge native/android/AndroidManifest.additions.xml into android/app/src/main/AndroidManifest.xml"
npx cap sync android || true

echo
echo "Done. Next:"
echo "  - iOS:     npx cap open ios     (then finish Info.plist, set signing, run)"
echo "  - Android: npx cap open android (then finish MainActivity + manifest, run)"
echo "  Full checklist: docs/CAPACITOR.md"
