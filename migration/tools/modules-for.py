#!/usr/bin/env python3
"""Print the modules of packages/<from>/src that a plan assigns to one package.

    modules-for.py PLAN PACKAGE [--from platform]

PLAN has `glob package` lines; the first matching glob wins, as in the planning
script. Output is one module per line, ready for extract-package.py.
"""
import fnmatch
import os
import sys

plan, package = sys.argv[1], sys.argv[2]
source = sys.argv[sys.argv.index('--from') + 1] if '--from' in sys.argv else 'platform'
root = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', source, 'src')
rules = [line.split() for line in open(plan) if line.strip() and not line.startswith('#')]
for walk_root, _, names in os.walk(root):
    for name in sorted(names):
        if not name.endswith('.ts') or name.endswith('.test.ts'):
            continue
        module = os.path.relpath(os.path.join(walk_root, name), root)[:-3]
        owner = next((p for pattern, p in rules if fnmatch.fnmatch(module, pattern)), None)
        if owner == package:
            print(module)
