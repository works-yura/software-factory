#!/bin/bash
# Factory server under launchd, with a health watchdog. Installed by ./install.sh into
# ~/.mastracode/factory-v4/ (outside the project: the project may sit on a volume that mounts
# after login). Runbook: docs/runbooks/dev-server.md › "Mac mini".
#
# The server runs as a production build (`pnpm start:local`: NODE_ENV=production, `mastra start` on
# the .mastra/output that deploy.sh built in the slot), on the same data as the development server
# (`dev:local`). FACTORY_SERVER_MODE=dev in server.env switches back to `dev:local` (bundles on every
# start, watches files); a slot without a build falls back to it too.
#
# Why a watchdog: a hung server never exits, and `mastra dev` outlives a crashed one (it waits for a
# file change), so launchd never sees either. This script polls GET /health and, after HEALTH_FAILS
# failures in a row, stops the whole process group and exits 1; launchd (KeepAlive) starts it again.
#
# Before the server it applies the Tailscale side (see ensure_tailscale): the tailnet service people
# open, and the public webhook paths (Funnel). Both are idempotent, so every start re-applies them
# and a new machine gets them from this script alone.
#
# Settings come from ~/.mastracode/factory-v4/server.env (written by install.sh):
#   FACTORY_REPO, MASTRACODE_PUBLIC_URL, PORT, TS_SERVICE, FUNNEL_ROUTES, FACTORY_SERVER_MODE.

# launchd starts with a bare PATH: take node and corepack from nvm's default, as a login shell
# would. Before `set -u`: nvm.sh reads unset variables.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" --no-use && nvm use --silent default >/dev/null
# The agent CLIs the server spawns: Claude Code installs into ~/.local/bin, Codex comes with nvm's node.
export PATH="$HOME/.local/bin:$PATH:/usr/local/bin:/opt/homebrew/bin"
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
# prod (default): `pnpm start:local`, the build deploy.sh made. dev: `pnpm dev:local`, as before.
FACTORY_SERVER_MODE="${FACTORY_SERVER_MODE:-prod}"

HEALTH_URL="http://127.0.0.1:${PORT}/health"
HEALTH_INTERVAL=20   # seconds between checks
MOUNT_WAIT=300       # seconds to wait for the server's .env (its volume may mount late)

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
# The deployed slot links its .env to the working tree, which may sit on a volume that mounts late.
for (( waited = 0; waited < MOUNT_WAIT; waited += 5 )); do [ -r "$DIR/.env" ] && break; sleep 5; done
cd "$DIR" || { log "no $DIR"; exit 1; }

if [ "$FACTORY_SERVER_MODE" != dev ] && [ ! -f .mastra/output/index.mjs ]; then
  log "no production build in $DIR/.mastra/output (deploy again): falling back to dev:local"
  FACTORY_SERVER_MODE=dev
fi
if [ "$FACTORY_SERVER_MODE" = dev ]; then
  SCRIPT=dev:local
  HEALTH_FAILS=6       # failures in a row before a restart: 2 minutes, longer than a dev rebuild
  STARTUP_LIMIT=900    # seconds the first start may take (bundling) before it counts as stuck
else
  SCRIPT=start:local
  HEALTH_FAILS=3       # 1 minute: a production server does not rebuild
  STARTUP_LIMIT=180    # it is healthy within seconds; minutes mean it is stuck
fi
log "starting $SCRIPT"

# Own process group (job control), so a restart stops pnpm, varlock, mastra and the server together.
set -m
corepack pnpm "$SCRIPT" &
CHILD=$!
set +m

# Every process under the child. varlock starts its command in a process group of its own, so the
# group kill alone would leave mastra and the server running (and holding the port) after a KILL.
descendants() {
  local pid
  for pid in $(pgrep -P "$1"); do echo "$pid"; descendants "$pid"; done
}
stop_child() {
  local tree
  tree="$(descendants "$CHILD")"
  kill -TERM -- "-$CHILD" 2>/dev/null
  for _ in {1..20}; do
    # shellcheck disable=SC2086
    kill -0 "$CHILD" $tree 2>/dev/null || break
    sleep 1
  done
  kill -KILL -- "-$CHILD" 2>/dev/null
  # shellcheck disable=SC2086
  [ -n "$tree" ] && kill -KILL $tree 2>/dev/null
  return 0
}
restart() { log "$1: restarting"; stop_child; exit 1; }
trap 'log "stopping (signal)"; stop_child; exit 0' TERM INT

healthy() { curl -fs -o /dev/null --max-time 5 "$HEALTH_URL"; }
child_alive() { kill -0 "$CHILD" 2>/dev/null; }

# Startup: dev:local bundles before it listens; start:local only boots.
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
