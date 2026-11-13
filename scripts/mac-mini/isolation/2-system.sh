#!/bin/bash
# Agent isolation, step 2 (system; parts need sudo): file owners on the data disk, its folders
# closed to other users, and the macOS user agents will run as. Each part runs and rolls back on
# its own, in this order:
#
#   scripts/mac-mini/isolation/2-system.sh                       # status; changes nothing
#   sudo scripts/mac-mini/isolation/2-system.sh ownership-on     # a. the disk respects file owners
#   sudo scripts/mac-mini/isolation/2-system.sh close-dot        # b. top-level folders 700, disk 711
#   sudo scripts/mac-mini/isolation/2-system.sh add-user         # c. create the standard user "factory"
#   sudo scripts/mac-mini/isolation/2-system.sh agent-path       # d. let "factory" through to sandboxes only
#
# Rollback, in reverse order:
#   sudo scripts/mac-mini/isolation/2-system.sh close-agent-path # "factory" stopped at the disk again
#   sudo scripts/mac-mini/isolation/2-system.sh remove-user      # deletes "factory" AND /Users/factory
#   sudo scripts/mac-mini/isolation/2-system.sh open-dot         # original modes back
#   sudo scripts/mac-mini/isolation/2-system.sh ownership-off     # disk ignores owners again
#
# a. /Volumes/dot has "Owners: Disabled": macOS shows every file there as the logged-in user's and
#    lets any local user read and write all of it. ownership-on makes the disk honour the owner
#    each file has on it. Files written elsewhere may turn out to belong to another uid: status
#    (run as you, after ownership-on) lists them so you can `sudo chown -R <you> <path>` them.
#    The disk root itself belongs to root; that is expected.
# b. Owners alone do not close anything: most folders are 755 (anyone may read). close-dot makes
#    each top-level folder 700 and the disk root 711 (others may pass through but not list it).
#    Hidden system folders (.Spotlight-V100, .Trashes, ...) are left alone. Needs sudo: the disk
#    root is root's; close-dot makes it the owner's (else 711 would lock the owner out of listing
#    it too) and open-dot gives it back.
# c. A standard (not admin) user, so it cannot sudo. You set its password; it is not used for
#    anything else in this step.
# d. Agents work in $AGENT_ROOT, which sits inside the closed Project folder. agent-path lets
#    "factory" pass through each folder on the way (Project, Project/factory) without listing it
#    (ACL "allow search"; the folders stay 700), closes every other entry in those folders (go-rwx:
#    else a 755 neighbour such as Project/eclipt-ai, the server's code, would be readable by name),
#    and adds an inheritable deny for "factory" to both folders, so a folder created there later
#    is closed to it even with the default 755. Rollback removes both ACL entries and puts the
#    modes back; the deny that new folders already inherited stays (it only ever denies "factory").
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/common.sh"

# Where agents work: the only place "factory" may reach on the disk.
AGENT_ROOT="$DOT/Project/factory/sandboxes"
ACL_PASS="user:$AGENT_USER allow search"
ACL_DENY_NEW="user:$AGENT_USER deny list,search,add_file,add_subdirectory,delete_child,read,write,append,execute,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity,chown,delete,file_inherit,directory_inherit,only_inherit"

ownership_state() { diskutil info "$DOT" | awk -F: '/Owners/{gsub(/ /,"",$2); print $2}'; }
user_exists() { id "$AGENT_USER" >/dev/null 2>&1; }

# Top-level entries close-dot changes: everything visible.
dot_entries() {
  local entry
  for entry in "$DOT"/*; do
    echo "$entry"
  done
}

# Folders between the disk and AGENT_ROOT, outermost first (Project, Project/factory).
path_dirs() {
  local dir="$(dirname "$AGENT_ROOT")" list=""
  while [ "$dir" != "$DOT" ] && [ "$dir" != / ]; do
    list="$dir
$list"
    dir="$(dirname "$dir")"
  done
  printf '%s' "$list"
}

# Entries of the path folders other than the next step towards AGENT_ROOT, hidden ones included.
path_neighbours() {
  local dir entry
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    for entry in "$dir"/* "$dir"/.[!.]*; do
      # Symlinks are skipped: their own mode means nothing, and chmod would change the target.
      [ -e "$entry" ] && [ ! -L "$entry" ] || continue
      case "$AGENT_ROOT/" in "$entry"/*) continue ;; esac
      echo "$entry"
    done
  done < <(path_dirs)
}

has_acl() { ls -led "$2" 2>/dev/null | grep -qF "$1"; }

status() {
  step "a. File owners on $DOT"
  say "  Owners: $(ownership_state)   (Disabled = any local user can read and write everything there)"
  if [ "$(id -u)" = 0 ]; then
    say "  (owners are checked only without sudo: root still sees an old view; run $0 status)"
  elif [ "$(ownership_state)" = Enabled ]; then
    # Three levels deep: the whole disk (node_modules, pnpm store, builds) takes far too long.
    local foreign
    foreign="$(find "$DOT" -xdev -mindepth 1 -maxdepth 3 ! -user "$OWNER" -not -path "$DOT/.*" 2>/dev/null | head -30 || true)"
    if [ -z "$foreign" ]; then
      say "  everything three levels deep is $OWNER's (the disk root is root's, as it should be)"
    else
      say "  not $OWNER's (first 30; take back with: sudo chown -R $OWNER <path>):"
      printf '%s\n' "$foreign" | sed 's/^/    /'
    fi
  fi

  step "b. Top-level of $DOT open to other users"
  say "  $DOT itself: $(stat -f '%Sp %Su' "$DOT")"
  local entry open=0
  while IFS= read -r entry; do
    if [ -n "$(find "$entry" -maxdepth 0 -perm +055 2>/dev/null)" ]; then
      say "  open    $(stat -f '%Sp' "$entry")  $(basename "$entry")"
      open=$((open + 1))
    fi
  done < <(dot_entries)
  [ "$open" = 0 ] && say "  all closed"
  # Hidden folders stay as they are, but none may be writable by others: the pnpm store
  # (.pnpm-store) is hard-linked into the server's releases, so writing to it changes the server.
  local writable
  writable="$(find "$DOT" -mindepth 1 -maxdepth 2 -name '.*' -perm +022 \
    -not -path "$DOT/.Trashes*" -not -path "$DOT/.TemporaryItems*" 2>/dev/null || true)"
  if [ -n "$writable" ]; then
    say "  writable by others (hidden):"
    printf '%s\n' "$writable" | sed 's/^/    /'
  fi
  [ "$(ownership_state)" = Disabled ] && say "  note: while Owners is Disabled these modes protect nothing"

  step "c. User $AGENT_USER"
  if user_exists; then
    say "  exists: $(id "$AGENT_USER")"
    dseditgroup -o checkmember -m "$AGENT_USER" admin >/dev/null 2>&1 && say "  WARNING: $AGENT_USER is an admin; it must be a standard user"
  else
    say "  does not exist"
  fi

  step "d. Path for $AGENT_USER to $AGENT_ROOT"
  if [ ! -d "$AGENT_ROOT" ] || [ -L "$AGENT_ROOT" ]; then
    say "  WARNING: $AGENT_ROOT is missing or a symlink; agents need it as a real folder"
  fi
  local dir
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    if has_acl "allow search" "$dir"; then
      say "  pass-through    $(stat -f '%Sp' "$dir")  $dir"
    else
      say "  closed          $(stat -f '%Sp' "$dir")  $dir"
    fi
  done < <(path_dirs)
  local neighbours
  neighbours="$(path_neighbours | while IFS= read -r entry; do find "$entry" -maxdepth 0 -perm +005 2>/dev/null; done || true)"
  if [ -n "$neighbours" ]; then
    say "  open to others next to the path (a pass-through would expose them):"
    printf '%s\n' "$neighbours" | sed 's/^/    /'
  fi
  return 0
}

ownership_on() {
  need_root ownership-on
  step "Enabling owners on $DOT"
  diskutil enableOwnership "$DOT"
  # No owner scan here: right after enabling, a scan run as root still sees the old view (every
  # file as root's). status, run as you, shows the real owners.
  say "  Now check the real owners, without sudo: $0 status"
}

ownership_off() {
  need_root ownership-off
  step "Disabling owners on $DOT"
  diskutil disableOwnership "$DOT"
}

close_dot() {
  need_root close-dot
  [ "$(ownership_state)" = Enabled ] || die "owners are disabled on $DOT; run sudo $0 ownership-on first (without it these modes protect nothing)"
  step "Saving the current modes"
  { echo "$DOT"; dot_entries; } | save_modes 2-dot
  # The disk root belongs to root; 711 would keep its owner out too (no listing, no Finder).
  # Make it the owner's, and remember who had it so open-dot can give it back.
  [ -f "$STATE/2-dot.owner" ] || { stat -f '%u:%g' "$DOT" > "$STATE/2-dot.owner"; chown "$OWNER" "$STATE/2-dot.owner"; }
  step "Closing"
  chown "$OWNER" "$DOT"
  chmod 711 "$DOT"
  local entry
  while IFS= read -r entry; do
    chmod go-rwx "$entry"
  done < <(dot_entries)
  say "  done"
  status
}

open_dot() {
  need_root open-dot
  step "Restoring the modes from before close-dot"
  restore_modes 2-dot
  if [ -f "$STATE/2-dot.owner" ]; then
    chown "$(cat "$STATE/2-dot.owner")" "$DOT"
    mv "$STATE/2-dot.owner" "$STATE/2-dot.owner.rolled-back-$(date +%Y%m%d-%H%M%S)"
    say "  disk root owner restored"
  fi
  status
}

add_user() {
  need_root add-user
  user_exists && die "$AGENT_USER already exists"
  step "Creating standard user $AGENT_USER (you will be asked for its new password)"
  sysadminctl -addUser "$AGENT_USER" -fullName "Factory agents" -home "/Users/$AGENT_USER" -password -
  createhomedir -c -u "$AGENT_USER" >/dev/null
  status
}

remove_user() {
  need_root remove-user
  user_exists || die "$AGENT_USER does not exist"
  say "This deletes the user $AGENT_USER and everything in /Users/$AGENT_USER (its simulators, caches, Chrome)."
  printf 'Type %s to continue: ' "$AGENT_USER"
  read -r answer
  [ "$answer" = "$AGENT_USER" ] || die "cancelled"
  sysadminctl -deleteUser "$AGENT_USER"
  status
}

agent_path() {
  need_root agent-path
  user_exists || die "$AGENT_USER does not exist; run sudo $0 add-user first"
  [ -d "$AGENT_ROOT" ] && [ ! -L "$AGENT_ROOT" ] || die "$AGENT_ROOT must be a real folder"
  [ "$(stat -f '%Lp' "$DOT")" = 711 ] || die "run sudo $0 close-dot first"
  step "Saving the current modes"
  path_neighbours | save_modes 2-agent-path
  path_dirs | save_modes 2-agent-path-dirs
  step "Closing the neighbours"
  local entry dir
  while IFS= read -r entry; do
    chmod go-rwx "$entry"
  done < <(path_neighbours)
  step "Letting $AGENT_USER through"
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    # 700: only the ACL lets others in, and only to pass through, not to list.
    chmod 700 "$dir"
    has_acl "allow search" "$dir" || chmod +a "$ACL_PASS" "$dir"
    has_acl "only_inherit" "$dir" || chmod +a "$ACL_DENY_NEW" "$dir"
    say "  $dir"
  done < <(path_dirs)
  status
}

close_agent_path() {
  need_root close-agent-path
  step "Removing the pass-through"
  local dir
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    chmod -a "$ACL_PASS" "$dir" 2>/dev/null || true
    chmod -a "$ACL_DENY_NEW" "$dir" 2>/dev/null || true
    say "  $dir"
  done < <(path_dirs)
  step "Restoring the neighbours' modes"
  restore_modes 2-agent-path
  [ -f "$STATE/2-agent-path-dirs.modes" ] && restore_modes 2-agent-path-dirs
  status
}

case "${1:-status}" in
  status) status ;;
  ownership-on) ownership_on ;;
  ownership-off) ownership_off ;;
  close-dot) close_dot ;;
  open-dot) open_dot ;;
  add-user) add_user ;;
  remove-user) remove_user ;;
  agent-path) agent_path ;;
  close-agent-path) close_agent_path ;;
  *) die "usage: $0 [status|ownership-on|close-dot|add-user|agent-path|close-agent-path|remove-user|open-dot|ownership-off]" ;;
esac
