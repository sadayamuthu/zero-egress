#!/usr/bin/env bash
# Usage: make-appimage.sh <linux-min-app-dir> <dmg-version> <arch>
# Builds a portable .AppImage from the Linux min build. Net-new tooling.
set -euo pipefail
APPDIR_SRC="${1:?linux min app dir required}"
DMG_VERSION="${2:?version required}"
ARCH="${3:?arch required}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APPNAME="$(node -p "require('$ROOT/product.json').applicationName")"   # zero-egress
BIN="$(node -p "require('$ROOT/product.json').applicationName")"       # launcher binary name
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APPDIR="$WORK/ZeroEgress.AppDir"

# 1. Lay out the AppDir: app payload under usr/share, launcher on PATH.
mkdir -p "$APPDIR/usr/share/zero-egress" "$APPDIR/usr/bin"
cp -R "$APPDIR_SRC/." "$APPDIR/usr/share/zero-egress/"
ln -sf "../share/zero-egress/${BIN}" "$APPDIR/usr/bin/${BIN}"

# 2. Icon (AppImage requires a top-level icon named after the desktop Icon= key).
cp "$ROOT/resources/linux/code.png" "$APPDIR/zero-egress.png"
mkdir -p "$APPDIR/usr/share/icons/hicolor/512x512/apps"
cp "$ROOT/resources/linux/code.png" "$APPDIR/usr/share/icons/hicolor/512x512/apps/zero-egress.png"

# 3. Desktop entry.
cat > "$APPDIR/zero-egress.desktop" <<EOF
[Desktop Entry]
Name=ZeroEgress
Exec=${BIN}
Icon=zero-egress
Type=Application
Categories=Development;IDE;
EOF

# 4. AppRun launcher.
cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "${0}")")"
exec "${HERE}/usr/share/zero-egress/zero-egress" "$@"
EOF
chmod +x "$APPDIR/AppRun"

# 5. Fetch appimagetool (no repo tooling exists for AppImage) and build.
TOOL="$WORK/appimagetool"
curl -fsSL -o "$TOOL" \
  "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
chmod +x "$TOOL"
mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/ZeroEgress-${DMG_VERSION}-${ARCH}.AppImage"
# --appimage-extract-and-run avoids needing FUSE on CI runners.
ARCH=x86_64 "$TOOL" --appimage-extract-and-run "$APPDIR" "$OUT"
echo "Created $OUT"
