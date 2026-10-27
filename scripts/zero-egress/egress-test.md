# ZeroEgress: Runtime Egress Test

Verifies from the outside that a running build only talks to loopback and to servers the user configured.
Pass means: only loopback plus `10.255.255.1:8000` (the vLLM server configured in the session below).
An unconfigured private IP is blocked, and the block shows in the Output channel "ZeroEgress: Network".

## Scripted session (both methods)
1. Start the app (fresh `--user-data-dir` and `--extensions-dir`) and wait for the workbench.
2. Open the chat sidebar.
3. Open ZeroEgress Settings, then Local Providers. Only Ollama, vLLM and LM Studio appear.
4. Open the Extensions view and search. No gallery results, no outbound attempt.
5. Install a local `.vsix`. It installs (local, allowed).
6. Configure vLLM at `http://10.255.255.1:8000` and send one message.
7. Make one request to an unconfigured private IP. Open Help → Toggle Developer Tools, and in the
   Console run `fetch('https://10.255.255.2:1234/')`. It rejects with `Failed to fetch`, and the
   Output channel "ZeroEgress: Network" shows `<time> blocked 10.255.255.2:1234 (caller: renderer)`.
   (Use `https:`; the workbench's content security policy refuses a plain `http:` fetch from the
   page before the guard sees it. Don't use a provider endpoint field for this: an address entered
   there is configured, and so allowed.)
8. Positive control (Method B): in the same Console run `fetch('https://127.0.0.1:19999/')`. It is
   loopback, so the guard allows it; with the proxy flags below Chromium sends it to the proxy,
   which logs `127.0.0.1:19999`. The verdict requires that line, so it proves the proxy saw the app.
   (Use a high port: Chromium refuses "unsafe" ports such as 9 before any proxy sees them.)
9. Quit.

## Method A: OS firewall
Run the session with an outbound-deny firewall that logs blocked attempts for the app's process
(for example Little Snitch, `pf` with `log`, or Windows Firewall with logging). Loopback stays open.
Pass iff the log shows no outbound attempt except to loopback and `10.255.255.1:8000`.
Do not change firewall rules on a machine you do not own; use a VM.

## Method B: logging proxy (CI-friendly)
```
node scripts/zero-egress/egress-proxy.mjs --log egress.jsonl --port 18080 &
# Do not export HTTP(S)_PROXY / NO_PROXY: each window would replace the --proxy-server rules below
# with them and bypass loopback, so the positive control would never reach the proxy. The extension
# host resolves its proxy through the same Chromium session.
./scripts/code.sh --user-data-dir <fresh> --extensions-dir <fresh> \
  --proxy-server=http://127.0.0.1:18080 --proxy-bypass-list='<-loopback>'
# ... run the scripted session, including the positive control (step 8), quit ...
node scripts/zero-egress/egress-verdict.mjs egress.jsonl --expect 127.0.0.1:19999 --allow 10.255.255.1:8000
```
The proxy logs `{host, port, time}` per attempt and never forwards anything. The verdict prints
`EGRESS TEST PASSED` (exit 0), or lists each offending `host:port` (exit 1). It also fails when the
`--expect` positive control is missing from the log, when the log is empty or absent, and when no
`--expect` is given: an empty log alone cannot tell a clean run from an observer that saw nothing.

`scripts/zero-egress/smoke.mjs` automates steps 1, 7 and 8 (plus a check of the main log for the
block line) against a packaged build; the release workflow runs it on every platform.

Block direct egress at the OS firewall as well. A proxy only sees clients that honor proxy settings;
Node sockets in the extension host and Chromium traffic with a proxy bypass can go around it.

## Evidence
Keep the proxy log, the verdict output and the firewall log with the build, and export the
"ZeroEgress: Network" output channel. Do not commit machine-specific logs.
