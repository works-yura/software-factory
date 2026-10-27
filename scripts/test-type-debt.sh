#!/usr/bin/env bash
# Prints, per package, how many type errors its test files still carry (v3 never
# typechecked its tests). Packages whose tsconfig includes tests must stay at zero.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
total=0
for dir in "$root"/packages/*/; do
  name=$(basename "$dir")
  [[ -f "$dir/tsconfig.test.json" ]] || continue
  n=$(cd "$dir" && ./node_modules/.bin/tsc --noEmit -p tsconfig.test.json 2>&1 | grep -c "error TS" || true)
  printf '%6s  %s\n' "$n" "$name"
  total=$((total + n))
done
printf '%6s  total\n' "$total"
