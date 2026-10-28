# Contributing to ZeroEgress

Thanks for helping. ZeroEgress is only worth using if one thing holds: the
editor connects to loopback and to the servers the user configured, and to
nothing else. Most of this guide is about keeping that true: every change
that touches networking comes with a test, the gates below run on every
change, and anything the guard can't cover is written down in
[EGRESS.md](EGRESS.md).

- [Ways to help](#ways-to-help)
- [Build from source](#build-from-source)
- [Tests](#tests)
- [The gates](#the-gates)
- [Code layout](#code-layout)
- [Network rules for code changes](#network-rules-for-code-changes)
- [Pull requests](#pull-requests)
- [Security](#security)
- [License](#license)

## Ways to help

- **Find a connection we missed.** Run a release under a firewall or the
  logging proxy ([Verify it yourself](EGRESS.md#verify-it-yourself)). A
  connection to a host you didn't configure is a security bug; report it
  privately, see [SECURITY.md](SECURITY.md).
- **Close a known limit.** [EGRESS.md](EGRESS.md#known-limits) lists what
  the guard can't see yet. Each one closed needs a test that fails before
  the change.
- **Try it with your model server** (Ollama, vLLM, LM Studio or oMLX, on your
  laptop or your network) and open an issue for what breaks.

For anything larger than a small fix, open an issue first so we can agree on
the approach before you write the code.

## Build from source

You need:

- **Node 20** (the exact version is in [`.nvmrc`](.nvmrc); `nvm use` picks
  it up).
- **Python 3** and a C/C++ toolchain for the native modules: Xcode Command
  Line Tools on macOS, `build-essential` on Debian/Ubuntu, Visual Studio
  Build Tools on Windows.
- **git**.

```sh
git clone https://github.com/sadayamuthu/zero-egress.git
cd zero-egress
npm ci
npm run buildreact     # the React UI bundle; must run before compile
npm run compile
./scripts/code.sh --user-data-dir /tmp/ze-dev/data --extensions-dir /tmp/ze-dev/ext
```

`npm ci` takes a while. `./scripts/code.sh` runs the dev build; the first
run downloads Electron. Use a throwaway `--user-data-dir` and
`--extensions-dir` as above so the dev build doesn't share state with an
installed ZeroEgress or another VS Code dev build. Even with those flags,
the dev build reads `~/.zero-egress-dev/mcp.json` and can rewrite
`~/.zero-egress-dev/extensions/extensions.json` on a profile's first launch;
both paths are built from the home directory.

Rebuild the React bundle (`npm run buildreact`) after changing anything
under `src/vs/workbench/contrib/zeroEgress/browser/react/`.

Installers are built by the scripts in
[`build/zero-egress/`](build/zero-egress/README.md).

### Troubleshooting the install

**`npm ci` fails compiling `@vscode/spdlog`** with
`call to consteval function ... is not a constant expression`. The `fmt`
library bundled in spdlog is too old for Apple clang 21 and newer. Install
with `consteval` turned off for that build:

```sh
CXXFLAGS="-DFMT_CONSTEVAL=" npm ci
```

**`npm run test-node` fails with `No prebuild or local build of
@parcel/watcher found`** (seen on Apple silicon). npm skipped the optional
`@parcel/watcher-darwin-arm64` package. Unpack the version the lockfile
pins (check it with `npm ls @parcel/watcher`) into `node_modules`:

```sh
npm pack @parcel/watcher-darwin-arm64@2.5.1
mkdir -p node_modules/@parcel/watcher-darwin-arm64
tar -xzf parcel-watcher-darwin-arm64-2.5.1.tgz --strip-components=1 -C node_modules/@parcel/watcher-darwin-arm64
rm parcel-watcher-darwin-arm64-2.5.1.tgz
```

## Tests

```sh
npm run test-node      # unit tests (Node), including the ZeroEgress suites
```

`test-node` skips every test under a `browser/`, `electron-main/`,
`electron-sandbox/` or `electron-utility/` folder, which includes the
guard and the audit pipeline. Run those suites by path:

```sh
node test/unit/node/index.js --run src/vs/workbench/contrib/zeroEgress/electron-main/test/egressGuard.test.ts

# every ZeroEgress electron-main suite
for f in src/vs/workbench/contrib/zeroEgress/electron-main/test/*.test.ts src/vs/workbench/contrib/zeroEgress/electron-main/audit/test/*.test.ts; do
  node test/unit/node/index.js --run "$f" || break
done
```

The egress tests live in:

- `src/vs/workbench/contrib/zeroEgress/common/test/egressPolicy.test.ts`:
  the allow-list rules.
- `src/vs/workbench/contrib/zeroEgress/electron-main/test/`: the guard,
  model-request leases, update and metrics no-ops, the audit pipeline.
- `src/vs/workbench/contrib/zeroEgress/node/test/egressNodeHooks.test.ts`:
  the Node and Electron `net` hooks, redirects included.

## Releases on main

After CI passes on a push to `main`, [Bump and release](.github/workflows/bump-release.yml)
patch-bumps `product.json` (`zeroEgressVersion` 0.1.0 → 0.1.1, and the
`zeroEgressRelease` counter), commits `chore: release vX.Y.Z`, pushes the
tag, and starts the [Release](.github/workflows/release.yml) workflow with
`publish=true`. That builds the installers and publishes the GitHub Release.

To skip a bump for one merge, include `[skip release]` in the merge commit
message. Manual tag pushes (`git tag vX.Y.Z && git push origin vX.Y.Z`) still
work as before.

## The gates

Run these before you push. Each one is fatal in CI.

```sh
bash scripts/zero-egress/check-brand.sh .          # BRAND CHECK PASSED
node scripts/zero-egress/check-defaults.mjs        # DEFAULTS OK
bash scripts/zero-egress/audit-urls.sh out         # AUDIT PASSED (after npm run compile)
```

- **`check-brand.sh`** fails on names of the projects this code was
  derived from, in file contents and paths. Its patterns are stored
  base64-encoded so the script passes itself. A genuine false positive
  (an upstream grammar or snippet using the English word) goes in
  [`brand-allow.txt`](scripts/zero-egress/brand-allow.txt) with a one-line
  reason; keep that list short.
- **`check-defaults.mjs`** checks that built-in settings which would fetch
  are off by default, and that the removed extensions stay removed.
- **`audit-urls.sh`** fails on any host from
  [`deny-hosts.txt`](scripts/zero-egress/deny-hosts.txt) in the compiled
  code, and on egress keys in `product.json`. See
  [The static gate](EGRESS.md#the-static-gate).

The gates' own tests:

```sh
bash scripts/zero-egress/test/check-brand.test.sh
node scripts/zero-egress/test/check-defaults.test.mjs
node scripts/zero-egress/test/egress-verdict.test.mjs
```

## Code layout

| Path | What it does |
|------|--------------|
| `src/vs/workbench/contrib/zeroEgress/common/egressPolicy.ts` | The allow-list: loopback plus configured host:port, deny by default. Pure, no I/O |
| `src/vs/workbench/contrib/zeroEgress/electron-main/egressGuard.ts` | The guard in the main process: per-window targets, model-request leases, the blocked-attempt record |
| `src/vs/workbench/contrib/zeroEgress/node/egressNodeHooks.ts` | Hooks on Node `fetch`, `http`/`https`, `Socket#connect` and Electron `net`, shared by main, the extension host and the shared process |
| `src/vs/workbench/api/node/extHostEgressGuard.ts` | The extension host's copy of the targets, pushed over RPC |
| `src/vs/workbench/contrib/zeroEgress/browser/egressTargetsContribution.ts` | Sends configured endpoints to the guard and writes the **ZeroEgress: Network** log |
| `src/vs/workbench/contrib/zeroEgress/electron-main/llmMessage/` | Model requests (main process) |
| `src/vs/workbench/contrib/zeroEgress/electron-main/audit/` | The optional chat audit record and forwarder |
| `src/vs/workbench/contrib/zeroEgress/browser/react/` | Chat, Settings and onboarding UI (React; built by `npm run buildreact`) |
| `scripts/zero-egress/` | The gates, the egress proxy and verdict, the runtime test procedure, icon generation |
| `build/zero-egress/` | Installer build scripts |

## Network rules for code changes

- **No new outbound call** unless its destination is a server the user
  configured. If a feature needs a new kind of destination, it becomes a
  new source in `collectEgressTargets` (`egressPolicy.ts`), the one place
  the allow-list is merged, with tests.
- **New Node or Electron networking paths** need a hook test in
  `egressNodeHooks.test.ts` that shows a blocked destination is refused and
  logged.
- **A built-in setting that fetches** must be off by default and added to
  `check-defaults.mjs`.
- **A host the app must never contact** goes in `deny-hosts.txt`. A denied
  host that stays bundled but is provably never contacted goes in
  `known-inert-hosts.txt`, with the reason in EGRESS.md.
- **Something you can't cover** goes in
  [Known limits](EGRESS.md#known-limits), in the same pull request.

## Pull requests

- Keep each PR to one change; small PRs get reviewed faster.
- Commit messages are `area: summary`, lowercase, as in the history, for
  example `egress: check every Electron net.request redirect hop` or
  `settings: warn on internet endpoints`. Areas in use: `egress`,
  `settings`, `audit`, `typescript`, `docs`, `ci`, `build`.
- Write a test that fails before your change and passes after it.
- Run the [tests](#tests) and [the gates](#the-gates).
- Update README.md or EGRESS.md when you change something a user can see
  or anything about what the app connects to.

The repository's social preview image is
[`.github/social-preview.png`](.github/social-preview.png), generated with
the icons by `node scripts/zero-egress/gen-icons.mjs` (needs `rsvg-convert`
from librsvg). GitHub has no API
for it: upload the PNG by hand in **Settings → General → Social preview**
after changing it.

## Security

Please don't report security problems in a public issue. Use
[**Report a vulnerability**](https://github.com/sadayamuthu/zero-egress/security/advisories/new)
on the repository's Security tab instead. That includes any connection to a
host the user didn't configure. See [SECURITY.md](SECURITY.md) for what to
include and what's in scope.

## License

ZeroEgress is licensed under the [Apache License 2.0](LICENSE.txt); the VS
Code portions are under the [MIT License](LICENSE-VS-Code.txt). By
contributing, you agree that your contributions are licensed under
Apache-2.0.
