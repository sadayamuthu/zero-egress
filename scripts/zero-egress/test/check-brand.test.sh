#!/usr/bin/env bash
# Tests for check-brand.sh. Dirty fixtures are generated into a temp dir from
# base64 (the repo must never contain brand words); clean fixtures are committed.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/../check-brand.sh"
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
d() { printf %s "$1" | base64 -d 2>/dev/null || printf %s "$1" | base64 -D; }

# 1. clean fixtures pass
out="$(bash "$GATE" "$HERE/fixtures/clean" 2>&1)"; rc=$?
{ [ $rc -eq 0 ] && [[ "$out" == *"BRAND CHECK PASSED"* ]]; } && ok "clean passes" || bad "clean passes (rc=$rc: $out)"

# 2. dirty fixtures fail with exactly one leak per dirty file
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
w() { mkdir -p "$(dirname "$T/$1")"; d "$2" > "$T/$1"; }
w a.ts Y2xhc3MgQW5kTG9vcEZvbyB7fQo=
w b.ts Y29uc3QgYyA9ICdsb29wLWNoYW5uZWwteCc7Cg==
w c.css YSB7IGNvbG9yOiB2YXIoLS12b2lkLWJnLTEpOyB9Cg==
w d.ts Y2xhc3MgVm9pZEZvbyB7fQo=
w e.ts Y29uc3QgeCA9IExPT1BfRk9POwo=
w f.ts Ly8gTG9vcCBpcyB0aGUgYmVzdAo=
w g.ts Y29uc3QgaCA9ICdsb29wZWRpdG9yJzsK
w "$(d YW5kbG9vcFRoaW5nLnRz)" ZXhwb3J0IHt9Owo=      # file whose NAME is the brand
EXPECTED=8
# Must be ignored: exempt file, copyright line, node_modules, binary
w "$(d VGhpcmRQYXJ0eU5vdGljZXMudHh0)" YW5kbG9vcCBub3RpY2UK
w copyright.ts Ly8gQ29weXJpZ2h0IDIwMjUgR2xhc3MgRGV2dG9vbHMgYW5kbG9vcAo=
w "$(d bm9kZV9tb2R1bGVzL3gvYW5kbG9vcC50cw==)" YW5kbG9vcCBub3RpY2UK
{ d YW5kbG9vcA==; printf '\0binary'; } > "$T/blob.bin"

check_dirty() { # label
  out="$(bash "$GATE" "$T" 2>/dev/null)"; rc=$?
  n="$(printf '%s\n' "$out" | grep -c '^BRAND LEAK ')"
  [ $rc -eq 1 ] && ok "$1: dirty exits 1" || bad "$1: dirty exits 1 (rc=$rc)"
  [ "$n" -eq $EXPECTED ] && ok "$1: $n leak lines" || { bad "$1: expected $EXPECTED leak lines, got $n"; printf '%s\n' "$out"; }
  for f in a.ts b.ts c.css d.ts e.ts f.ts g.ts; do
    [ "$(printf '%s\n' "$out" | grep -c "^BRAND LEAK $f:")" -eq 1 ] || bad "$1: exactly one leak for $f"
  done
}
check_dirty "find mode"
( cd "$T" && git init -q . ) && check_dirty "git mode"

[ $fail -eq 0 ] && { echo PASS; exit 0; } || { echo FAIL; exit 1; }
