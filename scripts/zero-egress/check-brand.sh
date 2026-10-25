#!/usr/bin/env bash
# Brand-leak gate. Usage: check-brand.sh <dir>
# Exit 0 + "BRAND CHECK PASSED", or exit 1 + one "BRAND LEAK <file>:<line>: <match>"
# line per hit (a file:line is reported once). Scans file contents and paths.
#
# File listing: inside a git work tree, `git -c core.quotepath=off ls-files -co --exclude-standard`
# (tracked + untracked-but-not-ignored; fast, skips ignored build dirs).
# Otherwise falls back to `find`. Both paths then apply the same skip filters:
# .git, node_modules (any depth), out*, .build, .superpowers, docs/superpowers.
# Binaries are skipped via grep -I.
#
# All patterns containing brand words are stored base64-encoded so this file
# itself passes the gate. Do not add plain-text brand words here.
set -u
DIR="${1:-.}"
[ -d "$DIR" ] || { echo "usage: $0 <dir>" >&2; exit 2; }
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ALLOW_FILE="$SELF_DIR/brand-allow.txt"

if echo QQ== | base64 -d >/dev/null 2>&1; then dec() { printf %s "$1" | base64 -d; }
elif echo QQ== | base64 -D >/dev/null 2>&1; then dec() { printf %s "$1" | base64 -D; }
else dec() { printf %s "$1" | openssl base64 -d -A; }; fi

# Case-insensitive patterns (ERE)
CI_B64="YW5kbG9vcA== bG9vcGVkaXRvcg== bG9vcCBhaXJnYXA= MHhlZ3Jlc3M="
# Case-sensitive patterns (ERE)
CS_B64="XGJMb29wW0EtWl1bQS1aYS16MC05X10q XGJJTG9vcFtBLVpd XGJMT09QX1tBLVpd J2xvb3AtY2hhbm5lbC0= bG9vcFZlcnNpb24= bG9vcFJlbGVhc2U= XC5sb29wcnVsZXM= XGJWb2lkW0EtWl1bQS1aYS16MC05X10q LS12b2lkLQ== XGJ2b2lkLVthLXpd IlZvaWQi J1ZvaWQn dm9pZGVkaXRvcg== Vm9pZCBlZGl0b3I="
# Bare capitalised word; matches are dropped when they match the exclusion regex
BARE_B64="XGJMb29wXGI="
BARE_EXCL_B64="Xkxvb3Aocz8oIGJhY2t8aW5nKXwgb3ZlcnwtZGUp"

join() { local out="" p; for b in $1; do p="$(dec "$b")"; out="${out:+$out|}$p"; done; printf %s "$out"; }
CI_RE="$(join "$CI_B64")"
CS_RE="$(join "$CS_B64")"
BARE_RE="$(dec "$BARE_B64")"
BARE_EXCL="$(dec "$BARE_EXCL_B64")"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cd "$DIR" || exit 2

# --- file list (newline separated, relative paths) ---
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -c core.quotepath=off ls-files -co --exclude-standard
else
  find . -type f | sed 's|^\./||'
fi | grep -Ev '(^|/)(\.git|node_modules|\.build|\.superpowers)(/|$)|(^|/)out[^/]*/|^docs/superpowers/' \
  | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done > "$TMP/files"

# --- allow list: "path" (whole file/path exempt) or "path:<base64 ERE>" ---
printf '%s\n' "@@none@@" > "$TMP/allow_paths"; printf '%s\t%s\n' "@@none@@" "@@none@@" > "$TMP/allow_pats"  # sentinels keep awk NR==FNR idiom safe
if [ -f "$ALLOW_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue;; esac
    if [[ "$line" == *:* ]]; then printf '%s\t%s\n' "${line%%:*}" "$(dec "${line#*:}")" >> "$TMP/allow_pats"
    else printf '%s\n' "$line" >> "$TMP/allow_paths"; fi
  done < "$ALLOW_FILE"
fi

: > "$TMP/hits"
nul() { tr '\n' '\0' < "$TMP/files"; }
run() { nul | xargs -0 grep -IHonE "$@" 2>/dev/null; }

# content: case-insensitive, case-sensitive, bare
run -i -e "$CI_RE" >> "$TMP/hits"
run -e "$CS_RE" >> "$TMP/hits"
run -e "$BARE_RE" | awk -v ex="$BARE_EXCL" '{ m=$0; sub(/^.*:[0-9]+:/,"",m); if (m ~ ex) next; print }' >> "$TMP/hits"

# --- exemptions on content hits ---
# parse file:line:match
awk -F'\t' 'BEGIN{OFS="\t"} {
  if (match($0, /:[0-9]+:/)) { f=substr($0,1,RSTART-1); n=substr($0,RSTART+1,RLENGTH-2); m=substr($0,RSTART+RLENGTH); print f,n,m }
}' "$TMP/hits" > "$TMP/parsed"

# Drop exempt files
awk -F'\t' '{ b=$1; sub(/^.*\//,"",b); if (b=="ThirdPartyNotices.txt" || $1=="scripts/zero-egress/deny-hosts.txt") next; print }' "$TMP/parsed" > "$TMP/p2"

# Drop lines containing the copyright notice (look up each distinct file:line)
CR='Copyright 2025 Glass Devtools'
{ printf '@@\t@@\n'; cut -f1 "$TMP/p2" | sort -u | while IFS= read -r f; do
  grep -IHn -F -e "$CR" -- "$f" 2>/dev/null | sed -E 's/^(.*):([0-9]+):.*$/\1\t\2/'
done; } > "$TMP/crlines"
awk -F'\t' 'NR==FNR{cr[$1"\t"$2]=1; next} !(($1"\t"$2) in cr)' "$TMP/crlines" "$TMP/p2" > "$TMP/p3"

# Allow list on content hits
awk -F'\t' 'NR==FNR{ap[$0]=1; next}
  FILENAME==ARGV[2]{ if (!($1 in pat)) pat[$1]=$2; else pat[$1]=pat[$1] "|" $2; next}
  { if ($1 in ap) next; if (($1 in pat) && ($3 ~ pat[$1])) next; print }' \
  "$TMP/allow_paths" "$TMP/allow_pats" "$TMP/p3" > "$TMP/p4"

# --- path hits ---
{ grep -iE -e "$CI_RE" "$TMP/files"; grep -E -e "$CS_RE" "$TMP/files"; } 2>/dev/null | sort -u \
  | awk -F'\t' 'NR==FNR{ap[$0]=1; next} !($0 in ap){ print $0 "\t0\t" $0 }' "$TMP/allow_paths" - > "$TMP/pathhits"

# Report, one line per file:line
cat "$TMP/p4" "$TMP/pathhits" | awk -F'\t' '!seen[$1 FS $2]++ { printf "BRAND LEAK %s:%s: %s\n", $1, $2, $3 }' > "$TMP/out"

if [ -s "$TMP/out" ]; then
  cat "$TMP/out"
  echo "BRAND CHECK FAILED: $(wc -l < "$TMP/out" | tr -d ' ') leak(s)" >&2
  exit 1
fi
echo "BRAND CHECK PASSED"
