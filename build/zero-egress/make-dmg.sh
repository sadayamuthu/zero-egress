#!/usr/bin/env bash
# Usage: make-dmg.sh <path-to-.app> <output-dmg-path> <volume-name>
set -euo pipefail
APP="$1"; OUT="$2"; VOL="${3:-ZeroEgress}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil create -volname "$VOL" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$STAGE"
echo "Created $OUT"
