#!/usr/bin/env bash
# Build the installable extension zip into dist/.
# Contains only files the extension needs at runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/glados-autocheckin-firefox.zip
zip -q dist/glados-autocheckin-firefox.zip \
  manifest.json background.js options.html options.js \
  icon-16.png icon-48.png icon-128.png
echo "built dist/glados-autocheckin-firefox.zip"
unzip -l dist/glados-autocheckin-firefox.zip | tail -n +4 | head -n -2
