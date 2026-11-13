#!/bin/bash
# Deploys a commit of this repository to the Mac mini's Factory server.
#   scripts/mac-mini/deploy.sh            # the current HEAD
#   scripts/mac-mini/deploy.sh <ref>      # any commit, e.g. the previous one to roll back
#   scripts/mac-mini/deploy.sh --status   # what runs now
#
# The server never runs from the working tree people and agents edit: a dev server there reloads
# on every saved file, half-written code included. It runs from one of two git worktrees under
# ../v4-runtime/ next to this repository (slots a and b; same volume as the pnpm store, so
# installs hard-link instead of copying), through the `current` symlink:
#   1. the inactive slot is checked out at the commit (detached), installed and built: the UI and
#      the server's production build (apps/server/.mastra/output, which `start:local` runs);
#   2. only if that all succeeded, `current` flips to it, the slot's start-server.sh replaces the
#      installed one and the LaunchAgent restarts;
#   3. a failure leaves `current` and the running server untouched.
# Rolling back = deploying the previous commit (or flipping `current` back by hand).
#
# The server runs the production build unless server.env says FACTORY_SERVER_MODE=dev. Before the
# first production start the database is backed up once (sqlite .backup, next to it).
#
# Secrets stay in one place: each slot's apps/server/.env links to the working tree's.
# Runbook: docs/runbooks/dev-server.md › "Mac mini".
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RUNTIME="${FACTORY_RUNTIME:-$(dirname "$REPO")/v4-runtime}"
CURRENT="$RUNTIME/current"
LABEL="ai.eclipt.factory"
STATE="$HOME/.mastracode/factory-v4"

log() { echo "[deploy $(date '+%F %T')] $*"; }

active_slot() { [ -L "$CURRENT" ] && basename "$(readlink "$CURRENT")" || echo none; }

if [ "${1:-}" = "--status" ]; then
  slot="$(active_slot)"
  echo "active slot: $slot"
  [ "$slot" != none ] && git -C "$CURRENT" log -1 --format='commit: %h %s (%cr)'
  grep -hE 'starting (dev|start):local' "$HOME/Library/Logs/factory.log" 2>/dev/null | tail -1 | sed 's/^/last start: /'
  exit 0
fi

REF="${1:-HEAD}"
SHA="$(git -C "$REPO" rev-parse --verify "${REF}^{commit}")"
[ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ] && [ "$REF" = HEAD ] \
  && log "note: the working tree has uncommitted changes; only commit ${SHA:0:8} is deployed"

mkdir -p "$RUNTIME"
case "$(active_slot)" in a) SLOT=b ;; *) SLOT=a ;; esac
DIR="$RUNTIME/$SLOT"
log "deploying ${SHA:0:8} into slot $SLOT"

if [ -d "$DIR/.git" ] || [ -f "$DIR/.git" ]; then
  git -C "$DIR" checkout --quiet --force --detach "$SHA"
  git -C "$DIR" clean -fdq -e node_modules -e .mastra
else
  git -C "$REPO" worktree add --detach "$DIR" "$SHA" >/dev/null
fi

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
) || { log "install or build failed in slot $SLOT: nothing changed, still on $(active_slot)"; exit 1; }

# The mode the server will start in (start-server.sh reads the same file).
MODE="$( ( [ -f "$STATE/server.env" ] && . "$STATE/server.env"; echo "${FACTORY_SERVER_MODE:-prod}" ) )"
DB="${MASTRA_DB_PATH:-$STATE/mastra.db}"
if [ "$MODE" != dev ] && [ -f "$DB" ] && ! compgen -G "$STATE/backup-*-before-prod-mode.db" >/dev/null; then
  BACKUP="$STATE/backup-$(date +%F)-before-prod-mode.db"
  log "first production start: backing up $DB to $BACKUP"
  sqlite3 "$DB" ".backup '$BACKUP'" && [ "$(sqlite3 "$BACKUP" 'pragma quick_check;')" = ok ] \
    || { rm -f "$BACKUP"; log "database backup failed: nothing changed, still on $(active_slot)"; exit 1; }
fi

ln -sfn "$DIR" "$CURRENT.next" && mv -fh "$CURRENT.next" "$CURRENT"
# The watchdog ships with the commit: a rollback to an older commit brings its start-server.sh back too.
[ -f "$DIR/scripts/mac-mini/start-server.sh" ] && install -m 0755 "$DIR/scripts/mac-mini/start-server.sh" "$STATE/start-server.sh"
log "slot $SLOT is current (server mode: $MODE); restarting the server"
launchctl kickstart -k "gui/$UID/$LABEL"
log "done: $(git -C "$CURRENT" log -1 --format='%h %s')"
