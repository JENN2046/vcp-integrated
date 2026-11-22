#!/usr/bin/env bash
set -euo pipefail
candidate=$1
run=$2
cd "$candidate"
dist=apps/server/Plugin/NativeSync/mobile-dist
origin=https://127.0.0.1:18443
expected=$(find "$dist" -type f | sort)
while IFS= read -r artifact; do
  route=${artifact#"$dist/"}
  if [[ $route == index.html ]]; then route=; fi
  url="$origin/mobile/$route"
  response=$(curl --silent --show-error --fail --noproxy '*' --cacert "$run/hardware-ca.pem" "$url" | sha256sum)
  built=$(sha256sum "$artifact")
  [[ ${response%% *} == "${built%% *}" ]]
  printf '%s  %s\n' "${response%% *}" "$url"
done <<< "$expected"
