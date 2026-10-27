#!/usr/bin/env bash
# Static URL audit (deny-list gate).
#
# The denied-host scan is the hard gate: any hit on a known-egress host
# (telemetry/update/gallery/cloud-API) fails the audit. The non-loopback URL
# scan is INFORMATIONAL only (printed, non-fatal) — a compiled VSCode tree
# carries hundreds of benign doc/schema strings that are never fetched, so a
# blanket URL gate would be noise. The authoritative no-egress proof is the
# runtime egress test, not this static scan.
# Usage: audit-urls.sh <scan-dir>
set -Eeuo pipefail
# Never fail silently: any unexpected error names the command and line.
trap 'rc=$?; echo "AUDIT FAILED: unexpected error (exit $rc) at line $LINENO: $BASH_COMMAND" >&2' ERR

SCAN_DIR="${1:?scan dir required (e.g. out or a built .app)}"
[ -d "$SCAN_DIR" ] || { echo "SCAN_DIR '$SCAN_DIR' not found or not a directory" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
DENY_FILE="$HERE/deny-hosts.txt"
KNOWN_INERT_FILE="$HERE/known-inert-hosts.txt"

fail=0
denied_hosts=""

# A denied host that also appears in known-inert-hosts.txt is bundled but
# provably never contacted (see EGRESS.md), so it is
# reported informationally instead of failing the audit. Blank lines and
# lines beginning with '#' in known-inert-hosts.txt are ignored.
is_known_inert() {
  local host="$1"
  [ -f "$KNOWN_INERT_FILE" ] || return 1
  grep -v '^#' "$KNOWN_INERT_FILE" | grep -v '^[[:space:]]*$' | grep -qxF "$host"
}

echo "== Denied-host scan in $SCAN_DIR =="
while IFS= read -r host; do
  [ -z "$host" ] && continue
  # compiled unit-test files are never shipped code paths: exclude */test/* from the scan
  hits="$(grep -rIn --binary-files=without-match --exclude-dir=test -F "$host" "$SCAN_DIR" || true)"
  if [ -n "$hits" ]; then
    if is_known_inert "$host"; then
      echo "KNOWN-INERT (allowed): $host"
      echo "$hits"
    else
      echo "DENIED HOST '$host':"
      echo "$hits"
      denied_hosts="${denied_hosts:+$denied_hosts, }$host"
      fail=1
    fi
  fi
done < "$DENY_FILE"

echo "== Non-loopback http(s) URL scan in $SCAN_DIR (informational) =="
# Match http(s)://host, then drop loopback hosts. INFORMATIONAL ONLY: this
# section never sets fail — it reports benign doc/schema URLs for review.
urls="$(grep -rIhoE --binary-files=without-match 'https?://[A-Za-z0-9._-]+' "$SCAN_DIR" \
  | sort -u \
  | grep -vE 'https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)' \
  || true)"
if [ -n "$urls" ]; then
  url_count="$(printf '%s\n' "$urls" | grep -c .)"
  echo "INFO (non-fatal): $url_count distinct non-loopback URL(s) found (benign doc/schema strings, not fetched):"
  echo "$urls"
else
  echo "INFO (non-fatal): no non-loopback URLs found."
fi

# product.json egress-config invariant.
#
# Settings Sync, Experiments/A-B, release-notes, and update are inert today
# only because their product.json fields are absent, not because any code
# enforces it. This check makes that a real, enforced gate: an upstream
# merge that re-populates any of these fields fails the audit even though
# no code path changed. When <scan-dir> is a packaged app, the product.json
# that ships in it (resources/app/product.json, which the build rewrites) is
# the one checked; otherwise the repo-root product.json. PRODUCT_JSON_PATH
# overrides both, for testing.
packaged_product_json="$(find "$SCAN_DIR" -ipath '*/resources/app/product.json' -not -path '*/node_modules/*' 2>/dev/null | head -1 || true)"
PRODUCT_JSON="${PRODUCT_JSON_PATH:-${packaged_product_json:-$HERE/../../product.json}}"
echo "== product.json egress-config invariant check ($PRODUCT_JSON) =="
if [ ! -f "$PRODUCT_JSON" ]; then
  echo "PRODUCT.JSON INVARIANT: '$PRODUCT_JSON' not found" >&2
  fail=1
else
  if ! node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));

    const nonEmpty = (v) => {
      if (v === undefined || v === null) return false;
      if (typeof v === "string") return v.trim() !== "";
      if (typeof v === "object") return Object.keys(v).length > 0;
      return true;
    };

    const checks = [
      ["updateUrl", p.updateUrl],
      ["extensionsGallery.serviceUrl", p.extensionsGallery && p.extensionsGallery.serviceUrl],
      ["extensionsGallery.itemUrl", p.extensionsGallery && p.extensionsGallery.itemUrl],
      ["configurationSync.store", p.configurationSync && p.configurationSync.store],
      ["tasConfig", p.tasConfig],
      ["releaseNotesUrl", p.releaseNotesUrl],
      ["nodejsRepository", p.nodejsRepository],
      ["licenseUrl", p.licenseUrl],
      ["reportIssueUrl", p.reportIssueUrl],
      ["aiConfig", p.aiConfig],
    ];

    const problems = checks.filter(([, v]) => nonEmpty(v));
    if (p.enableTelemetry === true) problems.push(["enableTelemetry", true]);

    if (problems.length) {
      for (const [name, val] of problems) {
        console.error(`PRODUCT.JSON INVARIANT FAIL: "${name}" is set (${JSON.stringify(val)}) but must be absent/empty`);
      }
      process.exit(1);
    }
    console.log("PRODUCT.JSON INVARIANT: OK");
  ' "$PRODUCT_JSON"; then
    product_invariant_failed=1
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  reasons=""
  [ -n "$denied_hosts" ] && reasons="denied host(s): $denied_hosts"
  [ -n "${product_invariant_failed:-}" ] && reasons="${reasons:+$reasons; }product.json invariant (see PRODUCT.JSON lines above)"
  [ -f "$PRODUCT_JSON" ] || reasons="${reasons:+$reasons; }product.json not found"
  echo "AUDIT FAILED: ${reasons:-see output above}"
  exit 1
fi
echo "AUDIT PASSED"
