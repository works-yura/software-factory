#!/bin/bash
# Agent isolation, step 2 (system; parts need sudo): file owners on the data disk, its folders
# closed to other users, and the macOS user agents will run as. Each part runs and rolls back on
# its own, in this order:
#
#   scripts/mac-mini/isolation/2-system.sh                       # status; changes nothing
#   sudo scripts/mac-mini/isolation/2-system.sh ownership-on     # a. the disk respects file owners
#   sudo scripts/mac-mini/isolation/2-system.sh close-dot        # b. top-level folders 700, disk 711
#   sudo scripts/mac-mini/isolation/2-system.sh add-user         # c. create the standard user "factory"
#
# Rollback, in reverse order:
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
#    each top-level folder 700 except factory-sandboxes (where agents will work), and the disk
#    root 711 (others may pass through to factory-sandboxes but not list the disk). Hidden system
#    folders (.Spotlight-V100, .Trashes, ...) are left alone. Needs sudo: the disk root is root's;
#    close-dot makes it the owner's (else 711 would lock the owner out of listing it too) and
#    open-dot gives it back.
#    Agents' folders must stay outside the closed folders: Project/factory/sandboxes may be a
#    symlink to $DOT/factory-sandboxes, but agents get the real path.
# c. A standard (not admin) user, so it cannot sudo. You set its password; it is not used for
#    anything else in this step.
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/common.sh"

KEEP_OPEN="factory-sandboxes"

ownership_state() { diskutil info "$DOT" | awk -F: '/Owners/{gsub(/ /,"",$2); print $2}'; }
user_exists() { id "$AGENT_USER" >/dev/null 2>&1; }

# Top-level entries close-dot changes: everything visible except the agents' folder.
dot_entries() {
  local entry
  for entry in "$DOT"/*; do
    [ "$(basename "$entry")" = "$KEEP_OPEN" ] && continue
    echo "$entry"
  done
}

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
  say "  (left open on purpose: $KEEP_OPEN, $(stat -f '%Sp' "$DOT/$KEEP_OPEN" 2>/dev/null || echo missing))"
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

case "${1:-status}" in
  status) status ;;
  ownership-on) ownership_on ;;
  ownership-off) ownership_off ;;
  close-dot) close_dot ;;
  open-dot) open_dot ;;
  add-user) add_user ;;
  remove-user) remove_user ;;
  *) die "usage: $0 [status|ownership-on|close-dot|add-user|remove-user|open-dot|ownership-off]" ;;
esac
