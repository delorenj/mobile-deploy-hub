#!/usr/bin/env bash
# Renders this directory's systemd user units (every *.service here: today the Hub API, the Host Agent's later) into
# ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ for the release <ref>, then tells systemd to re-read them. Nothing else:
# it copies no code, deletes nothing, and does not enable, start or restart a unit (`mise run hosts:install` does, then reads the
# service's /health back).
#
# It must run from the release copy, ~/.local/share/mobile-deploy-hub/releases/<ref>/tools/hosts/units/install.sh <ref>:
# `tools/catchup/units/install.sh` (which hosts:install runs first) puts the release there. @REF@ becomes <ref> and @NODE@ the real
# directory behind ~/.local/share/mise/installs/node/24 (e.g. .../node/24.15.0), which must report Node >= 24.15.
# On the Mac the Hub API does not run (the Host Agent is Epic 7): it prints one line and exits 0.
set -euo pipefail

case "$(uname -s)" in
  Linux) ;;
  Darwin) echo "hosts units: nothing to install on the Mac (the Host Agent is not part of this release)"; exit 0 ;;
  *) echo "install.sh: no hosts unit for $(uname -s)" >&2; exit 2 ;;
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
  echo "install.sh: the Hub API needs Node >= 24.15, $node_dir is '${version:-unknown}'" >&2
  exit 2
fi

dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$dest"
shopt -s nullglob
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
