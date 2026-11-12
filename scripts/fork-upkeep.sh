#!/usr/bin/env bash
# Keep the trillium fork current with upstream releases.
#   scripts/fork-upkeep.sh [--check] [--tag <tasks-axi-vX.Y.Z>] [--no-verify]
# Detects the newest upstream release tag, rebases our patch stack onto it,
# runs build/lint/test, and sets the version to <upstream>-trillium.<n>.
# --check only reports whether a new upstream release exists.
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/kunchenguid/tasks-axi}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
TAG_PREFIX="tasks-axi-v"
check_only=0; verify=1; want_tag=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_only=1 ;;
    --no-verify) verify=0 ;;
    --tag) want_tag="${2:?--tag needs a value}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"

git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 || git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
git fetch --quiet --tags "$UPSTREAM_REMOTE"

if [ -n "$want_tag" ]; then
  tag="$want_tag"
else
  latest="$(git -c column.ui=never tag --list "${TAG_PREFIX}*" | sed "s/^${TAG_PREFIX}//" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
  [ -n "$latest" ] || { echo "no upstream release tag found" >&2; exit 1; }
  tag="${TAG_PREFIX}${latest}"
fi
upstream_ver="${tag#"$TAG_PREFIX"}"

# A tag already reachable from HEAD means our stack is on it: nothing to rebase.
if git merge-base --is-ancestor "$tag" HEAD; then new=0; else new=1; fi
current="$(node -p "require('./package.json').version")"
echo "upstream_tag: $tag"
echo "current_version: $current"
echo "new_upstream_release: $([ "$new" = 1 ] && echo yes || echo no)"
[ "$check_only" = 1 ] && exit 0

if [ "$new" = 1 ]; then
  [ -z "$(git status --porcelain)" ] || { echo "working tree not clean" >&2; exit 1; }
  # Our patch stack = commits on top of the merge-base with upstream/main.
  base="$(git merge-base HEAD "$UPSTREAM_REMOTE/main")"
  echo "rebasing $(git rev-list --count "$base"..HEAD) commits onto $tag (from $base)"
  git rebase --onto "$tag" "$base" || {
    echo "rebase conflict: resolve, 'git rebase --continue', then re-run this script" >&2
    exit 1
  }
fi

# Version: <upstream>-trillium.<n>. Same upstream keeps its n; a new upstream restarts at 1.
if [[ "$current" == "$upstream_ver-trillium."* ]]; then
  target="$current"
else
  target="$upstream_ver-trillium.1"
fi
if [ "$target" != "$current" ]; then
  TARGET="$target" node -e "const f='package.json',fs=require('fs'),p=JSON.parse(fs.readFileSync(f));p.version=process.env.TARGET;fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
  git commit -q -am "chore: set fork version $target"
fi

if [ "$verify" = 1 ]; then
  pnpm install --frozen-lockfile
  pnpm build
  pnpm lint
  pnpm test
fi
echo "ok: fork at $target on upstream $tag (publish with: git push --force-with-lease origin HEAD)"
