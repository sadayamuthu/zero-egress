# ZeroEgress build scripts

This directory holds the packaging scripts used to produce installable ZeroEgress
builds from this repo. It does not replace the upstream VS Code/gulp build —
it wraps it with the steps and flags ZeroEgress needs (React bundle, ad-hoc
codesign, dmg staging, Inno Setup definitions).

## Build matrix

| Host    | Arch  | Script                                  | Artifacts (in `dist/`)                                   |
|---------|-------|-----------------------------------------|----------------------------------------------------------|
| macOS   | arm64 | `build/zero-egress/build-mac.sh arm64`  | `ZeroEgress-<version>-arm64.dmg`                         |
| macOS   | x64   | `build/zero-egress/build-mac.sh x64`    | `ZeroEgress-<version>-x64.dmg`                           |
| Windows | x64   | `build/zero-egress/build-win.sh x64`    | `ZeroEgress-<version>-x64-setup.exe`                     |
| Linux   | x64   | `build/zero-egress/build-linux.sh x64`  | `ZeroEgress-<version>-x64.{tar.gz,deb,rpm,AppImage}`     |

`<version>` is read from `product.json` (`zeroEgressVersion`, currently `0.1.0`).

Windows artifacts require a Windows host (see below).

## Prerequisites (all platforms)

Run from a clean checkout of `git/zero-egress`, in this order:

1. `npm ci` — installs dependencies. This step alone can take tens of
   minutes; a failure here is almost always a missing native build
   prerequisite (e.g. Python, a C/C++ toolchain, or a mismatched Node
   version), not a script bug.
2. `npm run buildreact` — compiles the React/Tailwind bundle under
   `src/vs/workbench/contrib/zeroEgress/browser/react/`. This **must** run before
   any TypeScript compile or gulp packaging task; ZeroEgress's editor UI is
   built on top of this bundle and gulp does not build it for you.
3. The platform gulp target (invoked by the `build-*.sh` scripts),
   e.g. `npm run gulp -- vscode-darwin-arm64-min`.

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

This script (`build/zero-egress/build-mac.sh`):
1. Runs `npm run buildreact`.
2. Runs `npm run gulp -- vscode-darwin-<arch>-min`, which produces
   `../VSCode-darwin-<arch>/*.app` (one directory above the repo root).
3. Ad-hoc codesigns the `.app` (`codesign --force --deep --sign -`) so
   Gatekeeper allows it to launch after a right-click → Open.
4. Calls `build/zero-egress/make-dmg.sh` to stage the `.app` plus an `Applications`
   symlink into a volume and produce `dist/ZeroEgress-<version>-<arch>.dmg`.

## Windows

```bash
build/zero-egress/build-win.sh x64   # run under bash / git-bash on Windows
```

Windows packaging shells out to Inno Setup's `ISCC.exe` to produce the
installer (`build/gulpfile.vscode.win32.js`). `ISCC.exe` is a Windows binary
(resolved via the `innosetup` npm package), so this **requires a Windows
host**. The script copies the `system` installer to
`dist/ZeroEgress-<version>-<arch>-setup.exe`.

## Linux

```bash
build/zero-egress/build-linux.sh x64
```

Builds the min Linux app, then packages a tarball, `.deb`, `.rpm`, and a
portable AppImage (`build/zero-egress/make-appimage.sh`).
