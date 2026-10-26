#!/usr/bin/env bash
# Usage: make-appimage.sh <linux-min-app-dir> <version> <arch>
# Builds dist/ZeroEgress-<version>-x86_64.AppImage from the Linux min build.
set -euo pipefail
APPDIR_SRC="${1:?linux min app dir required}"
VERSION="${2:?version required}"
ARCH="${3:?arch required}"
case "$ARCH" in x64) AI_ARCH=x86_64;; *) echo "ERROR: unsupported arch '$ARCH'" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$(cd "$ROOT" && node -p "require('./product.json').applicationName")"   # zero-egress launcher
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
#    AppImageKit is archived; appimagetool now lives in AppImage/appimagetool.
#    Pinned to release 1.9.1 and checked against its sha256 before it runs.
#    Override both APPIMAGETOOL_URL and APPIMAGETOOL_SHA256 to use another build.
TOOL="$WORK/appimagetool"
APPIMAGETOOL_URL="${APPIMAGETOOL_URL:-https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage}"
APPIMAGETOOL_SHA256="${APPIMAGETOOL_SHA256:-ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0}"
curl -fsSL -o "$TOOL" "$APPIMAGETOOL_URL"
echo "${APPIMAGETOOL_SHA256}  ${TOOL}" | sha256sum -c -
chmod +x "$TOOL"
mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/ZeroEgress-${VERSION}-${AI_ARCH}.AppImage"
# --appimage-extract-and-run avoids needing FUSE on CI runners.
ARCH="$AI_ARCH" "$TOOL" --appimage-extract-and-run "$APPDIR" "$OUT"
echo "Created $OUT"
