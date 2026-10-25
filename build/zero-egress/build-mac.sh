#!/usr/bin/env bash
# Usage: build-mac.sh <arch>   where arch = arm64 | x64
set -euo pipefail
ARCH="${1:?arch required: arm64|x64}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILDROOT="$(dirname "$ROOT")"
VERSION="$(node -p "require('$ROOT/product.json').zeroEgressVersion")"
DMG_VERSION="${VERSION// /-}"   # "Beta 1.0" -> "Beta-1.0" (no spaces in filename)
cd "$ROOT"
mark() { echo "===> [build-mac ${ARCH}] $1 @ $(date -u +%H:%M:%S)Z"; }
# ZeroEgress requires the React bundle (react/out/) before any TS compile/package.
mark "buildreact start"
npm run buildreact
mark "gulp min start"
npm run gulp -- "vscode-darwin-${ARCH}-min"
mark "gulp min done; locating .app"
APP="$(ls -d "$BUILDROOT/VSCode-darwin-${ARCH}/"*.app | head -1)"
# Airgap gate: fail the build if any known-egress endpoint remains in the app bundle.
mark "audit start"
bash "$ROOT/scripts/zero-egress/audit-urls.sh" "$APP"
# ad-hoc sign so Gatekeeper lets it launch after right-click>Open
mark "codesign start"
codesign --force --deep --sign - "$APP"
mark "make-dmg start"
bash "$ROOT/build/zero-egress/make-dmg.sh" "$APP" "$ROOT/dist/ZeroEgress-${DMG_VERSION}-${ARCH}.dmg" "ZeroEgress"
mark "done"
