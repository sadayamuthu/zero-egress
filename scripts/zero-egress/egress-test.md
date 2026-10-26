# ZeroEgress: Runtime Egress Test

Verifies from the outside that a running build only talks to loopback and to servers the user configured.
Pass means: only loopback plus `10.255.255.1:8000` (the vLLM server configured in the session below).
An unconfigured private IP is blocked, and the block shows in the Output channel "ZeroEgress: Network".

## Scripted session (both methods)
1. Start the app (fresh `--user-data-dir` and `--extensions-dir`) and wait for the workbench.
2. Open the chat sidebar.
3. Open Settings, then Providers. Only Ollama, vLLM and LM Studio appear.
4. Open the Extensions view and search. No gallery results, no outbound attempt.
5. Install a local `.vsix`. It installs (local, allowed).
6. Configure vLLM at `http://10.255.255.1:8000` and send one message.
7. Quit.

## Method A: OS firewall
Run the session with an outbound-deny firewall that logs blocked attempts for the app's process
(for example Little Snitch, `pf` with `log`, or Windows Firewall with logging). Loopback stays open.
Pass iff the log shows no outbound attempt except to loopback and `10.255.255.1:8000`.
Do not change firewall rules on a machine you do not own; use a VM.

## Method B: logging proxy (CI-friendly)
```
node scripts/zero-egress/egress-proxy.mjs --log egress.jsonl --port 18080 &
export HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 ALL_PROXY=http://127.0.0.1:18080
export NO_PROXY=127.0.0.1,localhost
./scripts/code.sh --user-data-dir <fresh> --extensions-dir <fresh>
# ... run the scripted session, quit ...
node scripts/zero-egress/egress-verdict.mjs egress.jsonl --allow 10.255.255.1:8000
```
The proxy logs `{host, port, time}` per attempt and never forwards anything. The verdict prints
`EGRESS TEST PASSED` (exit 0), or lists each offending `host:port` (exit 1).
Block direct egress at the OS firewall as well. A proxy only sees clients that honor proxy settings;
Node sockets in the extension host and Chromium traffic with a proxy bypass can go around it.

## Evidence
Keep the proxy log, the verdict output and the firewall log with the build, and export the
"ZeroEgress: Network" output channel. Do not commit machine-specific logs.
