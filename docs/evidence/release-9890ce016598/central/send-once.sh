#!/usr/bin/env bash
set -euo pipefail
candidate=$1
run=$2
evidence=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
jq -e '.work == [] and .journal == [] and .totalProviderRequests == 0' "$run/status.json" >/dev/null
cp "$run/status.json" "$evidence/pre-send.json"
printf 'send\n' > "$candidate/.runs/linux-initial.fifo"
for ((attempt=1; attempt<=100; attempt++)); do
  if jq -e '.work|length==1 and .[0].state=="running"' "$run/status.json" >/dev/null &&
      jq -e '.providerCalls==1 and .totalProviderRequests==1' "$run/status.json" >/dev/null; then
    printf 'release\n' > "$candidate/.runs/central.fifo"
    break
  fi
  sleep 0.15
done
test "$attempt" -le 100
for ((attempt=1; attempt<=100; attempt++)); do
  if [[ -f "$run/work-completed.json" ]]; then
    cp "$run/work-held.json" "$evidence/work-held.json"
    cp "$run/work-completed.json" "$evidence/work-completed.json"
    jq -e '.totalProviderRequests == 1 and .providerCalls == 1 and (.work | length == 1 and .[0].state == "completed" and .[0].attempts == 1 and .[0].request_dispatched == 1) and (.journal | length == 2)' "$evidence/work-completed.json" >/dev/null
    exit 0
  fi
  sleep 0.15
done
exit 1
