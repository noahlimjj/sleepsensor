#!/bin/sh
set -e

echo "=== Xcode Cloud: Post Clone Script Started ==="
echo "Current directory: $(pwd)"

# Verify workspace exists
if [ -d "ios/App/App.xcworkspace" ]; then
    echo "✓ ios/App/App.xcworkspace found"
elif [ -d "App.xcworkspace" ]; then
    echo "✓ App.xcworkspace found in current directory"
else
    echo "⚠ Workspace not found in current directory, searching..."
    find . -name "*.xcworkspace" -maxdepth 3
fi

echo "=== Xcode Cloud: Post Clone Script Complete ==="
