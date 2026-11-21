#!/bin/bash
set -eu
if [[ ${1-} == +1.89.0 ]]; then
  shift
  toolchain=/home/jenn/.cache/agents-os-dev/upstream-20261104/native-cache/rustup/toolchains/1.89.0-x86_64-unknown-linux-gnu/bin
  export RUSTC="$toolchain/rustc"
  exec "$toolchain/cargo" "$@"
fi
exec /usr/bin/cargo "$@"
