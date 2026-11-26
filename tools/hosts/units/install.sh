#!/usr/bin/env bash
# Renders this directory's units for the release <ref>, one installer for every hub service on either host. Nothing else: it copies no
# code, deletes nothing, and does not start, restart or enable a service (`mise run hosts:install` does, then reads each /health back).
#   Linux   every *.service here (today the Hub API's) into ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/, then `daemon-reload`.
#   Darwin  every *.plist here (today the Host Agent's LaunchAgent) into ~/Library/LaunchAgents/ (written as <name>.part, `plutil -lint`ed,
#           then moved into place), then, per agent, `launchctl bootout gui/<uid>/<label>` (failure ignored), a wait of at most 10 s for the
#           label to leave, and `launchctl bootstrap gui/<uid> <plist>`: for a LaunchAgent bootout then bootstrap is the restart.
#           The catch-up's own LaunchAgent is tools/catchup/units/install.sh's and is never touched here.
#
# It must run from the release copy, ~/.local/share/mobile-deploy-hub/releases/<ref>/tools/hosts/units/install.sh <ref>:
# `tools/catchup/units/install.sh` (which hosts:install runs first) puts the release there. @REF@ becomes <ref>, @NODE@ the real
# directory behind ~/.local/share/mise/installs/node/24 (e.g. .../node/24.15.0), which must report Node >= 24.15, and on the Mac
# @HOME@ becomes $HOME.
set -euo pipefail

platform=$(uname -s)
case "$platform" in
  Linux|Darwin) ;;
  *) echo "install.sh: no hosts unit for $platform" >&2; exit 2 ;;
esac

ref=${1:?usage: install.sh <ref, e.g. v1.1.0 or main-1a2b3c4>}
[[ $ref =~ ^[A-Za-z0-9._-]{1,64}$ && $ref != . && $ref != .. ]] || { echo "install.sh: bad ref '$ref'" >&2; exit 2; }

units=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
release="$HOME/.local/share/mobile-deploy-hub/releases/$ref"
want=$(cd "$release/tools/hosts/units" 2>/dev/null && pwd -P) || want=
[[ -n $want && $units == "$want" ]] || { echo "install.sh: run it from the release copy, $release/tools/hosts/units/install.sh (mise run hosts:install puts it there)" >&2; exit 2; }

node_dir=$(cd "$HOME/.local/share/mise/installs/node/24" 2>/dev/null && pwd -P) || node_dir=
[[ -n $node_dir && -x $node_dir/bin/node ]] || { echo "install.sh: no node 24 at ~/.local/share/mise/installs/node/24 (mise install node@24)" >&2; exit 2; }
version=$("$node_dir/bin/node" --version 2>/dev/null || true)
version=${version#v}
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
if [[ ! $major =~ ^[0-9]+$ || ! $minor =~ ^[0-9]+$ ]] || (( major < 24 || (major == 24 && minor < 15) )); then
  echo "install.sh: the hub services need Node >= 24.15, $node_dir is '${version:-unknown}'" >&2
  exit 2
fi

shopt -s nullglob
if [[ $platform == Linux ]]; then
  dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$dest"
  for unit in "$units"/*.service; do
    name=$(basename "$unit")
    body=$(sed -e "s#@REF@#$ref#g" -e "s#@NODE@#$node_dir#g" "$unit")
    if grep -Eq '@[A-Z_]+@' <<<"$body"; then
      echo "install.sh: $name has a placeholder install.sh does not know" >&2
      exit 2
    fi
    printf '%s\n' "$body" > "$dest/$name.part"
    mv "$dest/$name.part" "$dest/$name"
    echo "hosts unit: $dest/$name runs releases/$ref with $node_dir"
  done
  systemctl --user daemon-reload
  echo "hosts units installed (rendered only; hosts:install enables and restarts them)"
else
  dest="$HOME/Library/LaunchAgents"
  domain="gui/$(id -u)"
  mkdir -p "$dest" "$HOME/Library/Logs/mobile-deploy-hub"
  for agent in "$units"/*.plist; do
    name=$(basename "$agent")
    label=${name%.plist}
    body=$(sed -e "s#@REF@#$ref#g" -e "s#@NODE@#$node_dir#g" -e "s#@HOME@#$HOME#g" "$agent")
    if grep -Eq '@[A-Z_]+@' <<<"$body"; then
      echo "install.sh: $name has a placeholder install.sh does not know" >&2
      exit 2
    fi
    printf '%s\n' "$body" > "$dest/$name.part"
    lint=$(plutil -lint "$dest/$name.part" 2>&1) || { echo "install.sh: $name does not lint: $lint" >&2; exit 1; }
    mv "$dest/$name.part" "$dest/$name"
    launchctl bootout "$domain/$label" 2>/dev/null || true
    for _ in $(seq 1 20); do launchctl print "$domain/$label" >/dev/null 2>&1 || break; sleep 0.5; done
    launchctl bootstrap "$domain" "$dest/$name"
    echo "hosts agent: $label bootstrapped into $domain, runs releases/$ref with $node_dir"
  done
fi
