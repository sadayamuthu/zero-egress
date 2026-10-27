# Egress

ZeroEgress makes no network connection except to loopback and to the
servers you configured. This file says what was taken out to get there,
how the runtime guard enforces it, what the guard can't see, and how to
check a release yourself without trusting any of this.

- [What was removed](#what-was-removed)
- [The runtime guard](#the-runtime-guard)
- [The static gate](#the-static-gate)
- [Known limits](#known-limits)
- [Verify it yourself](#verify-it-yourself)

## What was removed

| Area | What changed |
|------|--------------|
| Model providers | Only Ollama, vLLM, LM Studio and oMLX, at endpoints you set (optional API key for OpenAI-compatible locals). No cloud providers; their API hosts (`api.openai.com`, `api.anthropic.com`, `openrouter.ai`, `generativelanguage.googleapis.com` and others) are on the static deny list |
| Analytics | The PostHog client and the `posthog-node` dependency are gone. `IMetricsService` is a no-op |
| Telemetry | `product.json` has no telemetry or experiment keys (`enableTelemetry`, `aiConfig`, `tasConfig`), so VS Code's telemetry never starts. The TypeScript extension's experimentation service (which fetched `default.exp-tas.com`), its telemetry reporter and both dependencies are deleted. Other built-in extensions still bundle Microsoft's telemetry library, with their instrumentation keys (`aiKey`) blanked; it stays idle because telemetry is off, and the guard would block it |
| Updates | No update URL, no background check, no GitHub API call. **ZeroEgress: Check for Updates** says "Updates are manual: download new versions from github.com/sadayamuthu/zero-egress/releases." |
| Extension gallery | `extensionsGallery` is empty: no marketplace, no search, no recommendations. Extensions install from `.vsix` files |
| Cloud sign-in | The `github`, `github-authentication` and `microsoft-authentication` extensions are deleted. Settings Sync has no store configured |
| Remote development | `open-remote-ssh`, `open-remote-wsl` and `tunnel-forwarding` are deleted |
| Issue reporter | No GitHub search or duplicate-check calls. **Report Issue** opens a prefilled GitHub page in your browser, only when you ask it to |
| Device identifiers | No identifier is derived from the hardware or shared with another product. Upstream hashed a MAC address for `machineId` (the value VS Code also computes), read the Windows SQM `MachineId` from the registry, and used `@vscode/deviceid`, which reads or creates a device ID in a per-user Microsoft folder shared by Microsoft's developer tools. ZeroEgress creates a random UUID per installation for `machineId` and `devDeviceId`, kept in its own user data folder (`storage.json`, keys `zeroEgress.machineId` and `zeroEgress.devDeviceId`); `sqmId` is empty and the dependency is removed. Extensions still get a stable `vscode.env.machineId`, but it identifies only this install. An earlier build's values are deleted on first start; a `Microsoft/DeveloperTools/deviceid` file that 0.1.0 created is left alone, because VS Code may own it |
| Built-in settings that fetch | Off by default and checked in CI: `typescript.disableAutomaticTypeAcquisition: true`, `typescript.tsserver.web.typeAcquisition.enabled: false`, `json.schemaDownload.enable: false`, `npm.fetchOnlinePackageInfo: false`, `git.autofetch: false` |

## The runtime guard

Every outbound request is checked against an allow-list before it
connects. The allow-list is:

- **Always:** loopback. `localhost` and `*.localhost`, `127.0.0.0/8`,
  `::1` and `0.0.0.0`, on any port.
- **When you configure them:** the host and port of each model endpoint in
  Settings, each MCP server URL, and the audit collector URL
  (`zeroEgress.audit.collectorUrl`, used only when `zeroEgress.audit.enabled`
  is on). Matching is exact host and port. You are your own admin: anything
  you configure is allowed.
- **Everything else:** blocked.

Where it is enforced:

| Process | How |
|---------|-----|
| Renderer and webviews | Electron `session.webRequest`, which also covers Electron `net` in the main process |
| Main | Node `fetch`, `http`/`https` requests, `Socket#connect`, UDP (`dgram` send and connect) and DNS (`dns` lookups and queries) |
| Extension host | The same Node hooks, layered over VS Code's proxy agent, plus Electron `net.request` and `net.fetch`. The allow-list is pushed to it over the extension host's RPC; until the first list arrives only loopback is allowed |
| Shared process | The same Node hooks and Electron `net`, loopback only |

UDP is checked like TCP: a datagram is sent, or a UDP socket connected,
only to loopback or a configured `host:port`. A DNS lookup or query
(`dns.lookup`, `dns.resolve*`, `dns.reverse`, `dns.lookupService`, the
promise versions and `dns.Resolver` instances) is allowed only for a
loopback name or the host of a configured server, so a name can't carry
data out in a query. A refused one fails with `ENOTFOUND` and is logged as
`dns://<name>`.

The guard checks the destination at the socket as well as at the request,
so a request is judged by where it actually dials. Every redirect hop of
Electron `net.request` and `net.fetch` is checked before it is followed;
`net.fetch` stops after 20 redirects.

**The network log.** Each blocked attempt is written to the Output panel,
channel **ZeroEgress: Network** (View → Output, then pick it from the
list), with the time, `host:port` and the process that tried. The path and
query are never logged. A line looks like:

```
2026-10-26T02:00:22.162Z blocked example.com:443 (caller: renderer)
```

The caller is `renderer`, `main`, `extensionHost` or `sharedProcess`.
Repeats are coalesced: after the first line for a destination and caller,
further attempts in the next minute are counted and reported in one
summary line, so code stuck in a retry loop doesn't flood the channel.

**Internet endpoints.** If a model endpoint you enter is not loopback or a
private address (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
`100.64/10`, `fc00::/7`, `fe80::/10`, or a single-label, `.local`, `.lan`,
`.internal` or `.home.arpa` name), Settings shows "This server is on the
internet; code you send will leave your network." It is still allowed:
the warning makes it visible, you decide. An MCP server reached by URL gets
the same warning on its card in Settings, and an audit collector URL on
the internet is reported in the main log.

**Model requests in flight.** A model request is judged against the
settings it was sent with. Its endpoint stays allowed for the lifetime of
that request, including the SDK's retries, until it finishes or is
aborted, and at most until the window closes. So if you change or remove
an endpoint while a request to it is running, that request can still
complete. Endpoint probes (listing a server's models) start only after the
endpoint field has been unchanged for 800 ms, so a half-typed address is
not dialed.

**Proxies.** An HTTP proxy (`http.proxy` or a system PAC file) is blocked
unless the proxy's own host and port are configured, because the guard
sees the connection to the proxy.

## The static gate

`scripts/zero-egress/audit-urls.sh <dir>` runs in CI and against every
packaged app before it is packaged:

- **Denied hosts** (fatal): fails on any string from
  [`deny-hosts.txt`](scripts/zero-egress/deny-hosts.txt) (marketplace,
  update, telemetry, cloud-AI, analytics and GitHub API hosts) in shipped
  code. Compiled test files are skipped.
- **product.json invariant** (fatal): `updateUrl`, the gallery URLs,
  `configurationSync.store`, `tasConfig`, `releaseNotesUrl`,
  `nodejsRepository`, `licenseUrl`, `reportIssueUrl` and `aiConfig` must be
  absent or empty, and `enableTelemetry` must not be `true`. On a packaged
  app this reads the `product.json` that ships in it.
- **Other URLs** (informational): lists every non-loopback URL string for
  review. A VS Code build carries hundreds of documentation and schema
  links that are never fetched, so this part doesn't fail the build. The
  runtime guard and the tests below are the real proof.

Three denied hosts are bundled but never contacted, and are listed in
[`known-inert-hosts.txt`](scripts/zero-egress/known-inert-hosts.txt):

- `api.openai.com`: the OpenAI SDK's default base URL. ZeroEgress always
  passes your configured endpoint as the base URL.
- `dc.services.visualstudio.com` and `mobile.events.data.microsoft.com`:
  telemetry endpoints inside bundled Microsoft telemetry libraries, which
  never start because telemetry is off in `product.json`.

```sh
bash scripts/zero-egress/audit-urls.sh out
```

ends with `AUDIT PASSED`.

The brand gate (`check-brand.sh`) also runs on each packaged app, but it
skips `out*/` and `node_modules/`, so on a packaged app it checks little
of the shipped code; widening it is a tracked follow-up. It is a naming
check, not an egress check.

## Known limits

ZeroEgress controls its own traffic. These are the things it does not
control, or controls only partly.

**Out of scope by design** (from the design spec):

- **Terminal processes.** Programs you (or the agent, on your approval)
  launch in the terminal are out of scope. ZeroEgress controls its own
  traffic, not your shell.
- **Third-party extensions' child processes.** Processes that
  user-installed extensions start are out of scope.
- **Stdio MCP servers** are allowed, and treated like terminal processes:
  you chose to run that local program, and its traffic is its own.
- **Git to your own remote.** Built-in Git stays. `git fetch`, `push` and
  `pull` to the repository's own remote is your own configured traffic, in
  the same category as the terminal. Git's background autofetch is off
  (the VS Code default) and pinned off.

**A deliberately malicious extension can get past the guard.** The guard
runs inside the same processes as extensions, so code that sets out to
evade it can. Known ways, verified in the extension host:

- calling Electron's `ClientRequest` prototype method directly to follow a
  redirect the guard refused:
  `Object.getPrototypeOf(req).followRedirect.call(req)`;
- building a `ClientRequest` without `net.request`, so even the first URL
  is unchecked: `new (Object.getPrototypeOf(net.request(url)).constructor)(otherUrl)`;
- emitting a forged nested `'redirect'` event on a request;
- spawning a child process such as `curl`, loading a native addon, using
  WASM or raw syscalls, or calling internal bindings
  (`process._linkedBinding`).

The guard is aimed at ordinary and accidental traffic. Install only
extensions you trust, and use an OS firewall (Method A below) if you need a
control that doesn't depend on the editor.

**Gaps in coverage:**

- **Other utility processes are not hooked.** The pty host (the terminal,
  out of scope anyway), the file watcher and other utility processes have
  no Node or Electron `net` hooks. Electron `net` is wrapped only in the
  extension host and the shared process. The wrap is best effort: if a
  future Electron makes it non-replaceable, a console error says so and
  Electron `net` in that process is unpoliced.
- **Code that saved Node functions before the hooks were installed.** A
  module that kept its own reference to `http.request` (or similar) before
  the extension host installed its hooks gets past the request-level
  check. Its sockets still go through `Socket#connect`, which is checked.
- **Chromium-internal traffic** that doesn't pass through
  `session.webRequest` (for example spellchecker dictionary or component
  downloads, Chromium's own DNS resolver, and WebRTC's UDP in a renderer or
  webview) is not covered. The Node `dgram` and `dns` hooks don't see it.
- **A UDP socket's custom `lookup`.** A `dgram` socket created with its own
  `lookup` function resolves addresses itself, so the address checked at
  `send` may not be the one it reaches. Ordinary code uses the default,
  guarded `dns.lookup`.
- **Multicast group membership.** `addMembership` makes the OS send an
  IGMP or MLD report to the local network. It carries no data, and the
  guard does not block it; sends to the group are checked like any other.
- **The web-worker extension host** is covered only by `session.webRequest`
  (its blocks are labelled `renderer`).
- **Configured hostnames are trusted to resolve wherever DNS sends them.**
  A configured non-loopback *hostname* is matched by name, so the hosts
  file, DNS, or a caller's custom `lookup` decides which address it
  reaches. Loopback names and IP spellings are re-checked after lookup.
- **`*.localhost` names can cause a DNS query.** Names under `localhost`
  are allowed before lookup, and their resolved addresses must be
  loopback. But the lookup itself may be forwarded to an upstream DNS
  resolver, depending on the OS, so a crafted `<data>.localhost` name could
  leak data in a DNS query even though no connection follows. RFC 6761
  says resolvers should answer `.localhost` locally; not every OS does.
- **Electron `net.fetch` in the extension host and shared process** is
  ZeroEgress's own port of Electron's fetch on top of the guarded
  `net.request`. It supports only `http` and `https`, and ignores
  `bypassCustomProtocolHandlers`.

## Verify it yourself

The full procedure is in
[`scripts/zero-egress/egress-test.md`](scripts/zero-egress/egress-test.md).
It runs one scripted session (open the chat, Settings, the Extensions view,
install a local `.vsix`, configure vLLM at `http://10.255.255.1:8000` and
send a message, make one request to an unconfigured private address, quit)
under one of two observers. Pass means the only outbound attempts are to
loopback and `10.255.255.1:8000`, and the unconfigured address shows up as
blocked in **ZeroEgress: Network**.

**Method A: OS firewall.** Run the session with an outbound-deny firewall
that logs blocked attempts by process (Little Snitch, `pf` with `log`, or
Windows Firewall with logging), loopback open. Pass if the log shows
nothing except loopback and `10.255.255.1:8000`. This is the independent
check: it sees every process, including the ones the guard can't. Use a VM
if it isn't your machine.

**Method B: logging proxy** (no firewall rules; what CI can run). The
proxy logs `{host, port, time}` for each attempt and forwards nothing:

```sh
node scripts/zero-egress/egress-proxy.mjs --log egress.jsonl --port 18080 &
# Do not export HTTP(S)_PROXY / NO_PROXY: each window would replace the --proxy-server rules below
# with them and bypass loopback, so the positive control would never reach the proxy. The extension
# host resolves its proxy through the same Chromium session.
# start the app with a fresh --user-data-dir and --extensions-dir, plus
#   --proxy-server=http://127.0.0.1:18080 --proxy-bypass-list='<-loopback>'
# run the session, including the positive control fetch('https://127.0.0.1:19999/'), quit
node scripts/zero-egress/egress-verdict.mjs egress.jsonl --expect 127.0.0.1:19999 --allow 10.255.255.1:8000
```

Expected output:

```
EGRESS TEST PASSED (1 logged attempts, positive control seen: 127.0.0.1:19999)
```

with exit code 0. A failing run lists each offending `host:port` and exits
1. The positive control is a loopback request the session makes on purpose
through the proxy: the verdict fails if it is missing, or if the log is
empty or absent, so an app that ignored the proxy, or a proxy that never
started, can't pass. Each release build also runs this check
automatically: the release workflow's smoke jobs start the packaged app on
Linux (under `xvfb`), macOS and Windows behind the logging proxy, check
that the workbench comes up, that an unconfigured address is blocked and
logged, and run the verdict. A proxy only sees clients that honor proxy settings, so block direct
egress at the firewall as well when you can.

Keep the proxy log, the verdict and the firewall log with the build you
tested, and export the **ZeroEgress: Network** channel. If you find a
connection to a host you didn't configure, that's a security bug: see
[SECURITY.md](SECURITY.md).
