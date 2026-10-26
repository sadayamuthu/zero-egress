#!/usr/bin/env bash
# Usage: gulp-min.sh <platform> <arch>   e.g. darwin arm64, win32 x64, linux x64
#
# Builds the minified app into ../VSCode-<platform>-<arch>. Same steps as
# upstream's vscode-<platform>-<arch>-min target, except that the TypeScript
# compile skips the identifier mangler (compile-build-without-mangling, as
# VSCodium does): the mangler runs four TypeScript language-service workers
# that outgrow 16 GB GitHub-hosted runners (OOM-killed on Linux, stalled for
# hours on Windows). Mangling only shortens private names; the shipped code
# is otherwise the same, just a few MB larger.
# ZE_MANGLE=1 runs the upstream target (with mangling) instead.
set -euo pipefail
PLATFORM="${1:?platform required: darwin|win32|linux}"
ARCH="${2:?arch required}"
cd "$(dirname "$0")/../.."
if [ "${ZE_MANGLE:-}" = 1 ]; then
  npm run gulp -- "vscode-${PLATFORM}-${ARCH}-min"
  exit 0
fi
npm run gulp -- compile-build-without-mangling
npm run gulp -- compile-extensions-build
npm run gulp -- compile-extension-media-build
npm run gulp -- minify-vscode
npm run gulp -- "vscode-${PLATFORM}-${ARCH}-min-ci"
