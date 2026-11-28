#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || ( "$1" != full && "$1" != readonly ) ]]; then
    echo 'Usage: scripts/package-core-native-memory.sh full|readonly /absolute/output.tar.gz' >&2
    exit 1
fi
profile=$1
output=$2
[[ $output = /* && $output = *.tar.gz && ! -e $output ]]
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
git diff --quiet HEAD -- apps packages scripts
commit=$(git rev-parse HEAD)
epoch=$(git show -s --format=%ct "$commit")
stage=$(mktemp -d)
archive=$(mktemp -- "${output}.XXXXXX")
trap 'rm -rf -- "$stage"; rm -f -- "$archive"' EXIT

git archive "$commit" | tar -xf - -C "$stage"
# Only these generated build assets are included. Dependencies install from the committed locks.
assets=(
  apps/server/rust-vexus-lite/vexus-lite.linux-x64-gnu.node
  apps/server/Plugin/NativeSync/mobile-dist
  apps/desktop/modules/services/chatDataService/bin/linux-x64
)
for asset in "${assets[@]}"; do
    [[ -e "$asset" && ! -L "$asset" ]]
    cp -a -- "$asset" "$stage/$(dirname "$asset")/"
done

if [[ $profile == readonly ]]; then
    for file in apps/server/Plugin/NativeSync/sync/releasePolicy.cjs apps/desktop/modules/services/nativeSync/releasePolicy.cjs; do
        sed -i 's/sharedReadOnly:false/sharedReadOnly:true/; s/sharedControlledText:true/sharedControlledText:false/' "$stage/$file"
        grep -q 'sharedReadOnly:true' "$stage/$file"
    done
fi

(
    cd "$stage"
    printf 'commit=%s\nprofile=%s\n' "$commit" "$profile" > RELEASE
    find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS
    tar --sort=name --numeric-owner --owner=0 --group=0 --mtime="@$epoch" -cf - .
) | gzip -n > "$archive"
mv -- "$archive" "$output"
