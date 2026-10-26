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
# hdiutil create intermittently fails with "Resource busy" on CI runners
# (a background scanner holding the staged files); retry a few times.
for attempt in 1 2 3 4 5; do
  if hdiutil create -volname "$VOL" -srcfolder "$STAGE" -ov -format UDZO "$OUT"; then
    break
  fi
  [ "$attempt" -lt 5 ] || { echo "ERROR: hdiutil create failed $attempt times" >&2; exit 1; }
  echo "hdiutil create failed (attempt $attempt); retrying in $((attempt * 10))s" >&2
  sleep $((attempt * 10))
done
rm -rf "$STAGE"
echo "Created $OUT"
