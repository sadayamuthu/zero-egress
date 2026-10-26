#!/usr/bin/env bash
# Usage: build-win.sh <arch> [app|setup|all]   arch = x64   (bash / git-bash on Windows)
#
#   app    build the min app (../VSCode-win32-<arch>) and gate it (brand check
#          and URL audit). A gate failure ships nothing.
#   setup  build the system and user Inno Setup installers from that app into
#          dist/ZeroEgress-<v>-<arch>-setup[-unsigned].exe and
#          dist/ZeroEgress-<v>-<arch>-user-setup[-unsigned].exe
#   all    app then setup (default)
#
# Signing is optional:
#   WIN_CERT_PFX + WIN_CERT_PASSWORD  path to an OV code-signing .pfx: this
#          script signs the app's .exe/.dll/.node files before the installers
#          are built, and the installers after, with signtool.
#   ZE_WIN_SIGNED=1  the caller signs (e.g. Azure Trusted Signing in the
#          release workflow, between the app and setup phases and after setup);
#          only drops the -unsigned suffix.
# Neither set: unsigned, and the installer names carry -unsigned.
set -euo pipefail
ARCH="${1:?arch required: x64}"
PHASE="${2:-all}"
[ "$ARCH" = x64 ] || { echo "ERROR: unsupported arch '$ARCH' (x64 only)" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILDROOT="$(dirname "$ROOT")"
cd "$ROOT"
VERSION="$(node -p "require('./product.json').zeroEgressVersion")"
VERSION="${VERSION// /-}"
APPDIR="$BUILDROOT/VSCode-win32-${ARCH}"
mark() { echo "===> [build-win ${ARCH} ${PHASE}] $1 @ $(date -u +%H:%M:%S)Z"; }

PFX="${WIN_CERT_PFX:-}"
if [ -n "$PFX" ]; then
  [ -f "$PFX" ] || { echo "ERROR: WIN_CERT_PFX '$PFX' not found" >&2; exit 1; }
  [ -n "${WIN_CERT_PASSWORD:-}" ] || { echo "ERROR: WIN_CERT_PFX is set but WIN_CERT_PASSWORD is not" >&2; exit 1; }
fi
if [ -n "$PFX" ] || [ "${ZE_WIN_SIGNED:-}" = 1 ]; then SUFFIX=""; else SUFFIX="-unsigned"; fi

signtool_sign() {
  local st
  st="$(ls "/c/Program Files (x86)/Windows Kits/10/bin/"*/x64/signtool.exe 2>/dev/null | sort -V | tail -1)"
  [ -n "$st" ] || { echo "ERROR: signtool.exe not found" >&2; exit 1; }
  "$st" sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com \
    /f "$(cygpath -w "$PFX")" /p "$WIN_CERT_PASSWORD" "$@"
}

phase_app() {
  mark "buildreact start"
  npm run buildreact
  mark "gulp min start"
  bash "$ROOT/build/zero-egress/gulp-min.sh" win32 "$ARCH"
  npm run gulp -- "vscode-win32-${ARCH}-inno-updater"
  [ -d "$APPDIR" ] || { echo "ERROR: win32 min output not found at $APPDIR" >&2; ls -la "$BUILDROOT" >&2 || true; exit 1; }

  # Gates BEFORE packaging.
  mark "brand check start"
  bash "$ROOT/scripts/zero-egress/check-brand.sh" "$APPDIR/resources/app"
  mark "audit start"
  bash "$ROOT/scripts/zero-egress/audit-urls.sh" "$APPDIR"

  if [ -n "$PFX" ]; then
    mark "signtool (app binaries) start"
    local files=()
    while IFS= read -r -d '' f; do files+=("$(cygpath -w "$f")"); done \
      < <(find "$APPDIR" -type f \( -name '*.exe' -o -name '*.dll' -o -name '*.node' \) -print0)
    signtool_sign "${files[@]}"
  fi
}

phase_setup() {
  [ -d "$APPDIR" ] || { echo "ERROR: run the app phase first ($APPDIR missing)" >&2; exit 1; }
  rm -rf "$ROOT/dist"
  mkdir -p "$ROOT/dist"
  local target name exe
  for target in system user; do
    mark "${target} setup start"
    npm run gulp -- "vscode-win32-${ARCH}-${target}-setup"
    exe="$(find "$ROOT/.build/win32-${ARCH}/${target}-setup" -maxdepth 1 -name '*.exe' | head -1)"
    [ -n "${exe:-}" ] || { echo "ERROR: ${target} setup produced no .exe under .build/win32-${ARCH}/${target}-setup" >&2; exit 1; }
    if [ "$target" = system ]; then name="setup"; else name="user-setup"; fi
    cp "$exe" "$ROOT/dist/ZeroEgress-${VERSION}-${ARCH}-${name}${SUFFIX}.exe"
  done
  if [ -n "$PFX" ]; then
    mark "signtool (installers) start"
    local setups=()
    for exe in "$ROOT/dist/"*.exe; do setups+=("$(cygpath -w "$exe")"); done
    signtool_sign "${setups[@]}"
  fi
  mark "done"
  ls -la "$ROOT/dist"
}

case "$PHASE" in
  app) phase_app ;;
  setup) phase_setup ;;
  all) phase_app; phase_setup ;;
  *) echo "ERROR: unknown phase '$PHASE' (app|setup|all)" >&2; exit 2 ;;
esac
