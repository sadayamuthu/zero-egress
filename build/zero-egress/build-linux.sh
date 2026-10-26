#!/usr/bin/env bash
# Usage: build-linux.sh <arch>   arch = x64
#
# Builds the Linux min app, gates it (brand check and URL audit), then
# packages into dist/:
#   zero-egress_<v>_amd64.deb
#   zero-egress-<v>-1.x86_64.rpm
#   ZeroEgress-<v>-x86_64.AppImage
#   zero-egress-<v>-linux-x64.tar.gz
# Needs dpkg-deb, fakeroot and rpmbuild on PATH.
set -euo pipefail
ARCH="${1:?arch required: x64}"
[ "$ARCH" = x64 ] || { echo "ERROR: unsupported arch '$ARCH' (x64 only)" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILDROOT="$(dirname "$ROOT")"
cd "$ROOT"
VERSION="$(node -p "require('./product.json').zeroEgressVersion")"
VERSION="${VERSION// /-}"
APPNAME="$(node -p "require('./product.json').applicationName")"   # zero-egress
DEB_ARCH=amd64
RPM_ARCH=x86_64
mark() { echo "===> [build-linux ${ARCH}] $1 @ $(date -u +%H:%M:%S)Z"; }

mark "buildreact start"
npm run buildreact
mark "gulp min start"
bash "$ROOT/build/zero-egress/gulp-min.sh" linux "$ARCH"

# Min output sits beside the repo as VSCode-linux-<arch>/ (same pattern as darwin).
APPDIR="$BUILDROOT/VSCode-linux-${ARCH}"
if [ ! -d "$APPDIR" ]; then
  echo "ERROR: linux min output not found at $APPDIR" >&2
  ls -la "$BUILDROOT" >&2 || true
  exit 1
fi

# Gates BEFORE packaging: a failure ships nothing.
mark "brand check start"
bash "$ROOT/scripts/zero-egress/check-brand.sh" "$APPDIR/resources/app"
mark "audit start"
bash "$ROOT/scripts/zero-egress/audit-urls.sh" "$APPDIR"

rm -rf "$ROOT/dist"
mkdir -p "$ROOT/dist"

# Tarball: the app folder, renamed so it unpacks as zero-egress-<v>-linux-x64/.
mark "tar.gz start"
TARDIR="${APPNAME}-${VERSION}-linux-${ARCH}"
tar -czf "$ROOT/dist/${TARDIR}.tar.gz" -C "$BUILDROOT" \
  --transform "s|^VSCode-linux-${ARCH}|${TARDIR}|" "VSCode-linux-${ARCH}"

# .deb
mark "deb start"
npm run gulp -- "vscode-linux-${ARCH}-prepare-deb"
npm run gulp -- "vscode-linux-${ARCH}-build-deb"
DEB="$(find "$ROOT/.build/linux/deb/${DEB_ARCH}/deb" -name '*.deb' | head -1)"
[ -n "${DEB:-}" ] || { echo "ERROR: no .deb produced" >&2; exit 1; }
cp "$DEB" "$ROOT/dist/${APPNAME}_${VERSION}_${DEB_ARCH}.deb"

# .rpm
mark "rpm start"
npm run gulp -- "vscode-linux-${ARCH}-prepare-rpm"
npm run gulp -- "vscode-linux-${ARCH}-build-rpm"
RPM="$(find "$ROOT/.build/linux/rpm/${RPM_ARCH}" -maxdepth 1 -name '*.rpm' | head -1)"
[ -n "${RPM:-}" ] || { echo "ERROR: no .rpm produced" >&2; exit 1; }
cp "$RPM" "$ROOT/dist/${APPNAME}-${VERSION}-1.${RPM_ARCH}.rpm"

# .AppImage
mark "AppImage start"
bash "$ROOT/build/zero-egress/make-appimage.sh" "$APPDIR" "$VERSION" "$ARCH"

mark "done"
ls -la "$ROOT/dist"
