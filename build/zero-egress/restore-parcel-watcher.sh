#!/usr/bin/env bash
# Usage: restore-parcel-watcher.sh <platform>   e.g. linux-x64-glibc, darwin-arm64, darwin-x64, win32-x64
#
# VS Code's postinstall deletes the @parcel/watcher prebuilds, and nothing
# builds the module from source, so without this the file watcher (and
# test-node) has no native binary. Unpacks the prebuild matching the version
# the lockfile installed into node_modules/@parcel/watcher-<platform>.
set -euo pipefail
PLATFORM="${1:?platform required, e.g. linux-x64-glibc}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
v="$(node -p "require('./node_modules/@parcel/watcher/package.json').version")"
pkg="@parcel/watcher-${PLATFORM}"
dest="$ROOT/node_modules/$pkg"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm pack "$pkg@$v")
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$tmp/parcel-watcher-${PLATFORM}-$v.tgz" --strip-components=1 -C "$dest"
echo "Restored $pkg@$v"
