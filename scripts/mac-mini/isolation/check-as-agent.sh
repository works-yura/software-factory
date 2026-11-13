#!/bin/bash
# Tries, as the agent user, to reach what it must not, and what it must. Run it as that user,
# fed on stdin (the agent cannot read this file: it sits in the closed Project folder):
#
#   sudo -u factory bash -s < scripts/mac-mini/isolation/check-as-agent.sh
#
# Each line: OK (as intended) or LEAK / BROKEN, then what was tried. Changes nothing; it only
# reads, lists and, in its own sandboxes check, creates and removes one empty file.
set -u
OWNER_HOME="/Users/yura"
DOT="/Volumes/dot"
SANDBOXES="$DOT/Project/factory/sandboxes"
leaks=0

# must_fail <what> <command...>: the agent must not be able to do this.
must_fail() {
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "LEAK    $what"
    leaks=$((leaks + 1))
  else
    echo "OK      $what: denied"
  fi
}
# must_work <what> <command...>: the agent needs this.
must_work() {
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "OK      $what: works"
  else
    echo "BROKEN  $what"
  fi
}

echo "as $(id -un) (uid $(id -u))"
[ "$(id -un)" = yura ] && { echo "run it as the agent user: sudo -u factory bash -s < $0"; exit 2; }

echo; echo "== The disk"
must_fail "list $DOT" ls "$DOT"
must_fail "list $DOT/Project" ls "$DOT/Project"
must_fail "list $DOT/Project/factory" ls "$DOT/Project/factory"
must_fail "list Documents on the disk" ls "$DOT/Documents"
must_fail "list the projects (Project/eclipt-ai)" ls "$DOT/Project/eclipt-ai"
must_fail "read the server's secrets (v4 .env)" cat "$DOT/Project/eclipt-ai/lab/factory/v4/apps/server/.env"
must_fail "list the running server's code (releases)" ls "$DOT/Project/factory/releases"
must_fail "read the running server through current/" ls "$DOT/Project/factory/current/"
must_fail "write to the pnpm store under Project" touch "$DOT/Project/.pnpm-store/.agent-probe"
must_fail "write to the pnpm store at the disk root" touch "$DOT/.pnpm-store/.agent-probe"
must_fail "a folder made in Project later (zz-isolation-probe)" cat "$DOT/Project/zz-isolation-probe/probe.txt"
must_fail "rename a folder in Project" mv "$DOT/Project/eclipt-ai" "$DOT/Project/eclipt-ai.x"

echo; echo "== The owner's home ($OWNER_HOME)"
must_fail "list Documents" ls "$OWNER_HOME/Documents"
must_fail "list Desktop" ls "$OWNER_HOME/Desktop"
must_fail "list .ssh" ls "$OWNER_HOME/.ssh"
must_fail "read the Factory database" cat "$OWNER_HOME/.mastracode/factory-v4/mastra.db"
must_fail "read server.env" cat "$OWNER_HOME/.mastracode/factory-v4/server.env"
must_fail "read the Claude login" cat "$OWNER_HOME/.claude/.credentials.json"
must_fail "read the Codex login" cat "$OWNER_HOME/.codex/auth.json"
must_fail "read the gh login" cat "$OWNER_HOME/.config/gh/hosts.yml"
must_fail "list Chrome's profile" ls "$OWNER_HOME/Library/Application Support/Google/Chrome"
must_fail "list the home itself" ls "$OWNER_HOME"

echo; echo "== What agents need"
must_work "reach $SANDBOXES" test -d "$SANDBOXES"
must_work "use Xcode" xcode-select -p
if touch "$SANDBOXES/.agent-probe" 2>/dev/null; then
  rm -f "$SANDBOXES/.agent-probe"
  echo "OK      write in sandboxes: works"
else
  echo "LATER   write in sandboxes: denied (expected until step 3 gives the agent its card folders)"
fi

echo
if [ "$leaks" = 0 ]; then echo "no leaks"; else echo "$leaks LEAK(s): the agent reached what it must not"; fi
