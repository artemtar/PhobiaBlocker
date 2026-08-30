#!/bin/bash

set -euo pipefail

# Read current version from manifest.json
CURRENT_VERSION=$(grep -o '"version": "[^"]*"' manifest.json | grep -o '[0-9.]*')
echo "Current version: $CURRENT_VERSION"

if [[ $# -gt 1 ]]; then
    echo "Usage: $0 [version]" >&2
    exit 1
fi

if [[ $# -eq 1 ]]; then
    NEW_VERSION="$1"

    if [[ ! "$NEW_VERSION" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
        echo "Error: version must use Chrome extension format, for example 1.2.3" >&2
        exit 1
    fi
else
    # Split version into components
    IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION"
    MAJOR=${VERSION_PARTS[0]}
    MINOR=${VERSION_PARTS[1]}
    PATCH=${VERSION_PARTS[2]}

    # Increment patch version
    PATCH=$((PATCH + 1))
    NEW_VERSION="$MAJOR.$MINOR.$PATCH"
fi

echo "New version: $NEW_VERSION"

# Update version in manifest.json
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" manifest.json
else
    # Linux
    sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" manifest.json
fi

echo "Updated manifest.json to version $NEW_VERSION"

# Create zip file with new version
ZIP_FILE="phobiablocker-v${NEW_VERSION}.zip"
echo "Creating $ZIP_FILE..."

OUTPUT_DIR=$(pwd -P)
TMP_DIR=$(mktemp -d "${OUTPUT_DIR}/.phobiablocker-pack.XXXXXX")
TMP_ZIP="${TMP_DIR}/${ZIP_FILE}"
cleanup() {
    if [[ -n "${TMP_ZIP:-}" && -f "$TMP_ZIP" ]]; then
        rm -f -- "$TMP_ZIP"
    fi
    if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
        rmdir -- "$TMP_DIR"
    fi
}
trap cleanup EXIT INT TERM

PACKAGE_FILES=(
    manifest.json \
    popup.html \
    settings.html \
    offscreen.html \
    css \
    js \
    icons
)

zip -r "$TMP_ZIP" "${PACKAGE_FILES[@]}"
unzip -t "$TMP_ZIP"

ARCHIVED_VERSION=$(unzip -p "$TMP_ZIP" manifest.json | grep -o '"version": "[^"]*"' | grep -o '[0-9.]*')
if [[ "$ARCHIVED_VERSION" != "$NEW_VERSION" ]]; then
    echo "Error: archived manifest version is $ARCHIVED_VERSION, expected $NEW_VERSION" >&2
    exit 1
fi

mv -f -- "$TMP_ZIP" "${OUTPUT_DIR}/${ZIP_FILE}"

echo "Package created: $ZIP_FILE"
echo "Version bumped from $CURRENT_VERSION to $NEW_VERSION"
