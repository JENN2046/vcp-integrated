# Shared group relay browser integration

Run from the integrated checkout with Node 24, the existing locked dependencies, Linux Vexus addon, Chrome, and OpenSSL. The tests launch isolated VCPToolBox on loopback with the real PWA build and a synthetic SSE provider. The provider classifies and counts A, B and C independently by each member's own system prompt.

```sh
npm run build:mobile
node tests/group-relay/run.cjs finish
node tests/group-relay/run.cjs cut
node tests/group-relay/run.cjs crash
```

For the pre-change comparison, build the archived PWA from the same pinned revision as the standalone backend.

```sh
checkout="$PWD"
baseline=$(mktemp -d)
git archive 2c88e4aad704 apps/mobile apps/desktop/modules/nativeSyncSettings \
  apps/desktop/modules/services/nativeSync/sharedEventClient.mjs packages/sync-contracts scripts/build.mjs |
  tar -x -C "$baseline"
ln -s "$checkout/apps/mobile/node_modules" "$baseline/apps/mobile/node_modules"
node "$baseline/scripts/build.mjs" --mobile
node tests/group-relay/run.cjs baseline "$baseline/apps/server/Plugin/NativeSync/mobile-dist"
node tests/group-relay/run.cjs legacy-host "$checkout/apps/server/Plugin/NativeSync/mobile-dist"
```

Each run prints a temporary evidence path. Keep `evidence.json` and selected screenshots. Recordings, logs and SQLite under that path contain synthetic fixtures. The browser witness uses a distinct read-only pairing. Its only write probe invokes the same route explicitly from the fixture to verify authorization rejection. It emits no execution writes through normal UI.

`finish` truncates the backend's successful HTTP response after the server has accepted the command. A reload reads the original Work, and an explicit identical API retry receives the same Work. The provider completes B naturally and the next round goes through the same composer. `cut` closes the real B SSE response before terminal framing. `crash` signals the actual backend process with SIGKILL, reopens both PWA contexts and checks the retained B prefix, gap and review status. Both failure cases verify that History still contains only the user message and A's final, and that no new model call occurs.
