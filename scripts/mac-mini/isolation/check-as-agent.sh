#!/bin/bash
# Tries, as the agent user, to reach what it must not, and what it must. Run it as that user,
# fed on stdin (the agent cannot read this file: it sits in the closed Project folder):
#
#   (cd / && sudo -u factory bash -s) < scripts/mac-mini/isolation/check-as-agent.sh
#
# (`cd /`: the agent cannot enter the folder you run it from, and bash would warn on every line.)
#
# Each line: OK (as intended) or LEAK / BROKEN, then what was tried. It changes nothing: reads and
# listings are tried for real, writes only asked of the kernel (test -w, the access(2) check that a
# write would face), so a hole is reported, never used. (An earlier version really renamed a folder.)
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
[ "$(id -un)" = yura ] && { echo "run it as the agent user: (cd / && sudo -u factory bash -s) < $0"; exit 2; }

echo; echo "== The disk"
must_fail "list $DOT" ls "$DOT"
must_fail "list $DOT/Project" ls "$DOT/Project"
must_fail "list $DOT/Project/factory" ls "$DOT/Project/factory"
must_fail "list Documents on the disk" ls "$DOT/Documents"
must_fail "list the projects (Project/eclipt-ai)" ls "$DOT/Project/eclipt-ai"
must_fail "read the server's secrets (v4 .env)" cat "$DOT/Project/eclipt-ai/lab/factory/v4/apps/server/.env"
must_fail "list the running server's code (releases)" ls "$DOT/Project/factory/releases"
must_fail "read the running server through current/" ls "$DOT/Project/factory/current/"
must_fail "write to the pnpm store under Project" test -w "$DOT/Project/.pnpm-store"
must_fail "write to the pnpm store at the disk root" test -w "$DOT/.pnpm-store"
must_fail "rename or add a folder in Project" test -w "$DOT/Project"
must_fail "change the running server's code" test -w "$DOT/Project/factory/releases"
must_fail "write to the disk root" test -w "$DOT"

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
if test -w "$SANDBOXES"; then
  echo "OK      write in sandboxes: works"
else
  echo "LATER   write in sandboxes: denied (expected until step 3 gives the agent its card folders)"
fi

echo
if [ "$leaks" = 0 ]; then echo "no leaks"; else echo "$leaks LEAK(s): the agent reached what it must not"; fi
