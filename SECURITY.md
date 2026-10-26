# Security Policy

## Reporting a vulnerability

Please don't report security problems in a public issue, pull request or
discussion. Use
[**Report a vulnerability**](https://github.com/sadayamuthu/zero-egress/security/advisories/new)
on the repository's Security tab instead. Only the maintainer can see the
report.

Include what you can of:

- the ZeroEgress version and your OS: open the About dialog (**ZeroEgress →
  About ZeroEgress** on macOS, **Help → About** on Windows and Linux) and
  click **Copy**. It lists the ZeroEgress version, the VS Code version it
  is based on, Electron, Chromium, Node.js and the OS
- how you installed it (Homebrew, `.dmg`, `.exe`, `.deb`, `.rpm`,
  AppImage, `.tar.gz`, or built from source) and whether it was a signed
  or `-unsigned` build
- your model providers and endpoints, MCP servers and audit settings, with
  private hostnames replaced by placeholders
- for a connection that shouldn't happen: the destination `host:port`,
  what you were doing when it happened, and how you saw it (firewall log,
  proxy log, or the **ZeroEgress: Network** output channel)
- steps to reproduce, and what happened compared with what you expected

You'll get a reply when the report has been read, and again when a fix is
ready. A fix ships as a patch release; the advisory names you unless you'd
rather it didn't.

## Supported versions

ZeroEgress is pre-1.0. Fixes land in the latest release only; please
upgrade before reporting. There is no auto-update: new versions are on the
[Releases](https://github.com/sadayamuthu/zero-egress/releases) page.

## What counts

Any network connection to a host you didn't configure is a security bug.
ZeroEgress may connect to loopback and to the model endpoints, MCP server
URLs and audit collector URL you set, and nothing else. In scope:

- **Unconfigured connections.** Any connection from the editor itself
  (main process, renderer, webviews, shared process, or the extension host
  running built-in extensions) to a host:port you didn't configure. An
  attempt the guard blocked counts too: the editor's own code shouldn't
  try, and a line in **ZeroEgress: Network** you can't explain is worth
  reporting.
- **Guard bypasses by ordinary code.** A way for a built-in extension, or
  ordinary extension code using Node or Electron networking the usual way,
  to get a request past the guard: a redirect, a URL or option spelling, a
  proxy setting, a timing window.
- **Data leaving through an allowed host.** Code, prompts or chat history
  sent to a configured host other than the one the feature was pointed at,
  or the audit record sent anywhere when no collector URL is set.
- **Something removed coming back.** Telemetry, an update check, the
  extension gallery, analytics or a cloud sign-in that reaches the network
  in a release build.
- **Release integrity.** A published artifact that doesn't match
  `SHA256SUMS`, or a signed build whose signature doesn't verify.

The limits listed in [EGRESS.md](EGRESS.md#known-limits) are known and
documented, so they aren't vulnerabilities on their own: processes started
from the terminal, stdio MCP servers, Git talking to your own remote,
third-party extensions' child processes, and a deliberately malicious
extension working around the in-process hooks. A new way past the guard
that isn't on that list is in scope; if you're not sure, report it
privately anyway.

A bug that doesn't involve the network or release integrity (a crash, a
wrong edit, a UI problem) isn't a vulnerability. Report it in a normal
issue; see [CONTRIBUTING.md](CONTRIBUTING.md).
