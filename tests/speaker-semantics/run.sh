#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
repo="$PWD"
export NS_GROUP_BASELINE_REVISION=4d8b67ce316160f0c84cae0f1b554c7bb60d20a2
export NS_GROUP_CAPTURE="$repo/tests/speaker-semantics/server-capture.cjs"
export NS_GROUP_FIXTURE="$repo/tests/speaker-semantics/input.json"
watcher_fixture=./docs/evidence/three-client-candidate/build-linux/empty-watcher-preload.cjs

case "${1:-}" in
  candidate)
    exec node --require "$watcher_fixture" tests/group-context/run.cjs candidate
    ;;
  baseline)
    ;;
  *)
    echo "Usage: bash tests/speaker-semantics/run.sh <baseline|candidate>" >&2
    exit 2
    ;;
esac

mkdir -p .runs/group-context
baseline_dir="$(mktemp -d "$repo/.runs/group-context/speaker-baseline-XXXXXX")"
git archive "$NS_GROUP_BASELINE_REVISION" apps/desktop packages/core-rules | tar -x -C "$baseline_dir"
desktop="$baseline_dir/apps/desktop"
mkdir -p "$desktop/node_modules/@vcp" "$desktop/modules/services/chatDataService/bin"
for dependency in "$repo/apps/desktop/node_modules/"*; do
  if [ "${dependency##*/}" != @vcp ]; then
    ln -s "$dependency" "$desktop/node_modules/${dependency##*/}"
  fi
done
ln -s "$baseline_dir/packages/core-rules" "$desktop/node_modules/@vcp/core-rules"
ln -s "$repo/apps/desktop/modules/services/chatDataService/bin/linux-x64" "$desktop/modules/services/chatDataService/bin/linux-x64"
(
  cd "$desktop"
  node scripts/build-shared-renderer-rules.cjs
  node scripts/build-portable-agent-owner.cjs "$desktop"
  node scripts/build-sandbox-preloads.cjs "$desktop"
)
node --require "$watcher_fixture" tests/group-context/run.cjs baseline "$baseline_dir"
