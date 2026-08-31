#!/bin/bash

echo "Building DEV version of PhobiaBlocker..."

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

# Copy all files except excluded ones
rsync -av --exclude='*.git*' \
  --exclude='node_modules' \
  --exclude='.vscode' \
  --exclude='.DS_Store' \
  --exclude='*.md' \
  --exclude='store-assets' \
  --exclude='*.zip' \
  --exclude='.eslintrc.js' \
  --exclude='pack*.sh' \
  --exclude='tests' \
  --exclude='icons/main_old.png' \
  --exclude='support_documents' \
  --exclude='build' \
  --exclude='todo' \
  --exclude='test_results.txt' \
  . "$BUILD_DIR/"

# Generate dev manifest from manifest.json
jq --arg ver "$DEV_VERSION" '
  .name = "PhobiaBlocker DEV" |
  .version_name = $ver |
  .description = "[DEV BUILD] " + .description |
  .action.default_title = "PhobiaBlocker DEV"
' manifest.json > "$BUILD_DIR/manifest.json"

echo ""
echo "Dev build complete!"
echo "Location: $BUILD_DIR"
echo "To load in Chrome:"
echo "   1. Go to chrome://extensions/"
echo "   2. Enable 'Developer mode'"
echo "   3. Click 'Load unpacked'"
echo "   4. Select: $(pwd)/$BUILD_DIR"
