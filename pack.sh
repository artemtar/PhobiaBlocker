#!/bin/bash

# Read current version from manifest.json
CURRENT_VERSION=$(grep -o '"version": "[^"]*"' manifest.json | grep -o '[0-9.]*')
echo "Current version: $CURRENT_VERSION"

# Split version into components
IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR=${VERSION_PARTS[0]}
MINOR=${VERSION_PARTS[1]}
PATCH=${VERSION_PARTS[2]}

# Increment patch version
PATCH=$((PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
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

zip -r "$ZIP_FILE" . \
  -x "*.git*" \
  -x "*node_modules*" \
  -x "*.vscode*" \
  -x "*.DS_Store" \
  -x "*.md" \
  -x "*store-assets*" \
  -x "*.zip" \
  -x "*.eslintrc.js" \
  -x "*.gitignore" \
  -x "*pack.sh" \
  -x "*pack-dev.sh" \
  -x "*tests*" \
  -x "*icons/main_old.png" \
  -x "*support_documents*" \
  -x "*package.json" \
  -x "*package-lock.json" \
  -x "*manifest.dev.json" \
  -x "*todo" \
  -x "*activity_comparison.png" \
  -x "*build*" \
  -x "*/.venv*" \
  -x ".venv*" \
  -x "*.claude*" \
  -x "docs/*" \
  -x ".playwright-mcp/*" \
  -x "play/*" \
  -x "*wikipedia-test.png"

echo "Package created: $ZIP_FILE"
echo "Version bumped from $CURRENT_VERSION to $NEW_VERSION"
