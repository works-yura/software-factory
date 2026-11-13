/**
 * Env files: the `.env.staging`, `apps/mobile/.env` or `ios/Config.xcconfig`
 * a Factory stores per repository, written into each checkout of a sandbox
 * before its setup command runs and rewritten when they are edited.
 */

import { sandboxEnvFilePathProblem } from '@factory/store';
import type { ResolvedSandboxEnvFile } from '@factory/store';

import type { ExecutableSandbox } from './materialization.ts';

/**
 * The checkout-relative paths Factory wrote, one per line, under the
 * checkout's git dir. The next write removes what this lists and the new set
 * leaves out, and the file viewer hides what it lists.
 */
export const ENV_FILES_MANIFEST = 'info/factory-env-files';
export const ENV_FILES_EXCLUDE_BEGIN = '# >>> factory env files (managed by Factory; do not edit)';
export const ENV_FILES_EXCLUDE_END = '# <<< factory env files';

export interface EnvFileToWrite {
  path: string;
  content: string;
}

/**
 * Writes the files, removes the ones written before that are no longer
 * wanted, and lists the written ones in `.git/info/exclude` (between Factory's
 * markers) so neither `git add -A` nor a diff of untracked files picks them
 * up. A path git already tracks is marked `skip-worktree` instead, so the
 * real values never show up as a change or get committed; removing it restores
 * the committed version.
 *
 * Every file is mode 0600 under umask 077. A path whose folder resolves
 * outside the checkout (a symlinked folder) is skipped, as is one that is a
 * folder. Paths are validated again here; they reach the script only as
 * arguments, never as script text.
 */
const WRITE_ENV_FILES_SCRIPT = `
set -eu
cd "$1"
shift
git_dir=$(git rev-parse --absolute-git-dir)
mkdir -p "$git_dir/info"
manifest="$git_dir/${ENV_FILES_MANIFEST}"
exclude="$git_dir/info/exclude"
root=$(pwd -P)
umask 077
inside() {
  a=$(dirname -- "$1")
  while [ ! -e "$a" ]; do a=$(dirname -- "$a"); done
  real=$(cd -- "$a" && pwd -P)
  case "$real/" in "$root/"*) return 0 ;; esac
  echo "factory: skipped env file $1: its folder is outside the checkout" >&2
  return 1
}
tracked() { git ls-files --error-unmatch -- "$1" >/dev/null 2>&1; }
exclude_block() {
  touch "$exclude"
  awk -v begin='${ENV_FILES_EXCLUDE_BEGIN}' -v end='${ENV_FILES_EXCLUDE_END}' '$0 == begin { skip = 1; next } $0 == end { skip = 0; next } !skip' "$exclude" > "$exclude.next"
  if [ -s "$1" ]; then
    { printf '%s\\n' '${ENV_FILES_EXCLUDE_BEGIN}'; sed 's|^|/|' "$1"; printf '%s\\n' '${ENV_FILES_EXCLUDE_END}'; } >> "$exclude.next"
  fi
  mv -f "$exclude.next" "$exclude"
}
# Every path about to be written is excluded first (with the ones written before), so a
# write that fails partway never leaves a file git, or a snapshot of the work, would take.
: > "$manifest.pending"
if [ -f "$manifest" ]; then cat "$manifest" >> "$manifest.pending"; fi
i=1
for arg in "$@"; do
  if [ $((i % 2)) -eq 1 ]; then printf '%s\\n' "$arg" >> "$manifest.pending"; fi
  i=$((i + 1))
done
exclude_block "$manifest.pending"
rm -f "$manifest.pending"
: > "$manifest.next"
while [ $# -ge 2 ]; do
  p=$1
  c=$2
  shift 2
  inside "$p" || continue
  if [ -d "$p" ] && [ ! -L "$p" ]; then
    echo "factory: skipped env file $p: a folder is there" >&2
    continue
  fi
  mkdir -p -- "$(dirname -- "$p")"
  tmp="$p.factory-env.$$"
  printf '%s' "$c" > "$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$p"
  if tracked "$p"; then git update-index --skip-worktree -- "$p"; fi
  printf '%s\\n' "$p" >> "$manifest.next"
done
if [ -f "$manifest" ]; then
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    if grep -qxF -- "$old" "$manifest.next"; then continue; fi
    inside "$old" || continue
    if tracked "$old"; then
      git update-index --no-skip-worktree -- "$old"
      git checkout -- "$old" 2>/dev/null || true
    else
      rm -f -- "$old"
    fi
  done < "$manifest"
fi
mv -f "$manifest.next" "$manifest"
exclude_block "$manifest"
`;

/** The command that writes `files` into the checkout at `repoDir`; exported for tests. */
export function envFilesCommand(repoDir: string, files: readonly EnvFileToWrite[]): { command: string; args: string[] } {
  const args = ['-c', WRITE_ENV_FILES_SCRIPT, 'sh', repoDir];
  const seen = new Set<string>();
  for (const file of files) {
    const problem = sandboxEnvFilePathProblem(file.path);
    if (problem) throw new Error(`Refusing env file path ${JSON.stringify(file.path)}: ${problem}`);
    if (file.content.includes('\0')) throw new Error(`Env file ${file.path} contains a NUL character`);
    // One path, one file: the first wins (paths are unique per repository in the store).
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    args.push(file.path, file.content);
  }
  return { command: 'sh', args };
}

/**
 * Bring the env files of one checkout to exactly `files`: an empty list
 * removes every file Factory wrote there before. Throws with the command's
 * stderr (paths only, never contents) when the checkout can't take them.
 */
export async function writeEnvFiles(
  sandbox: ExecutableSandbox,
  repoDir: string,
  files: readonly EnvFileToWrite[],
): Promise<void> {
  const { command, args } = envFilesCommand(repoDir, files);
  const result = await sandbox.executeCommand(command, args, { timeout: 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`Could not write env files in ${repoDir}: ${result.stderr.trim().slice(-500) || 'failed'}`);
  }
}

/** One checkout of a sandbox and the repository link its env files belong to. */
export interface EnvFileTarget {
  projectRepositoryId: string;
  dir: string;
}

/**
 * Write each checkout's share of `files`. A checkout that fails is logged and
 * the rest still get theirs, so one broken checkout never stops a boot or a
 * command.
 */
export async function writeEnvFilesToCheckouts(
  sandbox: ExecutableSandbox,
  targets: readonly EnvFileTarget[],
  files: readonly ResolvedSandboxEnvFile[],
  onError: (error: unknown, target: EnvFileTarget) => void = warnWriteFailed,
): Promise<void> {
  for (const target of targets) {
    const mine = files
      .filter(file => file.projectRepositoryId === target.projectRepositoryId && file.stage !== 'production')
      .map(({ path, content }) => ({ path, content }));
    try {
      await writeEnvFiles(sandbox, target.dir, mine);
    } catch (error) {
      onError(error, target);
    }
  }
}

function warnWriteFailed(error: unknown, target: EnvFileTarget): void {
  console.warn('[Factory] Could not write env files into a checkout; continuing without them', {
    projectRepositoryId: target.projectRepositoryId,
    dir: target.dir,
    error: error instanceof Error ? error.message : String(error),
  });
}
