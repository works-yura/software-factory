#!/bin/bash
# Installs (or updates) the Factory server LaunchAgent on this Mac.
#   scripts/mac-mini/install.sh https://factory.tail5c61c7.ts.net
# Copies start-server.sh into ~/.mastracode/factory-v4/, writes server.env, renders the plist into
# ~/Library/LaunchAgents/ and (re)loads it. Rerun after changing start-server.sh or the plist.
set -euo pipefail

PUBLIC_URL="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
STATE="$HOME/.mastracode/factory-v4"
LABEL="ai.eclipt.factory"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$STATE" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
install -m 0755 "$HERE/start-server.sh" "$STATE/start-server.sh"

if [ -n "$PUBLIC_URL" ] || [ ! -f "$STATE/server.env" ]; then
  : "${PUBLIC_URL:?usage: $0 <public url, e.g. https://factory.tail5c61c7.ts.net>}"
  cat > "$STATE/server.env" <<CONF
# Read by start-server.sh. Rerun install.sh with a new URL, or edit and restart the agent.
FACTORY_REPO="$REPO"
MASTRACODE_PUBLIC_URL="$PUBLIC_URL"
PORT=5874
CONF
fi

sed "s|__HOME__|$HOME|g" "$HERE/$LABEL.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

# bootout returns before the old job is gone, and bootstrap fails (error 5) while it is still there.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
for _ in {1..30}; do launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
launchctl bootstrap "gui/$UID" "$PLIST"
echo "Installed $LABEL. Log: ~/Library/Logs/factory.log"
