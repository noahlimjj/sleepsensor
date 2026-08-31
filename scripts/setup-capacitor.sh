#!/usr/bin/env bash
# One-shot Capacitor setup for SleepSensor.
#
#   npm install                 # get deps + link the local plugin
#   bash scripts/setup-capacitor.sh
#
# The native background-recording code ships as a local Capacitor plugin
# (plugins/background-recorder) so `npx cap sync` wires it into both platforms
# automatically — no manual Xcode / Gradle edits. The only thing a plugin can't
# contribute is the app's Info.plist keys; scripts/prepare-ios.mjs adds those.
#
# Re-run safe.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ building web assets -> www/"
node scripts/build-web.mjs

if [ ! -d android ]; then
  echo "▸ adding Android platform"
  npx cap add android
fi

if [ "$(uname)" = "Darwin" ] && [ ! -d ios ]; then
  echo "▸ adding iOS platform"
  npx cap add ios || true   # pod install needs CocoaPods + Xcode
fi

if [ -d ios ]; then
  echo "▸ patching iOS Info.plist"
  node scripts/prepare-ios.mjs
fi

echo "▸ cap sync"
npx cap sync

echo
echo "Done. Build:"
echo "  Android:  cd android && ./gradlew assembleDebug   (apk in app/build/outputs/apk/debug/)"
echo "  iOS:      cd ios/App && pod install && open App.xcworkspace"
echo
echo "Or just push — .github/workflows/build.yml builds both in CI."
