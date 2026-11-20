#!/usr/bin/env bash
set -euo pipefail

server=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
vexus="$server/rust-vexus-lite"
target="$vexus/target"

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]] || ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    echo "This build entry point requires Linux x64 with glibc." >&2
    exit 1
fi

cargo +1.89.0 build --locked --manifest-path "$vexus/Cargo.toml" --target-dir "$target"
install -m 0644 "$target/debug/libvexus_lite.so" "$vexus/vexus-lite.linux-x64-gnu.node"
node - "$vexus" <<'JS'
const assert = require('node:assert/strict');
const { VexusIndex, NativeKnowledgeRuntime, VexusWatcher } = require(process.argv[2]);
const runtime = new NativeKnowledgeRuntime(new VexusIndex(4, 16));
const { abiVersion, capabilities } = runtime.capabilities();
assert.equal(abiVersion, 2);
assert.ok(capabilities.includes('river.warped-production.v1'));
assert.equal(typeof VexusWatcher, 'function');
console.log('Vexus Linux x64 GNU addon built and checked against the native runtime ABI.');
JS
