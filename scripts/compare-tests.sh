#!/usr/bin/env bash
# Compares test declarations (it/test, it.each counted once) between each v3 file
# and its v4 copy listed in migration/test-pairs.tsv, allowing the documented delta. Exits 1 on any mismatch,
# so a cut that silently drops a test fails the check.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
v3="${V3_SRC:-$root/../v3/packages/factory/src}"
count() { grep -cE '^\s*(it|test)(\.(each|skip|only|todo|concurrent)(\(.*\))?)?\(' "$1" || true; }
status=0
while IFS=$'\t' read -r from to delta why; do
  [[ -z "$from" || "$from" == \#* ]] && continue
  if [[ ! -f "$v3/$from" ]]; then echo "MISSING v3  $from"; status=1; continue; fi
  if [[ ! -f "$root/packages/$to" ]]; then echo "MISSING v4  $to"; status=1; continue; fi
  a=$(count "$v3/$from"); b=$(count "$root/packages/$to"); want=$((a + ${delta:-0}))
  if [[ "$b" != "$want" ]]; then echo "DIFF  $a -> $b (expected $want)  $to"; status=1
  elif [[ -n "${delta:-}" ]]; then echo "ok    $a -> $b ($delta: $why)  $to"
  else echo "ok    $a  $to"; fi
done < "$root/migration/test-pairs.tsv"
grep -rnE '^\s*(it|test|describe)\.(skip|only)\(' "$root"/packages/*/src && { echo "skip/only found"; status=1; } || true
exit $status
