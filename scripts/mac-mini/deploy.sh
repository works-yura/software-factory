#!/bin/bash
# Deploys a commit of this repository to the Mac mini's Factory server.
#   scripts/mac-mini/deploy.sh             # the current HEAD
#   scripts/mac-mini/deploy.sh <ref>       # any commit, e.g. an older one
#   scripts/mac-mini/deploy.sh --rollback  # back to the previous release, no build
#   scripts/mac-mini/deploy.sh --status    # what runs now
#
# The server never runs from the working tree people and agents edit: a dev server there reloads
# on every saved file, half-written code included. Each deploy is a release: a git worktree of this
# repository at the commit, named after when and what it is, in the runtime folder:
#   <runtime>/releases/2026-11-13_2310-d31aa47e   (date_time-commit)
#   <runtime>/current -> releases/<the one that runs>
#   1. the release is checked out (detached), installed and built: the UI and the server's
#      production build (apps/server/.mastra/output, which `start:local` runs);
#   2. only if that all succeeded, `current` flips to it, its start-server.sh replaces the installed
#      one and the LaunchAgent restarts; a failed release is removed, the server is untouched;
#   3. FACTORY_KEEP_RELEASES releases stay (default 2: the new one and the one that ran before it,
#      for --rollback); older ones go to <runtime>/.trash and are deleted in the background.
# Same volume as the pnpm store, so installs hard-link instead of copying.
#
# The runtime folder is FACTORY_RUNTIME (environment, else server.env), else ../v4-runtime next to
# this repository. The LaunchAgent starts whatever server.env's FACTORY_REPO names, so a deploy
# points FACTORY_REPO at <runtime>/current.
#
# The server runs the production build unless server.env says FACTORY_SERVER_MODE=dev. Before the
# first production start the database is backed up once (sqlite .backup, next to it).
#
# Secrets stay in one place: each release's apps/server/.env links to the working tree's.
# Runbook: docs/runbooks/dev-server.md › "Mac mini".
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LABEL="ai.eclipt.factory"
STATE="$HOME/.mastracode/factory-v4"
CONFIG="$STATE/server.env"
if [ -z "${FACTORY_RUNTIME:-}" ] && [ -f "$CONFIG" ]; then
  FACTORY_RUNTIME="$( . "$CONFIG"; echo "${FACTORY_RUNTIME:-}" )"
fi
RUNTIME="${FACTORY_RUNTIME:-$(dirname "$REPO")/v4-runtime}"
RELEASES="$RUNTIME/releases"
CURRENT="$RUNTIME/current"
KEEP="${FACTORY_KEEP_RELEASES:-2}"
[ "$KEEP" -ge 2 ] 2>/dev/null || KEEP=2

log() { echo "[deploy $(date '+%F %T')] $*"; }

active_release() { [ -L "$CURRENT" ] && basename "$(readlink "$CURRENT")" || echo none; }
# Release names sort by time: oldest first.
list_releases() { [ -d "$RELEASES" ] && find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort || true; }
built() { [ -f "$RELEASES/$1/apps/server/.mastra/output/index.mjs" ]; }

# Out of the way at once (rename), deleted in the background: a node_modules tree takes minutes on HFS+.
discard() {
  mkdir -p "$RUNTIME/.trash"
  local target="$RUNTIME/.trash/$1"
  mv "$RELEASES/$1" "$target" && git -C "$REPO" worktree prune
  nohup rm -rf "$target" >/dev/null 2>&1 &
}

# Flip `current` to a release, point autostart at it and restart the server.
activate() {
  local name="$1"
  ln -sfn "releases/$name" "$CURRENT.next" && mv -fh "$CURRENT.next" "$CURRENT"
  # The watchdog ships with the commit: a rollback brings its start-server.sh back too.
  [ -f "$RELEASES/$name/scripts/mac-mini/start-server.sh" ] \
    && install -m 0755 "$RELEASES/$name/scripts/mac-mini/start-server.sh" "$STATE/start-server.sh"
  if [ -f "$CONFIG" ] && ! grep -qxF "FACTORY_REPO=\"$CURRENT\"" "$CONFIG"; then
    { grep -v '^FACTORY_REPO=' "$CONFIG"; printf 'FACTORY_REPO="%s"\n' "$CURRENT"; } > "$CONFIG.next" && mv -f "$CONFIG.next" "$CONFIG"
    log "server.env: FACTORY_REPO is now $CURRENT"
  fi
  log "$name is current; restarting the server"
  launchctl kickstart -k "gui/$UID/$LABEL"
}

if [ "${1:-}" = "--status" ]; then
  active="$(active_release)"
  echo "runtime: $RUNTIME"
  echo "current: $active"
  for name in $(list_releases); do
    marker=" "; [ "$name" = "$active" ] && marker="*"
    echo "  $marker $name  $(git -C "$RELEASES/$name" log -1 --format='%s' 2>/dev/null)"
  done
  grep -h '^FACTORY_REPO=' "$CONFIG" 2>/dev/null | sed 's/^/server.env: /'
  grep -hE 'starting (dev|start):local' "$HOME/Library/Logs/factory.log" 2>/dev/null | tail -1 | sed 's/^/last start: /'
  exit 0
fi

if [ "${1:-}" = "--rollback" ]; then
  active="$(active_release)"
  previous=""
  for name in $(list_releases); do
    [ "$name" = "$active" ] && break
    built "$name" && previous="$name"
  done
  [ -n "$previous" ] || { log "no built release older than $active to roll back to"; exit 1; }
  log "rolling back from $active to $previous"
  activate "$previous"
  log "done: $(git -C "$CURRENT" log -1 --format='%h %s')"
  exit 0
fi

REF="${1:-HEAD}"
SHA="$(git -C "$REPO" rev-parse --verify "${REF}^{commit}")"
[ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ] && [ "$REF" = HEAD ] \
  && log "note: the working tree has uncommitted changes; only commit ${SHA:0:8} is deployed"

mkdir -p "$RELEASES"
NAME="$(date +%F_%H%M)-${SHA:0:8}"
[ -e "$RELEASES/$NAME" ] && NAME="$(date +%F_%H%M%S)-${SHA:0:8}"
DIR="$RELEASES/$NAME"
log "deploying ${SHA:0:8} as release $NAME"

git -C "$REPO" worktree add --detach "$DIR" "$SHA" >/dev/null
ln -sfn "$REPO/apps/server/.env" "$DIR/apps/server/.env"

# `mastra build` installs the bundle's dependencies by running a bare `pnpm`; only corepack is on PATH.
SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT
printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$SHIM/pnpm" && chmod +x "$SHIM/pnpm"

# Chained with &&: `set -e` does not apply inside a subshell on the left of ||.
(
  cd "$DIR" &&
    corepack pnpm install --frozen-lockfile --prefer-offline &&
    corepack pnpm --dir apps/ui build &&
    PATH="$SHIM:$PATH" corepack pnpm --dir apps/server build &&
    [ -f apps/server/.mastra/output/index.mjs ]
) || { discard "$NAME"; log "install or build failed for $NAME: removed it, still on $(active_release)"; exit 1; }

# The mode the server will start in (start-server.sh reads the same file).
MODE="$( ( [ -f "$CONFIG" ] && . "$CONFIG"; echo "${FACTORY_SERVER_MODE:-prod}" ) )"
DB="${MASTRA_DB_PATH:-$STATE/mastra.db}"
if [ "$MODE" != dev ] && [ -f "$DB" ] && ! compgen -G "$STATE/backup-*-before-prod-mode.db" >/dev/null; then
  BACKUP="$STATE/backup-$(date +%F)-before-prod-mode.db"
  log "first production start: backing up $DB to $BACKUP"
  sqlite3 "$DB" ".backup '$BACKUP'" && [ "$(sqlite3 "$BACKUP" 'pragma quick_check;')" = ok ] \
    || { rm -f "$BACKUP"; discard "$NAME"; log "database backup failed: nothing changed, still on $(active_release)"; exit 1; }
fi

log "server mode: $MODE"
PREVIOUS="$(active_release)"
activate "$NAME"
log "done: $(git -C "$CURRENT" log -1 --format='%h %s')"

# Keep the new release and the one that ran before it (--rollback goes there, even after a rollback
# left a newer, bad release behind), plus the newest others up to $KEEP; the rest go.
for name in $(list_releases | grep -vxF -e "$NAME" -e "$PREVIOUS" | awk -v keep="$((KEEP - 2))" '{ r[NR] = $0 } END { for (i = 1; i <= NR - keep; i++) print r[i] }'); do
  log "removing old release $name"
  discard "$name"
done
