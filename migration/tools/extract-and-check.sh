#!/usr/bin/env bash
# extract-and-check.sh PACKAGE_DIR -- <extract-package.py args...>
# Runs one extraction, installs, then typechecks the new package and platform and
# runs the new package's tests. Leaves the tree uncommitted for review.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$1"; shift; [[ "$1" == "--" ]] && shift
python3 "$root/migration/tools/extract-package.py" "$@" || exit 1
(cd "$root" && corepack pnpm install --offline >/dev/null 2>&1 || corepack pnpm install >/dev/null 2>&1) || { echo "install failed"; exit 1; }
for p in "$dir" platform; do
  echo "== tsc $p"
  (cd "$root/packages/$p" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep "error TS" | cut -c1-220 | head -40)
done
if [[ -f "$root/packages/$dir/vitest.config.ts" ]]; then
  echo "== tests $dir"
  (cd "$root/packages/$dir" && ./node_modules/.bin/vitest run 2>&1 | grep -E "Test Files|Tests |×" | head -20)
fi
