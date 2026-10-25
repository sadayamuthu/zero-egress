# ZeroEgress — Runtime Egress Test

Proves the running app makes zero external network connections.

## Method A — macOS application firewall + little snitch style (manual)
1. Disconnect all networks EXCEPT keep loopback (or enable an outbound-deny
   firewall that logs blocked attempts).
2. Launch the built app: `open dist/…/ZeroEgress.app` (or run the compiled
   `out` via the dev host).
3. Scripted session:
   - Wait for full startup (workbench + chat sidebar loaded).
   - Open the chat sidebar.
   - Open Settings → Providers; confirm only Ollama / vLLM / LM Studio appear.
   - Attempt to open the Extensions view and search — confirm no gallery
     results and no outbound attempt (only "gallery unavailable").
   - Attempt to install a local `.vsix` — confirm it installs (local, allowed).
   - Quit.
4. PASS iff the firewall log shows zero outbound connection attempts to any
   non-loopback address for the app's process.

## Method B — logging proxy (CI-friendly)
1. Start a logging TCP sink / proxy that records every connection attempt and
   set `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` to it (and block direct egress at
   the OS firewall so nothing bypasses the proxy).
2. Run the same scripted session as Method A.
3. PASS iff the proxy log contains zero entries to non-loopback hosts.

## Evidence
Save the firewall/proxy log alongside the build as certification evidence.
