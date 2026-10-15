#!/bin/bash

# Local release packaging: bumps the version in manifest.json and zips the runtime set
# into phobiablur-v<version>.zip. The CI release (scripts/prepare-store-release.cjs)
# calls this with an explicit version after rewriting the records itself, so the sed
# below is a no-op there and its own checks are the ones that gate the upload.
set -euo pipefail

# Read current version from manifest.json
# grep rather than jq so this runs on a bare runner; the pattern depends on the
# manifest's exact `"version": "x"` spacing.
CURRENT_VERSION=$(grep -o '"version": "[^"]*"' manifest.json | grep -o '[0-9.]*')
echo "Current version: $CURRENT_VERSION"

if [[ $# -gt 1 ]]; then
    echo "Usage: $0 [version]" >&2
    exit 1
fi

if [[ $# -eq 1 ]]; then
    NEW_VERSION="$1"

    # Shape only (one to four numeric components). Leading zeroes and the 65535
    # ceiling are enforced by scripts/prepare-store-release.cjs, the release path.
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
# BSD sed needs an explicit empty backup suffix for in-place edits; GNU sed takes none.
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" manifest.json
else
    # Linux
    sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" manifest.json
fi

echo "Updated manifest.json to version $NEW_VERSION"

# Create zip file with new version
ZIP_FILE="phobiablur-v${NEW_VERSION}.zip"
echo "Creating $ZIP_FILE..."

# The archive is assembled in a temp directory beside its destination so the final mv
# is a rename on the same filesystem: a partial ZIP never appears under the final name.
# pwd -P resolves symlinks so both paths really are on the same volume.
OUTPUT_DIR=$(pwd -P)
TMP_DIR=$(mktemp -d "${OUTPUT_DIR}/.phobiablocker-pack.XXXXXX")
TMP_ZIP="${TMP_DIR}/${ZIP_FILE}"
# Removes only what this run created. rmdir rather than rm -rf: if anything unexpected
# landed in the temp directory the cleanup fails loudly instead of deleting it.
cleanup() {
    if [[ -n "${TMP_ZIP:-}" && -f "$TMP_ZIP" ]]; then
        rm -f -- "$TMP_ZIP"
    fi
    if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
        rmdir -- "$TMP_DIR"
    fi
}
trap cleanup EXIT INT TERM

# The runtime set. Directories are zipped whole, so everything inside css/, js/ and
# icons/ ships; pack-dev.sh and tests/unit/pack-dev-excludes.test.js mirror this list.
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
# unzip -t re-reads every entry's CRC, so a truncated or corrupt archive fails here
# before it is moved into place.
unzip -t "$TMP_ZIP"

# Confirms the archive carries the bumped manifest. This catches a sed that matched
# nothing, for example on a manifest whose spacing differs from the grep pattern.
ARCHIVED_VERSION=$(unzip -p "$TMP_ZIP" manifest.json | grep -o '"version": "[^"]*"' | grep -o '[0-9.]*')
if [[ "$ARCHIVED_VERSION" != "$NEW_VERSION" ]]; then
    echo "Error: archived manifest version is $ARCHIVED_VERSION, expected $NEW_VERSION" >&2
    exit 1
fi

mv -f -- "$TMP_ZIP" "${OUTPUT_DIR}/${ZIP_FILE}"

echo "Package created: $ZIP_FILE"
echo "Version bumped from $CURRENT_VERSION to $NEW_VERSION"
