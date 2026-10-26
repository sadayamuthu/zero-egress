#!/usr/bin/env bash
# Usage: build-mac.sh <arch>   where arch = arm64 | x64
#
# Builds ZeroEgress.app with the gulp min target, gates it (brand check and
# URL audit) and packages dist/ZeroEgress-<version>-<arch>[-unsigned].dmg.
#
# Signing is optional and driven by the environment:
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: ..." identity in a
#                            keychain on the search list. Set: sign with the
#                            hardened runtime and entitlements.plist. Unset:
#                            ad-hoc sign and add -unsigned to the dmg name.
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD
#                            notarytool credentials. Required when
#                            APPLE_SIGNING_IDENTITY is set: the dmg is
#                            notarized and stapled.
set -euo pipefail
ARCH="${1:?arch required: arm64|x64}"
case "$ARCH" in arm64|x64) ;; *) echo "ERROR: unsupported arch '$ARCH'" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILDROOT="$(dirname "$ROOT")"
VERSION="$(node -p "require('$ROOT/product.json').zeroEgressVersion")"
VERSION="${VERSION// /-}"   # "Beta 1.0" -> "Beta-1.0" (no spaces in filename)
ENTITLEMENTS="$ROOT/build/zero-egress/entitlements.plist"
cd "$ROOT"
mark() { echo "===> [build-mac ${ARCH}] $1 @ $(date -u +%H:%M:%S)Z"; }

SIGN_ID="${APPLE_SIGNING_IDENTITY:-}"
if [ -n "$SIGN_ID" ]; then
  for v in APPLE_ID APPLE_TEAM_ID APPLE_APP_PASSWORD; do
    [ -n "${!v:-}" ] || { echo "ERROR: APPLE_SIGNING_IDENTITY is set but $v is not; a signed build must be notarized" >&2; exit 1; }
  done
  SUFFIX=""
else
  SUFFIX="-unsigned"
fi
DMG="$ROOT/dist/ZeroEgress-${VERSION}-${ARCH}${SUFFIX}.dmg"

if [ "${ZE_REUSE_APP:-}" != 1 ]; then
  # ZeroEgress requires the React bundle (react/out/) before any TS compile/package.
  mark "buildreact start"
  npm run buildreact
  mark "gulp min start"
  bash "$ROOT/build/zero-egress/gulp-min.sh" darwin "$ARCH"
fi
mark "locating .app"
APP="$(ls -d "$BUILDROOT/VSCode-darwin-${ARCH}/"*.app | head -1)"
[ -d "$APP" ] || { echo "ERROR: no .app under $BUILDROOT/VSCode-darwin-${ARCH}" >&2; exit 1; }

# Gates BEFORE packaging: a failure ships nothing.
mark "brand check start"
bash "$ROOT/scripts/zero-egress/check-brand.sh" "$APP/Contents/Resources/app"
mark "audit start"
bash "$ROOT/scripts/zero-egress/audit-urls.sh" "$APP"

if [ -n "$SIGN_ID" ]; then
  mark "codesign (Developer ID, hardened runtime) start"
  sign() { codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGN_ID" "$@"; }
  # Inside out: loose Mach-O files, then frameworks, then helper apps, then the app.
  while IFS= read -r -d '' f; do
    if file -b "$f" | grep -q 'Mach-O'; then sign "$f"; fi
  done < <(find "$APP/Contents" -type f \( -name '*.dylib' -o -name '*.node' -o -perm -u+x \) \
             -not -path '*.framework/*' -print0)
  while IFS= read -r -d '' fw; do sign "$fw"; done \
    < <(find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.framework' -print0)
  while IFS= read -r -d '' helper; do sign "$helper"; done \
    < <(find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.app' -print0)
  sign "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
else
  # Ad-hoc sign so Gatekeeper lets it launch after right-click > Open.
  mark "codesign (ad-hoc) start"
  codesign --force --deep --sign - "$APP"
fi

mark "make-dmg start"
bash "$ROOT/build/zero-egress/make-dmg.sh" "$APP" "$DMG" "ZeroEgress"

if [ -n "$SIGN_ID" ]; then
  mark "notarize start"
  codesign --force --timestamp --sign "$SIGN_ID" "$DMG"
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
fi
mark "done: $DMG"
