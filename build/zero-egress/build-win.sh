#!/usr/bin/env bash
# Usage: build-win.sh <arch>   arch = x64   (runs under bash / git-bash on Windows)
set -euo pipefail
ARCH="${1:?arch required: x64}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('$ROOT/product.json').zeroEgressVersion")"
DMG_VERSION="${VERSION// /-}"

npm run buildreact
npm run gulp -- "vscode-win32-${ARCH}-min"
npm run gulp -- "vscode-win32-${ARCH}-inno-updater"

# Locate the built app directory (holds ZeroEgress.exe). Discover via glob
# because the exact folder name derives from product.nameLong.
APPDIR="$(find "$ROOT/.build/win32-${ARCH}" -maxdepth 1 -type d -name "*win32-${ARCH}" | head -1)"
if [ -z "${APPDIR:-}" ] || [ ! -d "$APPDIR" ]; then
  echo "ERROR: could not locate built win32 app dir under .build/win32-${ARCH}" >&2
  ls -la "$ROOT/.build/win32-${ARCH}" >&2 || true
  exit 1
fi

# Airgap gate BEFORE packaging.
bash "$ROOT/scripts/zero-egress/audit-urls.sh" "$APPDIR"

npm run gulp -- "vscode-win32-${ARCH}-system-setup"

SETUP="$(find "$ROOT/.build/win32-${ARCH}/system-setup" -maxdepth 1 -name '*.exe' | head -1)"
if [ -z "${SETUP:-}" ]; then
  echo "ERROR: system-setup produced no .exe under .build/win32-${ARCH}/system-setup" >&2
  exit 1
fi
mkdir -p "$ROOT/dist"
cp "$SETUP" "$ROOT/dist/ZeroEgress-${DMG_VERSION}-${ARCH}-setup.exe"
echo "Created dist/ZeroEgress-${DMG_VERSION}-${ARCH}-setup.exe"
