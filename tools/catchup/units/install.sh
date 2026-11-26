#!/usr/bin/env bash
# Installs the catch-up on THIS host (docs/design-hub-v1.1.md E1), in watch mode unless the host already has a mode:
#   big-chungus  the hub's tools/ under ~/.local/share/mobile-deploy-hub/releases/<ref>, `current` pointing at it,
#                the systemd user service units for S26 catch-up + Mac watchdog. They have no timer: candybar
#                (mobile-deploy-hub-catchup, mobile-deploy-hub-macwatch) is the only clock.
#   the Mac      the same tree, and the LaunchAgent sh.delo.mobile-deploy-hub.catchup bootstrapped into the GUI
#                session gui/<uid>. It has no interval either: it is the on-demand executor of the iPad pass, and
#                candybar mobile-deploy-hub-ios-catchup (.candybars/ in the hub) kickstarts it over ssh every 5 minutes.
# Run it from the tools/ tree it should install: tools/catchup/units/install.sh <ref>. On the Mac, copy tools/ to
# ~/.local/share/mobile-deploy-hub/releases/<ref>/tools first (rsync over ssh) and run it from there: nothing is
# copied twice. `mise run hosts:install` in the hub does both. It never changes a host's mode; going live is
# `catchup.mjs mode live` on that host.
set -euo pipefail

# Forward-only (MOBI-51): `current` never moves to a commit that is an ancestor of the installed one unless --allow-downgrade (or
# HUB_ALLOW_DOWNGRADE=1) is given. Every install records the commit it installed in releases/<ref>/.hub-commit, so a tree without .git
# (the Mac's copy, a release copy) can be compared too. A refusal exits 3 and prints HUB_INSTALL_REFUSED naming both refs; nothing is
# copied, repointed or restarted.
allow_downgrade=${HUB_ALLOW_DOWNGRADE:-0}
ref=
for arg in "$@"; do
  case $arg in
    --allow-downgrade) allow_downgrade=1 ;;
    -*) echo "install.sh: unknown option '$arg'" >&2; exit 2 ;;
    *) [[ -z $ref ]] || { echo "install.sh: one ref only" >&2; exit 2; }; ref=$arg ;;
  esac
done
[[ -n $ref ]] || { echo "usage: install.sh [--allow-downgrade] <ref, e.g. v1.1.0 or main-1a2b3c4>" >&2; exit 2; }
[[ $ref =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "install.sh: bad ref '$ref'" >&2; exit 2; }
units=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
tools=$(cd "$units/../.." && pwd -P)
[[ -f $tools/catchup/catchup.mjs && -f $tools/ci/lib/adb.mjs ]] || { echo "install.sh: $tools is not the hub's tools/ tree" >&2; exit 2; }
node="$HOME/.local/share/mise/installs/node/24/bin/node"
[[ -x $node ]] || { echo "install.sh: no node 24 at $node (mise install node@24)" >&2; exit 2; }

share="$HOME/.local/share/mobile-deploy-hub"
release="$share/releases/$ref"

# A commit record is `commit=<sha>` and `count=<commits in its history>` in <release>/.hub-commit.
record_field() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n1; }
# The repo to ask about ancestry: HUB_REPO, the tree this script runs from, or the usual checkout.
hub_repo() {
  local candidate
  for candidate in "${HUB_REPO:-}" "$tools/.." "$HOME/code/mobile-deploy-hub"; do
    [[ -n $candidate ]] && git -C "$candidate" rev-parse --git-dir >/dev/null 2>&1 && { echo "$candidate"; return 0; }
  done
  return 1
}
# Prints "<sha> <count>" for a release dir (its record, else - for a checkout tree - git HEAD), nothing when unknown.
commit_of_tree() {
  local dir=$1 sha count
  if [[ -f $dir/.hub-commit ]]; then
    sha=$(record_field "$dir/.hub-commit" commit); count=$(record_field "$dir/.hub-commit" count)
    [[ -n $sha ]] && { echo "$sha ${count:-}"; return 0; }
  fi
  return 1
}
commit_from_git() {
  local sha=$1 repo count
  repo=$(hub_repo) || return 1
  sha=$(git -C "$repo" rev-parse --verify -q "$sha^{commit}") || return 1
  count=$(git -C "$repo" rev-list --count "$sha") || return 1
  echo "$sha $count"
}

# What this install is: the tree's own record when it is a release copy, else the checkout's HEAD.
new_commit=
if [[ $tools == "$release/tools" ]]; then
  new_commit=$(commit_of_tree "$release" || true)
elif git -C "$tools" rev-parse --git-dir >/dev/null 2>&1; then
  new_commit=$(cd "$tools/.." && commit_from_git HEAD || true)
fi
# What is installed: current's record; a legacy install with none is read from its ref name (main-<sha> or a vX.Y.Z tag).
installed_ref=; installed_commit=
if [[ -L $share/current ]]; then
  installed_ref=$(basename "$(readlink "$share/current")")
  installed_commit=$(commit_of_tree "$share/current" || true)
  if [[ -z $installed_commit ]]; then
    case $installed_ref in
      main-*) installed_commit=$(commit_from_git "${installed_ref#main-}" || true) ;;
      v[0-9]*) installed_commit=$(commit_from_git "$installed_ref" || true) ;;
    esac
  fi
fi

if [[ -n $new_commit && -n $installed_commit ]]; then
  read -r new_sha new_count <<<"$new_commit"
  read -r old_sha old_count <<<"$installed_commit"
  behind=0
  if [[ $new_sha != "$old_sha" ]]; then
    repo=$(hub_repo || true)
    if [[ -n $repo ]] && git -C "$repo" cat-file -e "$new_sha^{commit}" 2>/dev/null && git -C "$repo" cat-file -e "$old_sha^{commit}" 2>/dev/null; then
      git -C "$repo" merge-base --is-ancestor "$new_sha" "$old_sha" && behind=1
    elif [[ -n ${new_count:-} && -n ${old_count:-} && $new_count -lt $old_count ]]; then
      behind=1
    fi
  fi
  if [[ $behind == 1 && $allow_downgrade != 1 ]]; then
    echo "HUB_INSTALL_REFUSED current stays on $installed_ref (${old_sha:0:7}): $ref (${new_sha:0:7}) is an ancestor of it, so installing it would take the hosts back. Pass --allow-downgrade to do that on purpose." >&2
    exit 3
  fi
  [[ $behind == 1 ]] && echo "HUB_INSTALL_DOWNGRADE current moves back from $installed_ref (${old_sha:0:7}) to $ref (${new_sha:0:7}) (--allow-downgrade)"
elif [[ -n $installed_ref && $installed_ref != "$ref" ]]; then
  echo "HUB_INSTALL_UNVERIFIED cannot order $ref against $installed_ref (commit of $ref: ${new_commit%% *}, commit of $installed_ref: ${installed_commit%% *}; empty means unknown); installing without the forward-only check" >&2
fi

mkdir -p "$share/releases"
if [[ $tools != "$release/tools" ]]; then
  rm -rf "$release.part"
  mkdir -p "$release.part"
  cp -R "$tools" "$release.part/tools"
  [[ -n $new_commit ]] && { read -r sha count <<<"$new_commit"; printf 'commit=%s\ncount=%s\n' "$sha" "$count" > "$release.part/.hub-commit"; }
  rm -rf "$release"
  mv "$release.part" "$release"
elif [[ -n $new_commit && ! -f $release/.hub-commit ]]; then
  read -r sha count <<<"$new_commit"; printf 'commit=%s\ncount=%s\n' "$sha" "$count" > "$release/.hub-commit"
fi
ln -sfn "releases/$ref" "$share/current"
echo "catch-up code: $share/current -> releases/$ref"

# hub-device, the lease on the shared phone, for people and agents: ~/.local/bin/hub-device runs this release's copy
# (not `current`) with this node, so a session that started with it keeps the code it started with. Leases are honoured
# only by hub releases with this lock.mjs: land the release (pin flip) before or with this install (README, Devices).
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$node" "$release/tools/device/hub-device.mjs" > "$HOME/.local/bin/hub-device.part"
chmod +x "$HOME/.local/bin/hub-device.part"
mv -f "$HOME/.local/bin/hub-device.part" "$HOME/.local/bin/hub-device"
echo "hub-device: ~/.local/bin/hub-device runs $release/tools/device/hub-device.mjs"

# The mode belongs to the host, not the code: a missing file means watch, and an existing one is left alone.
config="${XDG_CONFIG_HOME:-$HOME/.config}/mobile-deploy-hub/catchup.json"
if [[ ! -f $config ]]; then
  mkdir -p "$(dirname "$config")"
  printf '{"mode":"watch","changed_at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$config"
fi
"$node" "$share/current/tools/catchup/catchup.mjs" mode

case "$(uname -s)" in
  Linux)
    dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$dest"
    cp "$units/mobile-deploy-hub-catchup.service" "$units/mobile-deploy-hub-macwatch.service" "$dest/"
    # The two .timer files were retired (candybar owns both cadences since story 7.11): sweep any copy an older
    # release installed, so a stray one can never become a second clock.
    rm -f "$dest/mobile-deploy-hub-catchup.timer" "$dest/mobile-deploy-hub-macwatch.timer"
    systemctl --user daemon-reload
    echo "catch-up units installed (service units only; candybar owns cadence)"
    ;;
  Darwin)
    label=sh.delo.mobile-deploy-hub.catchup
    domain="gui/$(id -u)"
    plist="$HOME/Library/LaunchAgents/$label.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/mobile-deploy-hub"
    sed "s#@HOME@#$HOME#g" "$units/$label.plist" > "$plist.part"
    plutil -lint "$plist.part" >/dev/null
    mv "$plist.part" "$plist"
    launchctl bootout "$domain/$label" 2>/dev/null || true
    for _ in $(seq 1 20); do launchctl print "$domain/$label" >/dev/null 2>&1 || break; sleep 0.5; done
    launchctl bootstrap "$domain" "$plist"
    launchctl print "$domain/$label" | grep -E '^\s*(state|path|run interval|program|last exit code) ' || true
    ;;
  *)
    echo "install.sh: no catch-up unit for $(uname -s)" >&2
    exit 2
    ;;
esac
