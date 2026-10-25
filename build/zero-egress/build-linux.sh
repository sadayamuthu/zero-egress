#!/usr/bin/env bash
# Usage: build-linux.sh <arch>   arch = x64
set -euo pipefail
ARCH="${1:?arch required: x64}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILDROOT="$(dirname "$ROOT")"
cd "$ROOT"
VERSION="$(node -p "require('$ROOT/product.json').zeroEgressVersion")"
DMG_VERSION="${VERSION// /-}"

npm run buildreact
npm run gulp -- "vscode-linux-${ARCH}-min"

# Min output sits beside the repo as VSCode-linux-<arch>/ (same pattern as darwin).
APPDIR="$BUILDROOT/VSCode-linux-${ARCH}"
if [ ! -d "$APPDIR" ]; then
  echo "ERROR: linux min output not found at $APPDIR" >&2
  ls -la "$BUILDROOT" >&2 || true
  exit 1
fi

# Airgap gate BEFORE packaging.
bash "$ROOT/scripts/zero-egress/audit-urls.sh" "$APPDIR"

mkdir -p "$ROOT/dist"

# Tarball: archive the min output dir.
tar -czf "$ROOT/dist/ZeroEgress-${DMG_VERSION}-${ARCH}.tar.gz" \
  -C "$BUILDROOT" "VSCode-linux-${ARCH}"

# .deb
npm run gulp -- "vscode-linux-${ARCH}-prepare-deb"
npm run gulp -- "vscode-linux-${ARCH}-build-deb"
DEB="$(find "$ROOT/.build/linux/deb" -name '*.deb' | head -1)"
[ -n "${DEB:-}" ] || { echo "ERROR: no .deb produced" >&2; exit 1; }
cp "$DEB" "$ROOT/dist/ZeroEgress-${DMG_VERSION}-${ARCH}.deb"

# .rpm
npm run gulp -- "vscode-linux-${ARCH}-prepare-rpm"
npm run gulp -- "vscode-linux-${ARCH}-build-rpm"
RPM="$(find "$ROOT/.build/linux/rpm" -name '*.rpm' | head -1)"
[ -n "${RPM:-}" ] || { echo "ERROR: no .rpm produced" >&2; exit 1; }
cp "$RPM" "$ROOT/dist/ZeroEgress-${DMG_VERSION}-${ARCH}.rpm"

echo "Created deb/rpm/tarball in dist/ for ${ARCH}"

# .AppImage (Task 4)
bash "$ROOT/build/zero-egress/make-appimage.sh" "$APPDIR" "$DMG_VERSION" "$ARCH"
