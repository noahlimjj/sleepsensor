#!/bin/sh
set -e

echo "=== Xcode Cloud: Post Clone Script Started ==="
echo "Script location: $0"
echo "Current directory: $(pwd)"

# Resolve repository root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../package.json" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "$SCRIPT_DIR/../../package.json" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -f "$SCRIPT_DIR/../../../package.json" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
else
    REPO_ROOT="$(pwd)"
fi

echo "Resolved REPO_ROOT: $REPO_ROOT"

# Verify workspace exists
if [ -d "$REPO_ROOT/ios/App/App.xcworkspace" ]; then
    echo "✓ ios/App/App.xcworkspace found"
else
    echo "⚠ Workspace not found at expected location, searching..."
    find "$REPO_ROOT" -name "*.xcworkspace" -maxdepth 4
fi

# Verify Capacitor pod sources exist
if [ -d "$REPO_ROOT/node_modules/@capacitor/ios" ]; then
    echo "✓ @capacitor/ios sources found"
else
    echo "⚠ @capacitor/ios not found in node_modules"
fi

if [ -d "$REPO_ROOT/node_modules/@capacitor/app" ]; then
    echo "✓ @capacitor/app sources found"
else
    echo "⚠ @capacitor/app not found in node_modules"
fi

if [ -d "$REPO_ROOT/node_modules/@capacitor/device" ]; then
    echo "✓ @capacitor/device sources found"
else
    echo "⚠ @capacitor/device not found in node_modules"
fi

echo "=== Xcode Cloud: Post Clone Script Complete ==="
