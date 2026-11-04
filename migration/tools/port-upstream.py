#!/usr/bin/env python3
"""Port one upstream (mastra-ai/mastra) commit into v4 with a 3-way merge per file.

    port-upstream.py <sha>              # apply
    port-upstream.py <sha> --dry-run    # only report what would happen
    port-upstream.py <sha> --map 'mastracode/factory/src/boards/review.ts=packages/pipelines/src/review/upstream-review.ts'

For every file the commit touches:

- skipped when it belongs to something v4 does not support (Linear, Jira,
  incident.io, Slack, WorkOS, browser tools, Knowledge, CLI, generated files,
  changesets, `mastracode/sdk`, e2e);
- modified: `git merge-file` with base = upstream before the commit, ours = the
  v4 file, theirs = upstream after the commit. A file v4 never changed merges
  cleanly; a diverged one gets conflict markers only where both sides changed
  the same lines;
- added: copied to where its upstream siblings live in v4 (majority of the
  directory's files already found in v4), or to a `--map` target;
- deleted: reported, never removed.

The v4 counterpart of an upstream file is the v4 file with the same name whose
content is closest to the upstream base version (imports ignored), so moved and
renamed packages are found without a hand-kept table. `--map` overrides it.

Imports are not rewritten: copied files keep upstream's relative imports and
`pnpm verify` (types) shows which ones to point at v4 packages.

Nothing is committed. The report ends with the next steps.
"""

import argparse
import collections
import difflib
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
UPSTREAM = os.environ.get('UPSTREAM_REPO', os.path.abspath(os.path.join(ROOT, '..', 'temp', 'mastra-fork')))

UNSUPPORTED = re.compile(
    r'(^|/)(linear|jira|incidentio|incident-io|slack|workos|knowledge|browser)(/|[-_.])'
    r'|^packages/cli/'
    r'|^mastracode/sdk/'
    r'|^templates?/|create-factory'
    r'|\.generated\.'
    r'|^\.changeset/'
    r'|^mastracode/[\w-]+/README\.md$'
    r'|/e2e/',
    re.IGNORECASE,
)
SKIP_DIRS = {'node_modules', 'dist', '.git', '.mastra', 'migration', 'coverage', '.turbo'}
SOURCE_EXT = ('.ts', '.tsx', '.md', '.json', '.css', '.mjs', '.js')
CLEAN_MATCH = 0.98
MIN_MATCH = 0.5


def git(repo, *args, check=True):
    result = subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        sys.exit(f'git {" ".join(args)} failed in {repo}:\n{result.stderr.strip()}')
    return result


def upstream_blob(rev, path):
    result = git(UPSTREAM, 'show', f'{rev}:{path}', check=False)
    return result.stdout if result.returncode == 0 else None


def body(text):
    """Lines that carry meaning across repositories: imports and blanks differ by layout."""
    return [
        line
        for line in text.splitlines()
        if line.strip() and not line.startswith('import ') and not line.lstrip().startswith(('from ', '} from '))
    ]


def similarity(a, b):
    return difflib.SequenceMatcher(None, body(a), body(b), autojunk=False).ratio()


def index_v4():
    by_name = collections.defaultdict(list)
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name.endswith(SOURCE_EXT):
                by_name[name].append(os.path.relpath(os.path.join(root, name), ROOT))
    return by_name


def read(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as handle:
        return handle.read()


def find_counterpart(path, base_text, by_name):
    """The v4 file with the same name closest to upstream's base version, and how close it is."""
    candidates = by_name.get(os.path.basename(path), [])
    best, best_score = None, 0.0
    for candidate in candidates:
        try:
            score = similarity(read(candidate), base_text)
        except (OSError, UnicodeDecodeError):
            continue
        if score > best_score:
            best, best_score = candidate, score
    return (best, best_score) if best_score >= MIN_MATCH else (None, best_score)


def changed_files(sha):
    out = git(UPSTREAM, 'show', '--format=', '--name-status', '-M', sha).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split('\t')
        status = parts[0][0]
        if status == 'R':
            rows.append(('M', parts[2], parts[1]))
        else:
            rows.append((status, parts[1], parts[1]))
    return rows


def sibling_dir(path, placed):
    """Where the upstream directory of a new file lives in v4, by the majority of its files placed so far."""
    directory = os.path.dirname(path)
    votes = collections.Counter(
        os.path.dirname(v4) for upstream, v4 in placed.items() if os.path.dirname(upstream) == directory and v4
    )
    return votes.most_common(1)[0][0] if votes else None


def sibling_dir_from_tree(path, parent, by_name):
    """Fallback for a new file: locate a few of its upstream neighbours in v4."""
    directory = os.path.dirname(path)
    names = git(UPSTREAM, 'ls-tree', '--name-only', f'{parent}:{directory}', check=False).stdout.split()
    votes = collections.Counter()
    for name in names[:12]:
        neighbour = f'{directory}/{name}'
        text = upstream_blob(parent, neighbour)
        if text is None or not name.endswith(SOURCE_EXT):
            continue
        match, score = find_counterpart(neighbour, text, by_name)
        if match and score >= 0.8:
            votes[os.path.dirname(match)] += 1
    return votes.most_common(1)[0][0] if votes else None


IMPORT_STATEMENT = re.compile(
    r"^\s*(import|export)\s+(type\s+)?(\*(\s+as\s+\w+)?|\{[^}]*\}|[\w$]+(\s*,\s*\{[^}]*\})?)?\s*(from\s*)?['\"][^'\"]+['\"];?\s*$",
    re.MULTILINE,
)
CONFLICT = re.compile(r'^<<<<<<< v4\n(.*?)^=======\n(.*?)^>>>>>>> upstream\n', re.MULTILINE | re.DOTALL)
IMPORTED_NAMES = re.compile(r'\{([^}]*)\}|import\s+(?:type\s+)?([\w$]+)\s+from')


def imports_only(text):
    return not IMPORT_STATEMENT.sub('', text).strip()


def imported_names(text):
    names = set()
    for group, default in IMPORTED_NAMES.findall(text):
        for name in (group.split(',') if group else [default]):
            name = re.sub(r'^\s*type\s+', '', name).split(' as ')[-1].strip()
            if name:
                names.add(name)
    return names


def resolve_import_conflicts(text):
    """Keeps v4's import lines where both sides of a conflict are only imports.

    Upstream's relative paths never fit v4's packages; the names upstream starts
    importing are returned so they can be added by hand.
    """
    missing = set()

    def keep_ours(match):
        ours, theirs = match.group(1), match.group(2)
        if not (imports_only(ours) and imports_only(theirs)):
            return match.group(0)
        missing.update(imported_names(theirs) - imported_names(ours))
        return ours

    return CONFLICT.sub(keep_ours, text), missing


def merge(ours_path, base_text, theirs_text):
    """3-way merge into the v4 file. Returns the merged text, the number of conflicts and names to import."""
    with tempfile.TemporaryDirectory() as tmp:
        base = os.path.join(tmp, 'base')
        theirs = os.path.join(tmp, 'theirs')
        ours = os.path.join(tmp, 'ours')
        for file, text in ((base, base_text), (theirs, theirs_text), (ours, read(ours_path))):
            with open(file, 'w', encoding='utf-8') as handle:
                handle.write(text)
        result = subprocess.run(
            ['git', 'merge-file', '-L', 'v4', '-L', 'upstream-base', '-L', 'upstream', ours, base, theirs],
            capture_output=True,
            text=True,
        )
        if result.returncode < 0:
            sys.exit(f'git merge-file failed for {ours_path}: {result.stderr}')
        with open(ours, encoding='utf-8') as handle:
            merged = handle.read()
    if result.returncode == 0:
        return merged, 0, set()
    merged, missing = resolve_import_conflicts(merged)
    return merged, len(CONFLICT.findall(merged)), missing


def write(path, text):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as handle:
        handle.write(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('sha')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--map', action='append', default=[], metavar='UPSTREAM=V4', help='force a target path')
    args = parser.parse_args()

    if not os.path.isdir(os.path.join(UPSTREAM, '.git')) and git(UPSTREAM, 'rev-parse', '--git-dir', check=False).returncode:
        sys.exit(f'Upstream checkout not found: {UPSTREAM} (set UPSTREAM_REPO)')
    sha = git(UPSTREAM, 'rev-parse', '--short=10', args.sha).stdout.strip()
    parent = git(UPSTREAM, 'rev-parse', '--short=10', f'{sha}~1').stdout.strip()
    subject = git(UPSTREAM, 'log', '-1', '--format=%s', sha).stdout.strip()
    forced = dict(item.split('=', 1) for item in args.map)

    by_name = index_v4()
    placed = {}
    report = collections.defaultdict(list)

    rows = changed_files(sha)
    # Modified files first: they tell where each upstream directory lives in v4, which places new files.
    rows.sort(key=lambda row: row[0] != 'M')

    for status, path, old_path in rows:
        if UNSUPPORTED.search(path):
            report['skipped (unsupported)'].append(path)
            continue

        if status == 'D':
            match, _ = find_counterpart(path, upstream_blob(parent, path) or '', by_name)
            report['deleted upstream (remove by hand if still unused)'].append(f'{path} -> {match or "not in v4"}')
            continue

        theirs = upstream_blob(sha, path)
        if theirs is None:
            report['unreadable'].append(path)
            continue

        if status == 'M':
            base = upstream_blob(parent, old_path) or ''
            target, score = (forced[path], 1.0) if path in forced else find_counterpart(old_path, base, by_name)
            if not target:
                report['not found in v4 (use --map or port by hand)'].append(f'{path} (best {score:.2f})')
                placed[path] = None
                continue
            placed[path] = target
            merged, conflicts, missing = merge(target, base, theirs)
            if merged == read(target):
                report['already in v4'].append(target)
                continue
            if not args.dry_run:
                write(target, merged)
            label = f'{target}  <- {path}  (match {score:.2f})'
            if missing:
                report['imports to add (upstream started using these names)'].append(
                    f'{target}: {", ".join(sorted(missing))}'
                )
            if conflicts:
                report['merged WITH CONFLICTS (resolve <<<<<<< markers)'].append(f'{label}, {conflicts} conflict(s)')
            else:
                report['merged cleanly'].append(label)
            continue

        # Added upstream.
        if path in forced:
            target = forced[path]
        else:
            directory = sibling_dir(path, placed) or sibling_dir_from_tree(path, parent, by_name)
            target = os.path.join(directory, os.path.basename(path)) if directory else None
        if not target:
            report['new file with no home in v4 (use --map)'].append(path)
            continue
        if os.path.exists(os.path.join(ROOT, target)):
            report['new upstream file collides with an existing v4 file (use --map)'].append(f'{path} -> {target}')
            continue
        placed[path] = target
        if not args.dry_run:
            write(target, theirs)
        report['added (fix imports)'].append(f'{target}  <- {path}')

    mode = 'DRY RUN' if args.dry_run else 'APPLIED'
    print(f'{mode}: {sha} {subject}\n')
    order = [
        'merged cleanly',
        'already in v4',
        'added (fix imports)',
        'imports to add (upstream started using these names)',
        'merged WITH CONFLICTS (resolve <<<<<<< markers)',
        'not found in v4 (use --map or port by hand)',
        'new file with no home in v4 (use --map)',
        'new upstream file collides with an existing v4 file (use --map)',
        'deleted upstream (remove by hand if still unused)',
        'unreadable',
        'skipped (unsupported)',
    ]
    for key in order:
        if report.get(key):
            print(f'{key}: {len(report[key])}')
            for line in report[key]:
                print(f'  {line}')
            print()

    print('Next:')
    print('  1. Resolve conflicts:  grep -rln "^<<<<<<< v4" packages apps')
    print('  2. Fix imports of added files; drop leftovers of unsupported integrations.')
    print('  3. Port the tests, update migration/test-pairs.tsv, run `pnpm verify`.')
    print(f'  4. Commit only these paths with "(port of {sha})"; add a row to MIGRATION.md.')
    if report.get('merged WITH CONFLICTS (resolve <<<<<<< markers)') or report.get(
        'not found in v4 (use --map or port by hand)'
    ):
        sys.exit(1)


if __name__ == '__main__':
    main()
