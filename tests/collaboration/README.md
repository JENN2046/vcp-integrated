# Collaboration validation

Build the mobile output and install the desktop and server dependencies as
described in the monorepo README. Run the suite with Node 24.

```sh
CHROME_BIN=/opt/google/chrome/chrome node tests/collaboration/run.cjs
```

The runner stages the server in a fresh temporary directory, restricts Node
network calls to loopback, and gives the browser a synthetic profile. It
removes the temporary directory after the run.

The suite exercises the actual server NativeSync modules and SQLite, native
StreamHandler, ToolExecutor, approval manager, distributed routing logic,
desktop services and History queue. The PWA check uses the built mobile app in
Chrome at 390 px over loopback HTTPS and a newly paired read-only session. The
model responses and distributed recipients are local fixtures. The
process-level desktop and server tests live in `../integration`.

The cases are adapted from NativeSync
`7fb8bdbd494a7e5bee2a604b1025857b031f7d02`. The fixtures resolve the monorepo
applications and use the candidate's explicit normal model completion marker.

- `native-sync-groupchat.test.cjs` covers frozen group selection and recovery,
  partial replies, approval, and cancellation after tool dispatch.
- `shared-session-group-observation.test.cjs` covers one native work identity
  across group reconnects and durable History projection.
- `native-sync-mobile-recovery.test.cjs` and
  `shared-session-pwa-group.test.cjs` cover mobile pairing, session authority,
  and observation after reload.
- The TopicSponsor and bridge lifecycle suites cover per-device routing,
  approval, lost receipts, and registration lifecycle.

## Code-change recovery check

`recovery-upgrade.test.cjs` launches fresh worker processes from baseline
`c837e2a7f26453b99b67996b6eb79db94a72c62e` and the current source on the same
synthetic SQLite database and desktop History. It covers a normal baseline
exit, loss of an accepted HTTP receipt, actual SIGKILL after native dispatch,
candidate startup and code-only rollback to the baseline. It verifies the
committed acknowledgements and topic cursor, preserves the original pending
input, and reopens the original native request in its unknown state without
sending another model request. The fixture never edits the stored execution
state directly. The code switch uses a Git archive and local installed
dependencies, with temporary state outside both source trees.
