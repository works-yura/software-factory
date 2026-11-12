#!/bin/bash
# Factory server under launchd, with a health watchdog. Installed by ./install.sh into
# ~/.mastracode/factory-v4/ (outside the project: the project may sit on a volume that mounts
# after login). Runbook: docs/runbooks/dev-server.md › "Mac mini".
#
# Why a watchdog: `mastra dev` outlives a crashed server (it waits for a file change), so launchd
# never sees the crash. This script polls GET /health and, after HEALTH_FAILS failures in a row,
# stops the whole process group and exits 1; launchd (KeepAlive) starts it again.
#
# Before the server it applies the Tailscale side (see ensure_tailscale): the tailnet service people
# open, and the public webhook paths (Funnel). Both are idempotent, so every start re-applies them
# and a new machine gets them from this script alone.
#
# Settings come from ~/.mastracode/factory-v4/server.env (written by install.sh):
#   FACTORY_REPO, MASTRACODE_PUBLIC_URL, PORT, TS_SERVICE, FUNNEL_ROUTES.

# launchd starts with a bare PATH: take node and corepack from nvm's default, as a login shell
# would. Before `set -u`: nvm.sh reads unset variables.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" --no-use && nvm use --silent default >/dev/null
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
set -u

CONFIG="${HOME}/.mastracode/factory-v4/server.env"
# shellcheck source=/dev/null
[ -f "$CONFIG" ] && . "$CONFIG"
: "${FACTORY_REPO:?set FACTORY_REPO in $CONFIG}"
: "${MASTRACODE_PUBLIC_URL:?set MASTRACODE_PUBLIC_URL in $CONFIG}"
PORT="${PORT:-5874}"
export MASTRACODE_PUBLIC_URL PORT
# Tailnet-only service people open (https://<name>.<tailnet>.ts.net). Empty: none.
TS_SERVICE="${TS_SERVICE:-}"
# Public webhook paths on this machine's name, "<public path>=<server path>" separated by spaces.
# Only these paths are reachable from the internet; everything else answers 404.
FUNNEL_ROUTES="${FUNNEL_ROUTES:-}"

HEALTH_URL="http://127.0.0.1:${PORT}/health"
HEALTH_INTERVAL=20   # seconds between checks
HEALTH_FAILS=6       # failures in a row before a restart: 2 minutes, longer than a dev rebuild
STARTUP_LIMIT=900    # seconds the first start may take before it counts as stuck
MOUNT_WAIT=300       # seconds to wait for the project's volume

log() { echo "[watchdog $(date '+%F %T')] $*"; }

command -v corepack >/dev/null || { log "corepack not found on PATH"; exit 1; }

# Runs a command with a time limit: a Tailscale call that waits for an admin approval must not
# hold the server's start.
with_timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }

# The Tailscale side, re-applied on every start. Failures are logged, never fatal: the server
# still runs on 127.0.0.1 and in the tailnet.
ensure_tailscale() {
  command -v tailscale >/dev/null || { log "tailscale CLI not found: skipping service and Funnel"; return; }
  for (( waited = 0; waited < 60; waited += 5 )); do
    tailscale status >/dev/null 2>&1 && break
    sleep 5
  done
  local target="http://127.0.0.1:${PORT}"
  if [ -n "$TS_SERVICE" ]; then
    with_timeout 20 tailscale serve --bg --service="$TS_SERVICE" --https=443 "$target" >/dev/null 2>&1 \
      && log "tailscale service $TS_SERVICE -> $target" \
      || log "tailscale service $TS_SERVICE: not applied (approval pending or Tailscale down)"
  fi
  local route path server_path
  for route in $FUNNEL_ROUTES; do
    path="${route%%=*}" server_path="${route#*=}"
    with_timeout 20 tailscale funnel --bg --yes --https=443 --set-path="$path" "${target}${server_path}" >/dev/null 2>&1 \
      && log "funnel $path -> ${target}${server_path}" \
      || log "funnel $path: not applied (Funnel not allowed for this machine?)"
  done
}
ensure_tailscale

DIR="$FACTORY_REPO/apps/server"
for (( waited = 0; waited < MOUNT_WAIT; waited += 5 )); do [ -d "$DIR" ] && break; sleep 5; done
cd "$DIR" || { log "no $DIR"; exit 1; }

# Own process group (job control), so a restart stops pnpm, varlock, mastra dev and the server together.
set -m
corepack pnpm dev:local &
CHILD=$!
set +m

stop_child() {
  kill -TERM -- "-$CHILD" 2>/dev/null
  for _ in {1..20}; do kill -0 "$CHILD" 2>/dev/null || return 0; sleep 1; done
  kill -KILL -- "-$CHILD" 2>/dev/null
}
restart() { log "$1: restarting"; stop_child; exit 1; }
trap 'log "stopping (signal)"; stop_child; exit 0' TERM INT

healthy() { curl -fs -o /dev/null --max-time 5 "$HEALTH_URL"; }
child_alive() { kill -0 "$CHILD" 2>/dev/null; }

# Startup: the server builds before it listens.
started=$SECONDS
until healthy; do
  child_alive || { wait "$CHILD"; log "server exited during start ($?)"; exit 1; }
  (( SECONDS - started < STARTUP_LIMIT )) || restart "not healthy ${STARTUP_LIMIT}s after start"
  sleep 5
done
log "healthy after $(( SECONDS - started ))s"

fails=0
while child_alive; do
  sleep "$HEALTH_INTERVAL" & wait $!   # interruptible by the TERM trap
  if healthy; then
    (( fails > 0 )) && log "healthy again after $fails failed checks"
    fails=0
  else
    (( fails += 1 ))
    log "health check failed ($fails/$HEALTH_FAILS)"
    (( fails < HEALTH_FAILS )) || restart "server not answering"
  fi
done
wait "$CHILD"
log "server exited ($?)"
exit 1
