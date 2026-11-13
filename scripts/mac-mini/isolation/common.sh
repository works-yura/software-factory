# Shared by the agent-isolation step scripts (sourced, not run). README.md next to it explains the plan.
set -euo pipefail

# The person the Factory server runs as. Under sudo that is still them, not root.
OWNER="${SUDO_USER:-$USER}"
OWNER_HOME="$(dscl . -read "/Users/$OWNER" NFSHomeDirectory | awk '{print $2}')"
# The macOS user agents will run as.
AGENT_USER="factory"
# The data disk: projects, the server's code, the agents' folders.
DOT="/Volumes/dot"
# Where apply records what it changed, so rollback can put it back.
STATE="$OWNER_HOME/.mastracode/isolation"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

need_root() { [ "$(id -u)" = 0 ] || die "run this one with sudo: sudo $0 $*"; }
not_root()  { [ "$(id -u)" != 0 ] || die "run this one without sudo (as $OWNER)"; }

ensure_state_dir() {
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  [ "$(id -u)" != 0 ] || chown "$OWNER" "$STATE"
}

# save_modes <name>: reads paths (one per line) on stdin and records each one's mode as
# "<octal mode> <path>". Only the first apply saves: running apply twice keeps the original modes,
# so rollback always returns to what was there before.
save_modes() {
  local file="$STATE/$1.modes"
  if [ -f "$file" ]; then
    cat >/dev/null
    say "  modes already saved in $file (kept, so rollback returns to the original state)"
    return
  fi
  ensure_state_dir
  local path
  while IFS= read -r path; do
    [ -e "$path" ] && stat -f '%Lp %N' "$path"
  done > "$file"
  [ "$(id -u)" != 0 ] || chown "$OWNER" "$file"
  say "  saved $(wc -l < "$file" | tr -d ' ') original modes to $file"
}

# restore_modes <name>: puts back what save_modes recorded, then archives the record.
restore_modes() {
  local file="$STATE/$1.modes" line mode path
  [ -f "$file" ] || die "nothing to roll back: $file does not exist (apply was not run, or was already rolled back)"
  while IFS= read -r line; do
    mode="${line%% *}"
    path="${line#* }"
    if [ -e "$path" ]; then
      chmod "$mode" "$path"
    fi
  done < "$file"
  mv "$file" "$file.rolled-back-$(date +%Y%m%d-%H%M%S)"
  say "  restored the modes from $file"
}

# Lists what in the given paths a user other than the owner can read or enter.
open_to_others() {
  find "$@" -perm +044 2>/dev/null || true
}
