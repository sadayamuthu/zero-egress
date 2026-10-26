# ZeroEgress build scripts

This directory holds the packaging scripts used to produce installable ZeroEgress
builds from this repo. It does not replace the upstream VS Code/gulp build —
it wraps it with the steps and flags ZeroEgress needs (React bundle, release
gates, signing, dmg staging, installer naming, AppImage).

The release workflow (`.github/workflows/release.yml`) runs these same scripts
on GitHub-hosted runners: a `v*.*.*` tag publishes a release, a manual run
builds everything without publishing.

## Build matrix

`<v>` is `product.json` `zeroEgressVersion` (currently `0.1.0`).

| Host    | Arch  | Script                                  | Artifacts (in `dist/`)                                                         |
|---------|-------|-----------------------------------------|--------------------------------------------------------------------------------|
| macOS   | arm64 | `build/zero-egress/build-mac.sh arm64`  | `ZeroEgress-<v>-arm64.dmg`                                                     |
| macOS   | x64   | `build/zero-egress/build-mac.sh x64`    | `ZeroEgress-<v>-x64.dmg`                                                       |
| Windows | x64   | `build/zero-egress/build-win.sh x64`    | `ZeroEgress-<v>-x64-setup.exe`, `ZeroEgress-<v>-x64-user-setup.exe`            |
| Linux   | x64   | `build/zero-egress/build-linux.sh x64`  | `zero-egress_<v>_amd64.deb`, `zero-egress-<v>-1.x86_64.rpm`, `ZeroEgress-<v>-x86_64.AppImage`, `zero-egress-<v>-linux-x64.tar.gz` |

Without signing credentials (below) the macOS and Windows files have
`-unsigned` before the extension, e.g. `ZeroEgress-<v>-arm64-unsigned.dmg` and
`ZeroEgress-<v>-x64-setup-unsigned.exe`. Linux packages are not signed and
never carry the suffix.

Each platform must be built on that platform. The macOS x64 dmg is built on
an Intel Mac (the release workflow uses the `macos-15-intel` runner).

## Prerequisites (all platforms)

Run from a clean checkout, in this order:

1. `npm ci` — installs dependencies. This step alone can take tens of
   minutes; a failure here is almost always a missing native build
   prerequisite (e.g. Python, a C/C++ toolchain, or a mismatched Node
   version), not a script bug. On macOS with a recent Xcode, set
   `CXXFLAGS=-DFMT_CONSTEVAL=` if a native module fails on `consteval`.
2. `build/zero-egress/restore-parcel-watcher.sh <platform>` (`darwin-arm64`,
   `darwin-x64`, `win32-x64` or `linux-x64-glibc`) — VS Code's postinstall
   deletes the `@parcel/watcher` prebuilds, and the packaged app's file
   watcher needs one.
3. `export NODE_OPTIONS=--max-old-space-size=8192` — the default V8 heap is
   too small for the build.
4. The platform script below. Each runs `npm run buildreact` (the
   React/Tailwind bundle under
   `src/vs/workbench/contrib/zeroEgress/browser/react/`, which must exist
   before any TypeScript compile or gulp packaging task) and then the gulp
   min target, e.g. `npm run gulp -- vscode-darwin-arm64-min`.

## Release gates

Every script runs `scripts/zero-egress/check-brand.sh` on the packaged app's
`resources/app` folder and `scripts/zero-egress/audit-urls.sh` on the whole
packaged app **before** packaging anything. A failure stops the script, so
nothing is written to `dist/`.

### Mangler guard

A minified gulp build (`*-min` targets) runs VS Code's build-time identifier
mangler. With the AI-feature dependencies ZeroEgress adds (e.g.
`google-auth-library`), TypeScript can pull dependency `.d.ts` files from
`node_modules` into the compile program, and the mangler can crash on
overlapping rename locations it computes for them roughly ~14 minutes into
the build. This repo already carries a guard for this
(`build/lib/mangle/index.ts` / `index.js`) that skips mangle renames for any
file under `node_modules` — those files are never part of the minified
output, so skipping them changes nothing shipped. No action is needed to use
it; it's called out here so a future "the build crashed in the mangler"
report isn't mistaken for a new bug.

## macOS

```bash
build/zero-egress/build-mac.sh <arch>   # arch = arm64 | x64
```

1. Builds `../VSCode-darwin-<arch>/ZeroEgress.app` (one directory above the
   repo root) with `vscode-darwin-<arch>-min`, and runs the gates on it.
2. Signs it:
   - `APPLE_SIGNING_IDENTITY` set (a "Developer ID Application" identity in
     a keychain on the search list): signs every Mach-O inside out with the
     hardened runtime and `entitlements.plist` (`allow-jit`,
     `allow-unsigned-executable-memory`, `disable-library-validation`).
     `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD` are then required:
     the dmg is signed, notarized (`xcrun notarytool submit --wait`) and
     stapled.
   - Unset: ad-hoc signs (`codesign --force --deep --sign -`) so Gatekeeper
     allows a launch after right-click → Open, and names the dmg `-unsigned`.
3. `make-dmg.sh` stages the `.app` plus an `Applications` symlink and writes
   `dist/ZeroEgress-<v>-<arch>[-unsigned].dmg`.

## Windows

```bash
build/zero-egress/build-win.sh x64 [app|setup|all]   # bash / git-bash on Windows
```

- `app` builds `../VSCode-win32-x64` (`vscode-win32-x64-min` and
  `-inno-updater`) and runs the gates on it.
- `setup` builds the all-users (`vscode-win32-x64-system-setup`) and per-user
  (`vscode-win32-x64-user-setup`) Inno Setup installers into
  `dist/ZeroEgress-<v>-x64-setup[-unsigned].exe` and
  `dist/ZeroEgress-<v>-x64-user-setup[-unsigned].exe`.
- `all` (default) does both.

Inno Setup's `ISCC.exe` is a Windows binary, so this **requires a Windows
host**.

Signing: with `WIN_CERT_PFX` (path to an OV code-signing `.pfx`) and
`WIN_CERT_PASSWORD`, the script signs the app's `.exe`/`.dll`/`.node` files
with `signtool` before building the installers, then the installers. With
Azure Trusted Signing, the release workflow signs between the two phases and
after `setup`, and sets `ZE_WIN_SIGNED=1` so the names drop `-unsigned`.

## Linux

```bash
build/zero-egress/build-linux.sh x64
```

Builds `../VSCode-linux-x64` with `vscode-linux-x64-min`, runs the gates,
then packages the tarball (unpacks to `zero-egress-<v>-linux-x64/`), the
`.deb` (`-prepare-deb`/`-build-deb`, needs `dpkg-deb` and `fakeroot`), the
`.rpm` (`-prepare-rpm`/`-build-rpm`, needs `rpmbuild`) and the AppImage
(`make-appimage.sh`, downloads `appimagetool`).
