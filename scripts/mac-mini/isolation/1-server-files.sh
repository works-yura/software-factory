#!/bin/bash
# Agent isolation, step 1 (no sudo): the Factory server's own files are its owner's alone.
#   scripts/mac-mini/isolation/1-server-files.sh            # status: what is open now; changes nothing
#   scripts/mac-mini/isolation/1-server-files.sh apply      # close them
#   scripts/mac-mini/isolation/1-server-files.sh rollback   # put the original modes back
#
# What apply changes: removes the group and others bits (chmod go-rwx) from everything in
# ~/.mastracode/factory-v4 (database, server.env, backups, attachments, device state) and from
# ~/.docker/config.json. The server runs as their owner, so it keeps full access; no restart.
# ~/.mastracode is already 700, so this is a second layer: it stays closed even if that folder opens.
#
# The other half of step 1 is in code, not here: the server binds 127.0.0.1 only
# (MASTRA_HOST in apps/server/package.json), live after scripts/mac-mini/deploy.sh. status shows it.
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/common.sh"

SERVER_DIR="$OWNER_HOME/.mastracode/factory-v4"
DOCKER_CONFIG="$OWNER_HOME/.docker/config.json"
NAME="1-server-files"

targets() {
  find "$SERVER_DIR" 2>/dev/null
  [ -e "$DOCKER_CONFIG" ] && echo "$DOCKER_CONFIG"
}

status() {
  step "Server files readable by other users"
  local open
  open="$(open_to_others "$SERVER_DIR" "$DOCKER_CONFIG")"
  if [ -z "$open" ]; then
    say "  none"
  else
    say "$(printf '%s\n' "$open" | wc -l | tr -d ' ') paths, e.g.:"
    printf '%s\n' "$open" | sed -n '1,10s/^/  /p'
    # Files the server or deploy.sh create later get the default 644; a closed folder still hides them.
    [ "$(stat -f '%Lp' "$SERVER_DIR")" = 700 ] \
      && say "  (they sit in $SERVER_DIR, which is 700: unreachable anyway; apply again to close them too)"
  fi
  say "  ~/.mastracode itself: $(stat -f '%Sp' "$OWNER_HOME/.mastracode") (drwx------ = nobody else gets in at all)"

  step "Where the server listens (port ${PORT:-5874})"
  local listen
  listen="$(lsof -nP -iTCP:"${PORT:-5874}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sort -u)"
  if [ -z "$listen" ]; then
    say "  not running"
  elif printf '%s\n' "$listen" | grep -qv '^127\.0\.0\.1:\|^\[::1\]:'; then
    say "  $listen  <- every network interface: the LAN reaches it directly. Deploy a commit with MASTRA_HOST=127.0.0.1."
  else
    say "  $listen  (this Mac only; Tailscale serve/Funnel proxy to it)"
  fi

  [ -f "$STATE/$NAME.modes" ] && say "" && say "apply was run; rollback can restore from $STATE/$NAME.modes"
  return 0
}

apply() {
  not_root
  step "Saving the current modes"
  targets | save_modes "$NAME"
  step "chmod go-rwx"
  chmod -R go-rwx "$SERVER_DIR"
  [ -e "$DOCKER_CONFIG" ] && chmod go-rwx "$DOCKER_CONFIG"
  say "  done"
  status
}

rollback() {
  not_root
  step "Restoring the modes from before apply"
  restore_modes "$NAME"
  status
}

case "${1:-status}" in
  status) status ;;
  apply) apply ;;
  rollback) rollback ;;
  *) die "usage: $0 [status|apply|rollback]" ;;
esac
