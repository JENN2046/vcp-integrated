# Shared group handoff compatibility

Both fixtures reached the first confirmed reply on the current host. The test made independent SQLite backups and opened them through the actual SharedSpace, CentralStore, and SourceCatalog from the af17c99 server tree extracted with git archive. It used a synthetic model completion at the native boundary.

| Combination | Verified result |
| --- | --- |
| Previous host with a current v1 backup | Opened schema 3. Device B took over, explicitly continued, and published the second reply. The original finish command completed the Work and replayed from its receipt. |
| Previous host with a current v2 backup | Rejected schema 4 with SHARED_SCHEMA_UPGRADE_REQUIRED. The Work, executor, native requests, confirmed replies, Journal and receipt count matched their values before the open attempt. |
| v1-only client with v2 Work on the current host | The legacy handoff request and native request preparation both returned SHARED_CLIENT_UPGRADE_REQUIRED. The state and durable records stayed the same. |

Run from the repository root with Node 24 after installing the repository dependencies.

```bash
NS_GROUP_COMPAT_EVIDENCE=docs/evidence/group-plan-handoff/compatibility.json \
  node --require ./tests/collaboration/fixtures/loopback.cjs \
  --test tests/group-member-handoff/compatibility.cjs
```
