#!/bin/bash

set -euo pipefail

echo "Building DEV version of PhobiaBlur..."

if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required to generate the dev manifest" >&2
    exit 1
fi

# Read version from manifest.json
VERSION=$(grep -o '"version": "[^"]*"' manifest.json | grep -o '[0-9][^"]*')
DEV_VERSION="${VERSION}-dev"
echo "Dev version: $DEV_VERSION"

# Create build directory
BUILD_DIR="build/dev"
echo "Building into: $BUILD_DIR"

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy only the runtime set pack.sh ships. Everything else in the working
# tree (tests, docs, tooling, agent scratch, screenshots) stays out of the
# unpacked extension Chrome loads.
PACKAGE_FILES=(
    manifest.json
    popup.html
    settings.html
    offscreen.html
    css
    js
    icons
)

cp -R "${PACKAGE_FILES[@]}" "$BUILD_DIR/"

# Generate dev manifest from manifest.json
jq --arg ver "$DEV_VERSION" '
  .name = "PhobiaBlur DEV" |
  .version_name = $ver |
  .description = "[DEV BUILD] " + .description |
  .action.default_title = "PhobiaBlur DEV"
' manifest.json > "$BUILD_DIR/manifest.json"

echo ""
echo "Dev build complete!"
echo "Location: $BUILD_DIR"
echo "To load in Chrome:"
echo "   1. Go to chrome://extensions/"
echo "   2. Enable 'Developer mode'"
echo "   3. Click 'Load unpacked'"
echo "   4. Select: $(pwd)/$BUILD_DIR"
