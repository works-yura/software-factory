#!/usr/bin/env python3
"""Move modules out of a package into a new workspace package.

    extract-package.py --name @factory/sandbox --dir sandbox --strip sandbox/ \
        sandbox/session-sandbox sandbox/workdir ...

Modules are paths under packages/<from>/src without extension; each module's
tests (`<module>.test.ts`, `<module>.*.test.ts`) move with it. The tool refuses
to move a module that imports a module staying behind, so a new package never
depends back on the one it left. It then:

- `git mv`s sources and tests to packages/<dir>/src/<module minus --strip>,
- rewrites relative imports and `vi.mock` paths inside the moved files,
- points every other package's relative imports of moved modules at the new
  package name,
- writes src/index.ts, package.json (dependency versions copied from the source
  package), tsconfig.json and vitest.config.ts,
- adds the new package to every consumer's dependencies and repoints
  migration/test-pairs.tsv.
"""

import argparse
import json
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PACKAGES = os.path.join(ROOT, 'packages')
SPEC = re.compile(r"""(?P<lead>(?:\bfrom|\bimport|vi\.mock|vi\.importActual(?:<[^>]*>)?|import)\s*\(?\s*)(?P<q>['"])(?P<spec>\.{1,2}/[^'"]+)(?P=q)""")
# Bare specifiers in import/export-from statements and dynamic import(), shaped like package names.
EXTERNAL = re.compile(r"""(?:^\s*(?:import|export)\b[^;'"]*?\bfrom\s*|^\s*import\s*|\bimport\(\s*|vi\.mock\(\s*)['"]((?:@[a-z0-9][\w.-]*/)?[a-z0-9][\w.-]*(?:/[\w./-]*)?)['"]""", re.M)


def module_of(spec, from_dir, src_root):
    path = os.path.normpath(os.path.join(from_dir, spec))
    rel = os.path.relpath(path, src_root)
    return re.sub(r'\.(ts|js|mjs)$', '', rel)


def files_of(src_root, module):
    found = []
    base = os.path.join(src_root, module)
    if os.path.exists(base + '.ts'):
        found.append(module + '.ts')
    directory, stem = os.path.split(base)
    if os.path.isdir(directory):
        for name in sorted(os.listdir(directory)):
            if name.endswith('.test.ts') and (name == stem + '.test.ts' or name.startswith(stem + '.')):
                found.append(os.path.relpath(os.path.join(directory, name), src_root))
    return found


def package_name_of(directory):
    with open(os.path.join(PACKAGES, directory, 'package.json')) as handle:
        return json.load(handle)['name']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--from', dest='source', default='platform')
    parser.add_argument('--name', required=True)
    parser.add_argument('--dir', required=True)
    parser.add_argument('--strip', default='')
    parser.add_argument('--description', default='')
    parser.add_argument('--leave-tests', default='', help='comma-separated modules whose tests stay behind (they test the layer above)')
    parser.add_argument('modules', nargs='+')
    args = parser.parse_args()

    src_root = os.path.join(PACKAGES, args.source, 'src')
    moved = set(args.modules)
    target_of = {m: m[len(args.strip):] if m.startswith(args.strip) else m for m in moved}
    leave = set(filter(None, args.leave_tests.split(',')))
    files = {m: [f for f in files_of(src_root, m) if not (m in leave and f.endswith('.test.ts'))] for m in moved}
    missing = [m for m, f in files.items() if not any(x == m + '.ts' for x in f)]
    if missing:
        sys.exit(f'no such module: {missing}')

    # Refuse back-dependencies.
    violations = []
    for m, fs in files.items():
        for f in fs:
            text = open(os.path.join(src_root, f)).read()
            for match in SPEC.finditer(text):
                target = module_of(match['spec'], os.path.dirname(os.path.join(src_root, f)), src_root)
                if target not in moved and os.path.exists(os.path.join(src_root, target + '.ts')):
                    violations.append(f'{f} -> {target}')
    if violations:
        sys.exit('moved modules import modules that stay behind:\n  ' + '\n  '.join(sorted(set(violations))))

    dest_root = os.path.join(PACKAGES, args.dir, 'src')

    # Resolve every dependency version before changing anything.
    with open(os.path.join(PACKAGES, args.source, 'package.json')) as handle:
        source_pkg = json.load(handle)
    versions = {**source_pkg.get('devDependencies', {}), **source_pkg.get('dependencies', {})}
    workspace = {package_name_of(d): d for d in os.listdir(PACKAGES) if os.path.exists(os.path.join(PACKAGES, d, 'package.json'))}
    unknown = set()
    for fs in files.values():
        for f in fs:
            for spec in EXTERNAL.findall(open(os.path.join(src_root, f)).read()):
                if spec.startswith('node:'):
                    continue
                name = '/'.join(spec.split('/')[:2]) if spec.startswith('@') else spec.split('/')[0]
                if name not in workspace and name not in versions and name != 'vitest':
                    unknown.add(name)
    if unknown:
        sys.exit(f'no version in {args.source}/package.json for: {sorted(unknown)}')
    os.makedirs(dest_root, exist_ok=True)

    # Rewrite imports inside the moved files before moving them.
    externals, test_externals = set(), set()
    for m, fs in files.items():
        for f in fs:
            path = os.path.join(src_root, f)
            text = open(path).read()
            new_dir = os.path.dirname(os.path.join(dest_root, target_of[m] + f[len(m):]))

            def local(match):
                target = module_of(match['spec'], os.path.dirname(path), src_root)
                if target not in moved:
                    return match.group(0)
                ext = '.ts' if re.search(r'\.(ts|js)$', match['spec']) else ''
                rel = os.path.relpath(os.path.join(dest_root, target_of[target]), new_dir) + ext
                rel = rel if rel.startswith('.') else './' + rel
                return f"{match['lead']}{match['q']}{rel}{match['q']}"

            text = SPEC.sub(local, text)
            open(path, 'w').write(text)
            for spec in EXTERNAL.findall(text):
                if spec.startswith('node:'):
                    continue
                name = '/'.join(spec.split('/')[:2]) if spec.startswith('@') else spec.split('/')[0]
                (test_externals if f.endswith('.test.ts') else externals).add(name)

    for m, fs in files.items():
        for f in fs:
            dest = os.path.join(dest_root, target_of[m] + f[len(m):])
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            subprocess.run(['git', 'mv', os.path.join(src_root, f), dest], check=True, cwd=ROOT)

    # Point every other package at the new one.
    consumers = set()
    for directory in sorted(os.listdir(PACKAGES)):
        package_src = os.path.join(PACKAGES, directory, 'src')
        if directory == args.dir or not os.path.isdir(package_src):
            continue
        roots = [package_src] + [os.path.join(PACKAGES, directory, 'scripts')] * os.path.isdir(os.path.join(PACKAGES, directory, 'scripts'))
        for walk_root, _, names in (entry for root in roots for entry in os.walk(root)):
            for name in names:
                if not name.endswith('.ts'):
                    continue
                path = os.path.join(walk_root, name)
                text = open(path).read()

                def outward(match):
                    if directory != args.source:
                        return match.group(0)
                    target = module_of(match['spec'], walk_root, src_root)
                    if target not in moved:
                        return match.group(0)
                    consumers.add(directory)
                    return f"{match['lead']}{match['q']}{args.name}{match['q']}"

                new = SPEC.sub(outward, text)
                if new != text:
                    open(path, 'w').write(new)
                    if name.endswith('.test.ts'):
                        widen_package_mocks(path, args.name)

    # Package files.

    def version(name):
        if name in workspace:
            return 'workspace:*'
        if name in versions:
            return versions[name]
        sys.exit(f'no version for {name} in {args.source}/package.json')

    deps = {n: version(n) for n in sorted(externals - {args.name})}
    dev = {n: version(n) for n in sorted(test_externals - externals - {'vitest'})}
    dev.update({'@types/node': '22.20.1', 'typescript': 'catalog:', 'vitest': 'catalog:'})
    existing_manifest = os.path.join(PACKAGES, args.dir, 'package.json')
    if os.path.exists(existing_manifest):
        with open(existing_manifest) as handle:
            current = json.load(handle)
        if current['name'] != args.name:
            sys.exit(f"{args.dir} is {current['name']}, not {args.name}")
        current.setdefault('dependencies', {}).update(deps)
        current['dependencies'] = dict(sorted(current['dependencies'].items()))
        current.setdefault('devDependencies', {}).update({k: v for k, v in dev.items() if k not in current['dependencies']})
        current['devDependencies'] = dict(sorted(current['devDependencies'].items()))
        current.setdefault('scripts', {})
        if any(f.endswith('.test.ts') for fs in files.values() for f in fs) and 'test' not in current['scripts']:
            current['scripts']['test'] = 'vitest run'
        with open(existing_manifest, 'w') as handle:
            json.dump(current, handle, indent=2)
            handle.write('\n')
        with open(os.path.join(dest_root, 'index.ts'), 'a') as handle:
            for m in sorted(moved, key=lambda x: target_of[x]):
                handle.write(f"export * from './{target_of[m]}.ts';\n")
        finish(args, moved, files, target_of, consumers, deps)
        return
    pkg = {
        'name': args.name,
        'version': '0.1.0',
        'private': True,
        'type': 'module',
        'description': args.description,
        'exports': {'.': './src/index.ts'},
        'scripts': {'check': 'tsc --noEmit', 'test': 'vitest run'},
        'dependencies': deps,
        'devDependencies': dict(sorted(dev.items())),
    }
    has_tests = any(f.endswith('.test.ts') for fs in files.values() for f in fs)
    if not has_tests:
        del pkg['scripts']['test']
        del pkg['devDependencies']['vitest']
    with open(os.path.join(PACKAGES, args.dir, 'package.json'), 'w') as handle:
        json.dump(pkg, handle, indent=2)
        handle.write('\n')
    include = '["src/**/*.ts", "vitest.config.ts"]' if has_tests else '["src/**/*.ts"]'
    with open(os.path.join(PACKAGES, args.dir, 'tsconfig.json'), 'w') as handle:
        handle.write('{\n  "extends": "../../tsconfig.node.json",\n  "include": ' + include + '\n}\n')
    if has_tests:
        with open(os.path.join(PACKAGES, args.dir, 'vitest.config.ts'), 'w') as handle:
            handle.write("import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {\n    environment: 'node',\n    include: ['src/**/*.test.ts'],\n  },\n});\n")
    index = os.path.join(dest_root, 'index.ts')
    if not os.path.exists(index):
        with open(index, 'w') as handle:
            for m in sorted(moved, key=lambda x: target_of[x]):
                handle.write(f"export * from './{target_of[m]}.ts';\n")

    finish(args, moved, files, target_of, consumers, deps)


def widen_package_mocks(path, package_name):
    """A v3 `vi.mock` replaced one module; after extraction it names a whole package.

    Keep the package's real exports and lay the original factory's result over them,
    so only the symbols the test meant to fake are faked.
    """
    text = open(path).read()
    head = f"vi.mock('{package_name}', "
    out, i, changed = [], 0, False
    while True:
        j = text.find(head, i)
        if j < 0:
            out.append(text[i:])
            break
        start = j + len(head)
        depth, k = 1, start
        while depth:
            c = text[k]
            if c in '([{':
                depth += 1
            elif c in ')]}':
                depth -= 1
            k += 1
        factory = text[start : k - 1].rstrip().rstrip(',')
        if 'widened from a v3 module mock' in text[max(0, j - 120) : j]:
            out.append(text[i:k])
            i = k
            continue
        out.append(text[i:j])
        out.append(
            "// widened from a v3 module mock: real package exports, then the original overrides\n"
            f"{head}async importOriginal => ({{\n"
            f"  ...(await importOriginal<typeof import('{package_name}')>()),\n"
            f"  ...(await ({factory})(importOriginal)),\n"
            "}))"
        )
        i = k
        changed = True
    if changed:
        open(path, 'w').write(''.join(out))
    return changed


def resolve_self_imports(package_name, dest_root, paths):
    """Turn `import { a, b } from '<this package>'` inside the package into imports of the files that export them."""
    exported = {}
    for walk_root, _, names in os.walk(dest_root):
        for name in names:
            if not name.endswith('.ts') or name.endswith('.test.ts') or name == 'index.ts':
                continue
            path = os.path.join(walk_root, name)
            text = open(path).read()
            for symbol in re.findall(r'^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)', text, re.M):
                exported.setdefault(symbol, path)
            for group in re.findall(r'^export\s+(?:type\s+)?\{([^}]*)\}', text, re.M):
                for item in group.split(','):
                    item = item.strip().split(' as ')[-1].strip()
                    if item:
                        exported.setdefault(item.replace('type ', ''), path)
    pattern = re.compile(r"^import (type )?\{([^}]*)\} from '" + re.escape(package_name) + r"';\n", re.M)
    for path in paths:
        text = open(path).read()

        def split(match):
            kind = match.group(1) or ''
            by_file = {}
            for item in [i.strip() for i in match.group(2).split(',') if i.strip()]:
                symbol = item.replace('type ', '').split(' as ')[0].strip()
                if symbol not in exported:
                    sys.exit(f'{path}: {symbol} is not exported by any file in {package_name}')
                by_file.setdefault(exported[symbol], []).append(item)
            lines = []
            for source, items in sorted(by_file.items()):
                rel = os.path.relpath(source, os.path.dirname(path))
                rel = rel if rel.startswith('.') else './' + rel
                lines.append(f"import {kind}{{ {', '.join(items)} }} from '{rel}';\n")
            return ''.join(lines)

        new = pattern.sub(split, text)
        if new != text:
            open(path, 'w').write(new)


def finish(args, moved, files, target_of, consumers, deps):
    dest_root = os.path.join(PACKAGES, args.dir, 'src')
    moved_paths = [os.path.join(dest_root, target_of[m] + f[len(m):]) for m in moved for f in files[m]]
    resolve_self_imports(args.name, dest_root, moved_paths)
    for consumer in consumers:
        path = os.path.join(PACKAGES, consumer, 'package.json')
        with open(path) as handle:
            consumer_pkg = json.load(handle)
        consumer_pkg.setdefault('dependencies', {})[args.name] = 'workspace:*'
        consumer_pkg['dependencies'] = dict(sorted(consumer_pkg['dependencies'].items()))
        with open(path, 'w') as handle:
            json.dump(consumer_pkg, handle, indent=2)
            handle.write('\n')

    pairs = os.path.join(ROOT, 'migration', 'test-pairs.tsv')
    lines = open(pairs).read().split('\n')
    for i, line in enumerate(lines):
        cols = line.split('\t')
        if len(cols) < 2 or line.startswith('#'):
            continue
        prefix = args.source + '/src/'
        if cols[1].startswith(prefix):
            rel = cols[1][len(prefix):]
            for m in moved:
                if rel in files[m]:
                    cols[1] = f"{args.dir}/src/{target_of[m]}{rel[len(m):]}"
            lines[i] = '\t'.join(cols)
    open(pairs, 'w').write('\n'.join(lines))

    print(f'{args.name}: moved {sum(len(f) for f in files.values())} files; consumers: {sorted(consumers) or "none"}')
    print('dependencies:', deps)


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--widen-mocks':
        for target in sys.argv[3:]:
            print(target, widen_package_mocks(target, sys.argv[2]))
        sys.exit(0)
    main()
