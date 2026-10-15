#!/bin/bash

# Unpacked development build for "Load unpacked" on chrome://extensions: the runtime
# set with a relabelled manifest so the dev copy is told apart from the store install.
set -euo pipefail

echo "Building DEV version of PhobiaBlur..."

# Checked first, before anything is deleted or created. Without it a missing jq would
# still leave build/dev with an empty manifest.json: the redirect truncates the file
# before bash finds the command missing, and set -e then aborts the half-built copy.
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
# A fresh directory every time, so files removed from the runtime set do not linger in
# the unpacked extension Chrome keeps loading.
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
# Only the labels change. version_name is what chrome://extensions displays when
# present, so the -dev marker shows without touching the real version. jq reads the
# source manifest, not the copy, so input and output never alias the same file.
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
