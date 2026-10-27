#!/usr/bin/env bash
# defer-test-types.sh PACKAGE_DIR — the package's tests keep their v3 type debt:
# `check` typechecks sources only, `check:tests` (and scripts/test-type-debt.sh) count the rest.
set -euo pipefail
dir="$(cd "$(dirname "$0")/../../packages/$1" && pwd)"
cat > "$dir/tsconfig.json" <<'JSON'
{
  "extends": "../../tsconfig.node.json",
  "include": ["src/**/*.ts", "vitest.config.ts"],
  // v3 never typechecked these suites; scripts/test-type-debt.sh counts what is left.
  "exclude": ["src/**/*.test.ts"]
}
JSON
cat > "$dir/tsconfig.test.json" <<'JSON'
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*.ts"],
  "exclude": []
}
JSON
python3 - "$dir/package.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p))
c['scripts']['check:tests'] = "tsc --noEmit -p tsconfig.test.json"
open(p, 'w').write(json.dumps(c, indent=2) + '\n')
PY
