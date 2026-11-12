#!/usr/bin/env bash
# Build tasks-axi from this checkout and install it globally.
#   scripts/install-fork.sh                      # local install (npm -g)
#   scripts/install-fork.sh --prefix ~/.local    # install under a prefix
#   scripts/install-fork.sh --hosts "macbook mini0 mini1 mini3 lnx"
# --hosts ssh's to each host, clones/updates the fork under ~/.cache/tasks-axi-fork
# and runs this script there; lnx always gets --prefix $HOME/.local.
set -euo pipefail

FORK_URL="${FORK_URL:-https://github.com/trillium/tasks-axi}"
FORK_REF="${FORK_REF:-main}"
prefix=""; hosts=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="${2:?--prefix needs a value}"; shift ;;
    --hosts) hosts="${2:?--hosts needs a value}"; shift ;;
    --ref) FORK_REF="${2:?--ref needs a value}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$hosts" ]; then
  rc=0
  for h in $hosts; do
    extra=""; [ "$h" = lnx ] && extra='--prefix "$HOME/.local"'
    echo "== $h"
    ssh -o BatchMode=yes "$h" "bash -lc '
      set -e
      d=\"\$HOME/.cache/tasks-axi-fork\"
      [ -d \"\$d/.git\" ] || git clone -q $FORK_URL \"\$d\"
      git -C \"\$d\" fetch -q origin
      git -C \"\$d\" checkout -q -f origin/$FORK_REF
      bash \"\$d/scripts/install-fork.sh\" $extra
    '" || { echo "FAILED: $h" >&2; rc=1; }
  done
  exit $rc
fi

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pnpm install --frozen-lockfile
pnpm build
packdir="$(mktemp -d)"
tarball="$packdir/$(npm pack --silent --pack-destination "$packdir" | tail -1)"
if [ -n "$prefix" ]; then
  npm i -g --prefix "$prefix" "$tarball"
else
  npm i -g "$tarball"
fi
echo "installed: $(node -p "require('./package.json').version")"
