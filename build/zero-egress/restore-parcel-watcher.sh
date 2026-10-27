#!/usr/bin/env bash
# Usage: restore-parcel-watcher.sh <platform>   e.g. linux-x64-glibc, darwin-arm64, darwin-x64, win32-x64
#
# VS Code's postinstall deletes the @parcel/watcher prebuilds, and nothing
# builds the module from source, so without this the file watcher (and
# test-node) has no native binary. Unpacks the prebuild matching the version
# the lockfile installed into node_modules/@parcel/watcher-<platform>, after
# checking the tarball against the lockfile's integrity hash.
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
tgz="$tmp/parcel-watcher-${PLATFORM}-$v.tgz"
# The prebuild ships in the product: it must be the exact tarball the lockfile pins.
node -e '
  const [pkg, v, tgz] = process.argv.slice(1);
  const entry = require("./package-lock.json").packages["node_modules/" + pkg];
  if (!entry || !entry.integrity) { console.error(`ERROR: ${pkg} has no integrity in package-lock.json`); process.exit(1); }
  if (entry.version !== v) { console.error(`ERROR: ${pkg}: lockfile pins ${entry.version}, @parcel/watcher is ${v}`); process.exit(1); }
  const [algo, want] = entry.integrity.split("-");
  const got = require("crypto").createHash(algo).update(require("fs").readFileSync(tgz)).digest("base64");
  if (got !== want) { console.error(`ERROR: ${pkg}@${v} tarball ${algo} ${got} does not match the lockfile (${want})`); process.exit(1); }
  console.log(`Verified ${pkg}@${v} against package-lock.json (${algo})`);
' "$pkg" "$v" "$tgz"
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$tgz" --strip-components=1 -C "$dest"
echo "Restored $pkg@$v"
