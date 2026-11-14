#!/bin/bash
# Agent isolation, step 2 (system; parts need sudo): file owners on the data disk, its folders
# closed to other users, and the macOS user agents will run as. Each part runs and rolls back on
# its own, in this order:
#
#   scripts/mac-mini/isolation/2-system.sh                       # status; changes nothing
#   sudo scripts/mac-mini/isolation/2-system.sh ownership-on     # a. the disk respects file owners
#   sudo scripts/mac-mini/isolation/2-system.sh fix-owners       # a2. files with no real owner become yours
#   sudo scripts/mac-mini/isolation/2-system.sh close-dot        # b. top-level folders 700, disk 711
#   sudo scripts/mac-mini/isolation/2-system.sh add-user         # c. create the standard user "factory"
#   sudo scripts/mac-mini/isolation/2-system.sh agent-path       # d. let "factory" through to sandboxes only
#   sudo scripts/mac-mini/isolation/2-system.sh agent-group      # e1. shared group + ACLs on sandboxes
#   sudo scripts/mac-mini/isolation/2-system.sh agent-profile    # e2. install the Seatbelt profile
#   sudo scripts/mac-mini/isolation/2-system.sh agent-sudo       # e3. sudoers rule: the server starts agents
#   sudo scripts/mac-mini/isolation/2-system.sh agent-tools      # e4. the agent's own claude and node
#   sudo scripts/mac-mini/isolation/2-system.sh agent-mobile-tools  # e5. the agent's own fvm and Flutter SDKs
#   sudo scripts/mac-mini/isolation/2-system.sh agent-firewall   # e6. the agent cannot reach 5874 / 9222
#   sudo scripts/mac-mini/isolation/2-system.sh host-hardening   # e7. close what linPEAS found open to it
#
# Rollback, in reverse order:
#   sudo scripts/mac-mini/isolation/2-system.sh remove-host-hardening
#   sudo scripts/mac-mini/isolation/2-system.sh remove-agent-firewall
#   sudo scripts/mac-mini/isolation/2-system.sh remove-agent-mobile-tools
#   sudo scripts/mac-mini/isolation/2-system.sh remove-agent-tools
#   sudo scripts/mac-mini/isolation/2-system.sh remove-agent-sudo
#   sudo scripts/mac-mini/isolation/2-system.sh remove-agent-profile
#   sudo scripts/mac-mini/isolation/2-system.sh remove-agent-group
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
# a2. Files written while owners were disabled are stored with the "unknown" owner (uid 99), and
#    HFS+ shows such a file as owned by whoever looks at it: you see it as yours, "factory" sees it
#    as its own and gets the owner's rights, modes notwithstanding. fix-owners stores you as the
#    real owner of everything on the disk (system folders excepted). Nothing changes for you. Run it
#    once after ownership-on; it walks the whole disk (minutes). Not undone by rollback: owning
#    your own files is harmless, and ownership-off makes owners meaningless again anyway.
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
# e. What the server needs to start agents as "factory" (ADR-0041, @factory/agent-user):
#    e1. agent-group: a group with you and "factory" in it, and ACLs on the sandboxes folder (as
#        SandVault does on its shared folder) so both of you read and write what either makes
#        there: folders get the rights and pass them on, files get them without execute. Plus the
#        agent's own temp folder (~factory/.tmp, its TMPDIR).
#    e2. agent-profile: the Seatbelt profile every agent command runs under, generated from the
#        package (bin/print-profile.ts) and installed root-owned in /var/factory, where the agent
#        cannot change it. Rerun after the sandboxes folder moves.
#    e3. agent-sudo: /etc/sudoers.d/50-factory-agent, checked with visudo before it is installed:
#        you may run `env` and `kill` as "factory" without a password (env starts every agent
#        command, kill stops them), and keep fd 3 open across sudo (closefrom_override), where the
#        agent's environment travels. Nothing else, and nothing as root.
#    e4. agent-tools: copies of your `claude` (the same version the server resolves) and of nvm's
#        default Node (with its global packages: npm, codex) into ~factory/.local, owned by the
#        agent: your copies sit in your home, which the agent cannot read. Rerun after updating
#        either, so agents run the same versions.
#    e5. agent-mobile-tools: copies of your fvm and of the Flutter SDKs the projects pin
#        ($AGENT_FLUTTER_VERSIONS, from your fvm cache) into ~factory (fvm in .local/fvm, SDKs in
#        ~/fvm/versions, its fvm config pointing there), owned by the agent: your cache is on the
#        closed disk. CocoaPods comes from Homebrew (/opt/homebrew/bin, readable by everyone).
#        About 2.5 GB per SDK. Rerun after adding a version.
#    e6. agent-firewall: a pf rule that refuses the agent's TCP connections to port 5874 (this
#        server) and 9222 (Chrome's debugger: whoever reaches it drives your browser and its
#        logins), on any address. The Seatbelt profile refuses the same; this keeps it when the
#        profile is off (FACTORY_AGENT_SEATBELT=off, which Xcode and SwiftPM need). Loaded into the
#        anchor com.apple/factory-agent now and by a LaunchDaemon at every boot. The Factory's MCP
#        is reached through its public URL, not these ports.
#    e7. host-hardening: what linPEAS, run as the agent, found open to it outside Factory:
#        AnyDesk's config in /etc/anydesk is root:staff 662, and every local user is in staff, so
#        the agent could rewrite the config of a root service that lets people in (600 now; the
#        service runs as root and still reads it). The LaunchDaemon com.network_analyzer.bpf makes
#        /dev/bpf* readable by everyone at boot, which lets any user capture the traffic; your
#        own access comes from Wireshark's ChmodBPF (group access_bpf) and stays. The old modes
#        and the daemon's plist are kept in /var/factory/host-hardening for the rollback.
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/common.sh"
REPO="$(cd "$HERE/../../.." && pwd)"

# Where agents work: the only place "factory" may reach on the disk.
AGENT_ROOT="$DOT/Project/factory/sandboxes"
ACL_PASS="user:$AGENT_USER allow search"
ACL_DENY_NEW="user:$AGENT_USER deny list,search,add_file,add_subdirectory,delete_child,read,write,append,execute,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity,chown,delete,file_inherit,directory_inherit,only_inherit"

AGENT_GROUP="factory-agents"
PROFILE_DIR="/var/factory"
PROFILE="$PROFILE_DIR/agent-$AGENT_USER.sb"
SUDOERS="/etc/sudoers.d/50-factory-agent"
AGENT_FLUTTER_VERSIONS="${AGENT_FLUTTER_VERSIONS:-3.44.1 3.41.8 3.38.7}"
FIREWALL_ANCHOR="com.apple/factory-agent"
FIREWALL_RULES="$PROFILE_DIR/agent-firewall.pf"
FIREWALL_DAEMON="/Library/LaunchDaemons/ai.eclipt.factory-agent-firewall.plist"
FIREWALL_PORTS="5874 9222"
HARDENING_DIR="$PROFILE_DIR/host-hardening"
ANYDESK_FILES="/private/etc/anydesk/system.conf /private/etc/anydesk/service.conf /private/etc/anydesk/system.conf.lock /private/etc/anydesk/service.conf.lock"
BPF_DAEMON_LABEL="com.network_analyzer.bpf"
BPF_DAEMON="/Library/LaunchDaemons/$BPF_DAEMON_LABEL.plist"
# Directories: the rights and their inheritance. Files: the same without search (= execute).
ACL_DIR="group:$AGENT_GROUP allow read,write,append,delete,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity,chown,search,list,add_file,add_subdirectory,directory_inherit"
ACL_FILE_INHERIT="group:$AGENT_GROUP allow read,write,append,delete,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity,chown,file_inherit,directory_inherit,only_inherit"
ACL_FILE="group:$AGENT_GROUP allow read,write,append,delete,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity,chown"

group_exists() { dscl . -read "/Groups/$AGENT_GROUP" >/dev/null 2>&1; }

node_binary() {
  if [ -n "${NODE:-}" ]; then echo "$NODE"; return; fi
  ls -d "$OWNER_HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1
}

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

  step "e. What the server needs to start agents"
  if group_exists; then
    say "  group $AGENT_GROUP: $(dscl . -read "/Groups/$AGENT_GROUP" GroupMembership 2>/dev/null | cut -d: -f2-)"
  else
    say "  group $AGENT_GROUP: missing"
  fi
  has_acl "group:$AGENT_GROUP" "$AGENT_ROOT" && say "  sandboxes ACL: set" || say "  sandboxes ACL: missing"
  [ -f "$PROFILE" ] && say "  profile: $PROFILE ($(stat -f '%Su %Sp' "$PROFILE"))" || say "  profile: missing"
  [ -f "$SUDOERS" ] && say "  sudoers: $SUDOERS" || say "  sudoers: missing"
  [ -x "/Users/$AGENT_USER/.local/bin/claude" ] && say "  agent claude: installed" || say "  agent claude: missing"
  [ -x "/Users/$AGENT_USER/.local/node/bin/node" ] && say "  agent node: installed" || say "  agent node: missing"
  step "e7. Host hardening"
  local file
  for file in $ANYDESK_FILES; do [ -e "$file" ] && say "  $(stat -f '%Su:%Sg %Sp' "$file")  $file"; done
  [ -f "$BPF_DAEMON" ] && say "  $BPF_DAEMON: present (opens /dev/bpf* to everyone at boot)" || say "  $BPF_DAEMON: absent"
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

# Everything on the disk but macOS's own hidden folders.
owner_targets() {
  local entry
  for entry in "$DOT"/* "$DOT"/.[!.]*; do
    case "$(basename "$entry")" in
      .Spotlight-V100|.fseventsd|.Trashes|.DocumentRevisions-V100|.TemporaryItems|.com.apple.*) continue ;;
    esac
    [ -e "$entry" ] || [ -L "$entry" ] && echo "$entry"
  done
}

fix_owners() {
  need_root fix-owners
  [ "$(ownership_state)" = Enabled ] || die "owners are disabled on $DOT; run sudo $0 ownership-on first"
  step "Storing $OWNER as the real owner of everything on $DOT (whole disk: minutes)"
  chown "$OWNER" "$DOT"
  local entry
  while IFS= read -r entry; do
    say "  $entry"
    # A locked file (uchg) refuses chown; report it and go on with the rest.
    chown -R -h "$OWNER" "$entry" || say "  (some files in $entry kept their owner: see the errors above; locked ones: chflags nouchg <file>, then rerun)"
  done < <(owner_targets)
  say "  done. Check as the agent: (cd / && sudo -u $AGENT_USER bash -s) < $HERE/check-as-agent.sh"
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

agent_group() {
  need_root agent-group
  user_exists || die "$AGENT_USER does not exist; run sudo $0 add-user first"
  step "Group $AGENT_GROUP with $OWNER and $AGENT_USER"
  group_exists || dseditgroup -o create -r "Factory server and its agents" "$AGENT_GROUP"
  dseditgroup -o edit -a "$OWNER" -t user "$AGENT_GROUP"
  dseditgroup -o edit -a "$AGENT_USER" -t user "$AGENT_GROUP"
  step "ACLs on $AGENT_ROOT (every file: minutes for big checkouts)"
  find "$AGENT_ROOT" \( -type d -exec chmod -h +a "$ACL_DIR" {} + -exec chmod -h +a "$ACL_FILE_INHERIT" {} + \) \
    -o \( ! -type d -exec chmod -h +a "$ACL_FILE" {} + \) 2>/dev/null || say "  (some entries refused an ACL; see above)"
  step "Agent temp folder"
  install -d -o "$AGENT_USER" -g staff -m 700 "/Users/$AGENT_USER/.tmp"
  status
}

remove_agent_group() {
  need_root remove-agent-group
  step "Removing $AGENT_GROUP ACLs from $AGENT_ROOT"
  # Inherited copies do not match the original text, so strip every ACL there (as SandVault does on
  # its shared folder): agent-group is the only thing that puts ACLs inside the sandboxes folder.
  find "$AGENT_ROOT" -exec chmod -h -N {} + 2>/dev/null || true
  group_exists && dseditgroup -o delete "$AGENT_GROUP"
  status
}

agent_profile() {
  need_root agent-profile
  local node
  node="$(node_binary)"
  [ -x "$node" ] || die "no node found; run with NODE=/path/to/node"
  step "Generating the profile with $node"
  local tmp
  tmp="$(mktemp)"
  FACTORY_AGENT_USER="$AGENT_USER" FACTORY_SERVER_USER="$OWNER" MASTRACODE_LOCAL_SANDBOX_ROOT="$AGENT_ROOT" \
    "$node" "$REPO/packages/agent-user/bin/print-profile.ts" > "$tmp" || { rm -f "$tmp"; die "could not generate the profile"; }
  /usr/bin/sandbox-exec -f "$tmp" /usr/bin/true || { rm -f "$tmp"; die "sandbox-exec refuses the generated profile"; }
  install -d -o root -g wheel -m 755 "$PROFILE_DIR"
  install -o root -g wheel -m 644 "$tmp" "$PROFILE"
  rm -f "$tmp"
  say "  installed $PROFILE"
}

remove_agent_profile() {
  need_root remove-agent-profile
  rm -f "$PROFILE"
  rmdir "$PROFILE_DIR" 2>/dev/null || true
  say "  removed $PROFILE"
}

agent_tools() {
  need_root agent-tools
  user_exists || die "$AGENT_USER does not exist; run sudo $0 add-user first"
  local agent_home="/Users/$AGENT_USER" claude node_dir version
  claude="$(readlink -f "$OWNER_HOME/.local/bin/claude" 2>/dev/null || true)"
  [ -x "$claude" ] || die "no claude in $OWNER_HOME/.local/bin"
  version="$(cat "$OWNER_HOME/.nvm/alias/default" 2>/dev/null || true)"
  node_dir="$(ls -d "$OWNER_HOME/.nvm/versions/node/${version:-none}"* 2>/dev/null | tail -1)"
  [ -x "$node_dir/bin/node" ] || die "no nvm default node (alias: ${version:-unset})"
  step "claude $(basename "$claude") -> $agent_home/.local/bin/claude"
  install -d -o "$AGENT_USER" -g staff -m 755 "$agent_home/.local" "$agent_home/.local/bin"
  install -o "$AGENT_USER" -g staff -m 755 "$claude" "$agent_home/.local/bin/claude"
  step "node $(basename "$node_dir") -> $agent_home/.local/node"
  rm -rf "$agent_home/.local/node"
  ditto "$node_dir" "$agent_home/.local/node"
  chown -R "$AGENT_USER:staff" "$agent_home/.local/node"
  say "  as the agent: $(cd / && sudo -n -u "$AGENT_USER" -- /usr/bin/env -i HOME="$agent_home" PATH="$agent_home/.local/bin:$agent_home/.local/node/bin:/usr/bin:/bin" /bin/sh -c 'cd / && echo "claude $(claude --version 2>/dev/null | head -1), node $(node --version)"')"
}

remove_agent_tools() {
  need_root remove-agent-tools
  rm -rf "/Users/$AGENT_USER/.local/node" "/Users/$AGENT_USER/.local/bin/claude"
  say "  removed the agent's claude and node"
}

agent_mobile_tools() {
  need_root agent-mobile-tools
  user_exists || die "$AGENT_USER does not exist; run sudo $0 add-user first"
  local agent_home="/Users/$AGENT_USER" fvm_home="$OWNER_HOME/.fvm_flutter/bin" cache version
  [ -x "$fvm_home/fvm" ] || die "no fvm in $fvm_home"
  cache="$(sed -n 's/.*"cachePath"[^"]*"\([^"]*\)".*/\1/p' "$OWNER_HOME/Library/Application Support/fvm/.fvmrc" 2>/dev/null)"
  cache="${cache:-$OWNER_HOME/fvm}"
  step "fvm -> $agent_home/.local/fvm"
  install -d -o "$AGENT_USER" -g staff -m 755 "$agent_home/.local"
  rm -rf "$agent_home/.local/fvm"
  ditto "$fvm_home" "$agent_home/.local/fvm"
  chown -R "$AGENT_USER:staff" "$agent_home/.local/fvm"
  install -d -o "$AGENT_USER" -g staff -m 755 "$agent_home/fvm" "$agent_home/fvm/versions" "$agent_home/Library/Application Support/fvm"
  printf '{\n  "cachePath": "%s"\n}\n' "$agent_home/fvm" > "$agent_home/Library/Application Support/fvm/.fvmrc"
  chown "$AGENT_USER:staff" "$agent_home/Library/Application Support/fvm/.fvmrc"
  for version in $AGENT_FLUTTER_VERSIONS; do
    [ -x "$cache/versions/$version/bin/flutter" ] || die "Flutter $version is not in $cache/versions (fvm install $version first)"
    step "Flutter $version -> $agent_home/fvm/versions/$version"
    rm -rf "$agent_home/fvm/versions/$version"
    ditto "$cache/versions/$version" "$agent_home/fvm/versions/$version"
    chown -R "$AGENT_USER:staff" "$agent_home/fvm/versions/$version"
  done
  [ -x /opt/homebrew/bin/pod ] || say "  note: no /opt/homebrew/bin/pod; iOS builds need CocoaPods (brew install cocoapods)"
  say "  as the agent: $(cd / && sudo -n -u "$AGENT_USER" -- /usr/bin/env -i HOME="$agent_home" PATH="$agent_home/.local/fvm:/opt/homebrew/bin:/usr/bin:/bin" /bin/sh -c 'cd / && echo "fvm $(fvm --version 2>&1 | tail -1), pod $(pod --version 2>&1 | tail -1)"; for v in ~/fvm/versions/*; do echo "  flutter $(basename "$v"): $("$v/bin/flutter" --version --machine 2>/dev/null | sed -n "s/.*\"frameworkVersion\": *\"\([^\"]*\)\".*/\1/p")"; done')"
}

remove_agent_mobile_tools() {
  need_root remove-agent-mobile-tools
  rm -rf "/Users/$AGENT_USER/.local/fvm" "/Users/$AGENT_USER/fvm" "/Users/$AGENT_USER/Library/Application Support/fvm"
  say "  removed the agent's fvm and Flutter SDKs"
}

# Whether a TCP connection to 127.0.0.1:<port> opens, as <user> (exit 0) or not.
can_connect() { (cd / && sudo -n -u "$1" -- /usr/bin/nc -z -G 2 127.0.0.1 "$2") >/dev/null 2>&1; }

agent_firewall() {
  need_root agent-firewall
  user_exists || die "$AGENT_USER does not exist; run sudo $0 add-user first"
  install -d -o root -g wheel -m 755 "$PROFILE_DIR"
  local tmp port
  tmp="$(mktemp)"
  printf '# Factory (ADR-0041): %s may not reach the Factory server or Chrome'"'"'s debugger.\n# Written by scripts/mac-mini/isolation/2-system.sh agent-firewall.\nblock return out quick proto tcp from any to any port { %s } user %s\n' \
    "$AGENT_USER" "$(echo $FIREWALL_PORTS | tr ' ' ',')" "$AGENT_USER" > "$tmp"
  pfctl -n -a "$FIREWALL_ANCHOR" -f "$tmp" 2>/dev/null || { rm -f "$tmp"; die "pfctl rejects the rule"; }
  install -o root -g wheel -m 644 "$tmp" "$FIREWALL_RULES"
  rm -f "$tmp"
  step "the rule, loaded into $FIREWALL_ANCHOR; pf enabled"
  pfctl -E >/dev/null 2>&1 || true
  pfctl -a "$FIREWALL_ANCHOR" -f "$FIREWALL_RULES" 2>/dev/null
  pfctl -a "$FIREWALL_ANCHOR" -s rules 2>/dev/null | sed 's/^/    /'
  step "at every boot: $FIREWALL_DAEMON"
  cat > "$FIREWALL_DAEMON" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.eclipt.factory-agent-firewall</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>-c</string><string>/sbin/pfctl -E; /sbin/pfctl -a $FIREWALL_ANCHOR -f $FIREWALL_RULES</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
  chown root:wheel "$FIREWALL_DAEMON"; chmod 644 "$FIREWALL_DAEMON"
  launchctl bootout system "$FIREWALL_DAEMON" 2>/dev/null || true
  launchctl bootstrap system "$FIREWALL_DAEMON"
  step "check"
  for port in $FIREWALL_PORTS; do
    if can_connect "$AGENT_USER" "$port"; then die "$AGENT_USER still reaches 127.0.0.1:$port"; fi
    if can_connect "$OWNER" "$port"; then say "  $port: $OWNER connects, $AGENT_USER is refused"
    else say "  $port: $AGENT_USER is refused (nothing listens there for $OWNER either right now)"; fi
  done
}

remove_agent_firewall() {
  need_root remove-agent-firewall
  launchctl bootout system "$FIREWALL_DAEMON" 2>/dev/null || true
  rm -f "$FIREWALL_DAEMON" "$FIREWALL_RULES"
  pfctl -a "$FIREWALL_ANCHOR" -F rules 2>/dev/null || true
  say "  removed the rule and its LaunchDaemon (pf itself stays on, with the system's own rules)"
}

agent_can_write() { (cd / && sudo -n -u "$AGENT_USER" -- /bin/test -w "$1"); }

host_hardening() {
  need_root host-hardening
  install -d -o root -g wheel -m 700 "$HARDENING_DIR"
  local file
  step "AnyDesk config: 600, root only"
  for file in $ANYDESK_FILES; do
    [ -e "$file" ] || continue
    # The first run records the original mode; a rerun keeps it.
    grep -qF " $file" "$HARDENING_DIR/modes" 2>/dev/null || echo "$(stat -f '%Lp' "$file") $file" >> "$HARDENING_DIR/modes"
    chmod 600 "$file"
    say "  $(stat -f '%Sp' "$file")  $file"
  done
  step "$BPF_DAEMON_LABEL: stopped, plist kept in $HARDENING_DIR"
  if [ -f "$BPF_DAEMON" ]; then
    launchctl bootout "system/$BPF_DAEMON_LABEL" 2>/dev/null || true
    mv "$BPF_DAEMON" "$HARDENING_DIR/"
    say "  moved $BPF_DAEMON"
  else
    say "  already gone"
  fi
  step "check"
  for file in $ANYDESK_FILES; do
    [ -e "$file" ] || continue
    if agent_can_write "$file"; then die "$AGENT_USER can still write $file"; fi
  done
  say "  $AGENT_USER cannot write the AnyDesk config"
  say "  /dev/bpf*: $(stat -f '%Sp' /dev/bpf* | sort -u | tr '\n' ' ')(reboot no longer opens them)"
}

remove_host_hardening() {
  need_root remove-host-hardening
  local mode file
  if [ -f "$HARDENING_DIR/modes" ]; then
    while read -r mode file; do
      [ -e "$file" ] && chmod "$mode" "$file" && say "  $mode  $file"
    done < "$HARDENING_DIR/modes"
    rm -f "$HARDENING_DIR/modes"
  fi
  if [ -f "$HARDENING_DIR/$BPF_DAEMON_LABEL.plist" ]; then
    mv "$HARDENING_DIR/$BPF_DAEMON_LABEL.plist" "$BPF_DAEMON"
    chown root:wheel "$BPF_DAEMON"
    launchctl bootstrap system "$BPF_DAEMON" 2>/dev/null || true
    say "  restored $BPF_DAEMON"
  fi
}

agent_sudo() {
  need_root agent-sudo
  user_exists || die "$AGENT_USER does not exist; run sudo $0 add-user first"
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<SUDOERS_RULE
# Factory: the server ($OWNER) starts and stops agent processes as $AGENT_USER (ADR-0041).
# env starts every agent command (env -i ... sandbox-exec ...), kill stops them; fd 3 carries
# the agent's environment across sudo. Written by scripts/mac-mini/isolation/2-system.sh.
Defaults:$OWNER closefrom_override
$OWNER ALL=($AGENT_USER) NOPASSWD: /usr/bin/env, /bin/kill
SUDOERS_RULE
  visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "visudo rejects the rule"; }
  install -o root -g wheel -m 440 "$tmp" "$SUDOERS"
  rm -f "$tmp"
  visudo -c >/dev/null || { rm -f "$SUDOERS"; die "sudoers as a whole did not parse; the rule was removed"; }
  say "  installed $SUDOERS"
  say "  check, without sudo: sudo -n -u $AGENT_USER -- /usr/bin/env id -un"
}

remove_agent_sudo() {
  need_root remove-agent-sudo
  rm -f "$SUDOERS"
  say "  removed $SUDOERS"
}

case "${1:-status}" in
  status) status ;;
  ownership-on) ownership_on ;;
  ownership-off) ownership_off ;;
  fix-owners) fix_owners ;;
  close-dot) close_dot ;;
  open-dot) open_dot ;;
  add-user) add_user ;;
  remove-user) remove_user ;;
  agent-path) agent_path ;;
  close-agent-path) close_agent_path ;;
  agent-group) agent_group ;;
  remove-agent-group) remove_agent_group ;;
  agent-profile) agent_profile ;;
  remove-agent-profile) remove_agent_profile ;;
  agent-sudo) agent_sudo ;;
  agent-tools) agent_tools ;;
  remove-agent-tools) remove_agent_tools ;;
  agent-mobile-tools) agent_mobile_tools ;;
  remove-agent-mobile-tools) remove_agent_mobile_tools ;;
  agent-firewall) agent_firewall ;;
  remove-agent-firewall) remove_agent_firewall ;;
  host-hardening) host_hardening ;;
  remove-host-hardening) remove_host_hardening ;;
  remove-agent-sudo) remove_agent_sudo ;;
  *) die "usage: $0 [status|ownership-on|fix-owners|close-dot|add-user|agent-path|close-agent-path|agent-group|agent-profile|agent-sudo|agent-tools|agent-mobile-tools|agent-firewall|host-hardening|remove-host-hardening|remove-agent-firewall|remove-agent-mobile-tools|remove-agent-tools|remove-agent-sudo|remove-agent-profile|remove-agent-group|remove-user|open-dot|ownership-off]" ;;
esac
