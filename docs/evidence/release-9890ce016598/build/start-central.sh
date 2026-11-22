#!/usr/bin/env bash
set -euo pipefail
evidence=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
candidate=$1
mode=${2-}
export PATH="/home/jenn/.nvm/versions/node/v24.22.1/bin:$PATH"
cd "$candidate"
control="$candidate/.runs/central.fifo"
mkdir -p .runs
mkfifo -m 600 "$control"
exec 3<>"$control"
args=()
if [[ $mode == stream ]]; then args+=(--stream); fi
preload=()
if [[ ${NS_RELEASE_EMPTY_WATCHER-0} == 1 ]]; then
  preload+=(--require "$evidence/empty-watcher-preload.cjs")
fi
node "${preload[@]}" tests/hardware/coordinator.cjs "${args[@]}" <&3
