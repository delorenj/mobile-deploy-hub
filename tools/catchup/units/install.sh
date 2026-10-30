#!/usr/bin/env bash
# Installs the catch-up on THIS host (docs/design-hub-v1.1.md E1), in watch mode unless the host already has a mode:
#   big-chungus  the hub's tools/ under ~/.local/share/mobile-deploy-hub/releases/<ref>, `current` pointing at it,
#                the systemd user service units for S26 catch-up + Mac watchdog; candybar owns their timer cadence
#                (story 7.11). The old timer files are retained for rollback, never enabled by this installer.
#   the Mac      the same tree, and the LaunchAgent sh.delo.mobile-deploy-hub.catchup bootstrapped into the GUI
#                session gui/<uid> (every 5 minutes)
# Run it from the tools/ tree it should install: tools/catchup/units/install.sh <ref>. On the Mac, copy tools/ to
# ~/.local/share/mobile-deploy-hub/releases/<ref>/tools first (rsync over ssh) and run it from there: nothing is
# copied twice. `mise run hosts:install` in the hub does both. It never changes a host's mode; going live is
# `catchup.mjs mode live` on that host.
set -euo pipefail

ref=${1:?usage: install.sh <ref, e.g. v1.1.0 or main-1a2b3c4>}
[[ $ref =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "install.sh: bad ref '$ref'" >&2; exit 2; }
units=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
tools=$(cd "$units/../.." && pwd -P)
[[ -f $tools/catchup/catchup.mjs && -f $tools/ci/lib/adb.mjs ]] || { echo "install.sh: $tools is not the hub's tools/ tree" >&2; exit 2; }
node="$HOME/.local/share/mise/installs/node/24/bin/node"
[[ -x $node ]] || { echo "install.sh: no node 24 at $node (mise install node@24)" >&2; exit 2; }

share="$HOME/.local/share/mobile-deploy-hub"
release="$share/releases/$ref"
mkdir -p "$share/releases"
if [[ $tools != "$release/tools" ]]; then
  rm -rf "$release.part"
  mkdir -p "$release.part"
  cp -R "$tools" "$release.part/tools"
  rm -rf "$release"
  mv "$release.part" "$release"
fi
ln -sfn "releases/$ref" "$share/current"
echo "catch-up code: $share/current -> releases/$ref"

# hub-device, the lease on the shared phone, for people and agents: ~/.local/bin/hub-device points into this release (not
# at `current`), so a session that started with it keeps the code it started with.
chmod +x "$release/tools/device/hub-device.mjs"
mkdir -p "$HOME/.local/bin"
ln -sfn "$release/tools/device/hub-device.mjs" "$HOME/.local/bin/hub-device"
echo "hub-device: ~/.local/bin/hub-device -> $release/tools/device/hub-device.mjs"

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
    cp "$units/mobile-deploy-hub-catchup.service" "$units/mobile-deploy-hub-catchup.timer" "$dest/"
    cp "$units/mobile-deploy-hub-macwatch.service" "$units/mobile-deploy-hub-macwatch.timer" "$dest/"
    systemctl --user daemon-reload
    # Candybar owns these two cadences after the story 7.11 cutover; enabling
    # either timer on every hub release resurrects the native scheduler and
    # double-runs the job. Keep the timer files for ledger rollback by path.
    echo "catch-up units installed (timers stay disabled; candybar owns cadence)"
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
