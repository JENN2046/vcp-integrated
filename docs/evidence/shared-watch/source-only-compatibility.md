# Source-only compatibility

## Node 22 comparison

The watch candidate passed 21 of 27 tests from the existing NativeSync Source-only suites. Two Chromium tests were skipped because `NATIVESYNC_PWA_DIST` was unset. All four remaining failures reproduced with the Source-path modules loaded from pre-watch commit `b4a501b`. The baseline run targeted those four cases.

The run used the integrated desktop and server modules, Node 22.23.1, loopback HTTP, and synthetic fixtures. The candidate Source-path modules are included in `ecc6bff`. The later read-only registry refinement applies to Shared mode.

| Suite and case | Candidate | Baseline |
| --- | --- | --- |
| Source data compatibility, bulk response deadline | `NETWORK_UNAVAILABLE` instead of the expected malformed-response code in the legacy response mock | Same |
| Source execution wiring, portable single execution | `WAIT_TIMEOUT portable execution` | Same |
| Source execution wiring, group member ownership | `WAIT_TIMEOUT source group` | Same |
| Source execution wiring, effective-rule reader | `HISTORY_SCOPE_TRANSITION_PENDING` | Same |

Run from the sibling `NativeSync` checkout. Point `NATIVESYNC_TEST_HOSTS` to a temporary directory whose `VCPChat` and `VCPToolBox` symlinks resolve to `vcp-integrated/apps/desktop` and `vcp-integrated/apps/server`.

```sh
NATIVESYNC_TEST_HOSTS="$test_hosts" node --test \
  tests/source-data-compatibility.test.cjs \
  tests/multi-source-directory.test.cjs \
  tests/source-execution-wiring.test.cjs
```

For the baseline rerun, a temporary Node preload supplied each listed module from `git show b4a501b:<path>`, keeping its integrated filename for relative imports.

- `apps/desktop/modules/services/nativeSync/{runtime,adapter,attachmentWork,syncRequest}.js`
- `apps/server/Plugin/NativeSync/sync/httpService.js`

```sh
NATIVESYNC_TEST_HOSTS="$test_hosts" NODE_OPTIONS="--require=$baseline_preload" \
  node --test \
  --test-name-pattern='bulk deadline covers source body reads|source-authorized portable snapshots|source-authorized group members|runtime forwards the native effective-rule reader' \
  tests/source-data-compatibility.test.cjs tests/source-execution-wiring.test.cjs
```

## Node 24 and built PWA

Node 24.22.1 uses the repository's supported Node major. Both the candidate (`5a3ad2b`) and baseline used the same built PWA from `apps/server/Plugin/NativeSync/mobile-dist`, Puppeteer 25.16.0 from the integrated server dependencies, and Google Chrome 158.0.8127.36. The PWA source and build scripts are unchanged between `b4a501b` and `5a3ad2b`.

The unmodified candidate suite passed **22 of 27**, with **5 failures and no skips**. The six-case targeted baseline passed the source filter and reproduced all five candidate failures.

| Node 24 comparison | Candidate | Pre-watch baseline |
| --- | --- | --- |
| Full Source-only suite | 22 passed, 5 failed, 0 skipped | Only the six cases below were rerun |
| Browser, separate same-name agents and retain per-topic drafts | PASS | PASS |
| Browser, read-only desktop references and paged history | Old `.topic-detail` copy assertion failed after the reference card and disabled composer checks passed | Same |
| Four non-browser failures listed above | Same failure codes and messages as Node 22 | Same |

A temporary diagnostic preload adapted only the old fixture inputs and assertions. All three diagnostic cases passed on the intact candidate product code. The browser case waited for the current `DESKTOP_CONTEXT_REQUIRED` copy and completed all its original assertions for references, paged history, and zero sends. The portable single and group cases completed after their synthetic provider responses included the required `finish_reason: 'stop'`. These three diagnostic passes are separate from the 22 passes in the unmodified suite.

Use the same suite command and baseline preload above with the Node 24 executable and the two browser fixture variables.

```sh
export NATIVESYNC_PWA_DIST="$integrated/apps/server/Plugin/NativeSync/mobile-dist"
export NATIVESYNC_PUPPETEER="$integrated/apps/server/node_modules/puppeteer"
node --version  # v24.22.1
```

The targeted Node 24 baseline selection added `|Chrome` to the test name pattern and included `tests/multi-source-directory.test.cjs`. Physical devices were outside both runs.
