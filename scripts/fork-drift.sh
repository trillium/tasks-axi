#!/usr/bin/env bash
# Report per host whether the installed tasks-axi is the fork build
# (has dist/src/backends/beads.js). Exit 1 if any host drifted.
#   scripts/fork-drift.sh [host ...]     (default: macbook mini0 mini1 mini3 lnx)
set -uo pipefail
hosts=("$@"); [ ${#hosts[@]} -gt 0 ] || hosts=(macbook mini0 mini1 mini3 lnx)

probe='
bin=$(command -v tasks-axi) || { echo "missing - -"; exit 0; }
real=$(node -e "console.log(require(\"fs\").realpathSync(process.argv[1]))" "$bin")
pkg=$(dirname "$(dirname "$(dirname "$real")")")
ver=$(node -p "require(\"$pkg/package.json\").version" 2>/dev/null || echo ?)
if [ -f "$pkg/dist/src/backends/beads.js" ]; then echo "fork $ver $pkg"; else echo "STOCK $ver $pkg"; fi'

rc=0
for h in "${hosts[@]}"; do
  if [ "$h" = "$(hostname -s)" ] || [ "$h" = local ]; then
    out=$(bash -lc "$probe" 2>&1)
  else
    out=$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$h" "bash -lc '$probe'" 2>&1) || out="unreachable - -"
  fi
  read -r state ver where <<<"$(printf "%s\n" "$out" | tail -1)"
  [ "$state" = fork ] || rc=1
  printf '%-8s %-12s version=%-18s %s\n' "$h" "$state" "$ver" "$where"
done
exit $rc
