#!/usr/bin/env bash
set -euo pipefail
evidence=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
candidate=$1
run=$2
stage=$3
export PATH="/home/jenn/.nvm/versions/node/v24.22.1/bin:$PATH"
cd "$candidate"
control="$candidate/.runs/linux-$stage.fifo"
mkfifo -m 600 "$control"
exec 3<>"$control"
node "$evidence/linux-source-receipt.cjs" "$run" <&3
