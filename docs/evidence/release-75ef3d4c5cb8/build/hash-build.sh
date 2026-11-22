#!/usr/bin/env bash
set -euo pipefail
cd "$1"
sha256sum \
  apps/{desktop,server,mobile}/package-lock.json \
  apps/desktop/rust_chat_data_service/Cargo.lock \
  apps/server/rust-vexus-lite/Cargo.lock \
  apps/desktop/node_modules/electron/dist/electron \
  apps/desktop/modules/services/chatDataService/bin/linux-x64/vcp_chat_data_service{,.authority.json} \
  apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  apps/server/rust-vexus-lite/vexus-lite.linux-x64-gnu.node \
  apps/{desktop/modules/services/nativeSync,server/Plugin/NativeSync/sync}/contracts.generated.cjs \
  apps/{desktop/modules/nativeSyncSettings,mobile/src}/contracts.generated.js \
  apps/desktop/modules/nativeSyncDesktopRuntime/agentNameOwner.cjs \
  apps/desktop/modules/tavernRulesEngine.js \
  apps/desktop/modules/renderer/{toolBatchRegions,toolResultRegions,markdownCodeDomainScanner}.js \
  apps/desktop/preloads/bundled/BUILD-MANIFEST.json \
  apps/desktop/preloads/bundled/dist/{chat,auxiliary-chat,utility,desktop}.cjs
find apps/server/Plugin/NativeSync/mobile-dist -type f -print0 | sort -z | xargs -0 sha256sum
