# 同端压缩准备被本机恢复流程取消

原隔离运行保存在 `/home/jenn/sc-e2e-YEZ2z0/vcp-integration-JbUd87/compact-e2e`。以下只引用隔离合成数据的操作标识和状态。原文件保留。

| 证据 | 核对结果 |
| --- | --- |
| `events.jsonl` 第 39、63 行 | A 在 `1795256549297` 发出唯一的 `native-sync:compact-prepare` IPC，`1795256549896` 收到 `SHARED_COMPACTION_SUPERSEDED`。第 66 行的退出事件发生在错误之后。 |
| `data/central.sqlite` 的 `shared_receipts` rowid 29 | `desktop:deviceA` 的 `compact_prepare_df8134d6-5921-4829-82e0-f568eac93b15` 接纳成功，准备水位为 8，返回意图 `compact_1eaf1793e2c5a2b25ece5549ae420bd60d6da2a4`，`workId=null`。 |
| 同表 rowid 30 | 同一 `desktop:deviceA` 用 `compact_cancel_compact_1eaf1793e2c5a2b25ece5549ae420bd60d6da2a4` 取消该意图。回执为 `{"success":true,"cancelled":true}`。全表只有这一个压缩准备回执和该取消回执。 |
| 同库的 `shared_compaction_intents` 和 `journal` | 唯一意图为 `cancelled`，`committed_seq` 和 `work_id` 均为 NULL。Journal 最后水位仍为 8，未写检查点。 |
| `profile-A/.native-sync/shared/sharedAB/executions.json` | 本机准备请求还处于 `prepared`，同一准备条目标有 `cancelled:true`，没有压缩发布记录。 |

服务器在读取压缩输入时对任何非 `prepared` 状态返回 `SHARED_COMPACTION_SUPERSEDED`。本次该状态是 `cancelled`。源码中的取消只接受 `prepared`，最终状态加上唯一意图及回执，排除了第二次准备或其他 Work 操作先取代此意图。该次运行的服务端加载记录中 `sharedCompaction.js` 的 SHA-256 是 `3f1037e42efb2bfdd21dd998e5b81b1ebfce81fae13b97c054b5b9223d00467f`，与基线 `941fb8149b75` 相同。

桌面保存 prepare 回执之前会更新内存账本。基线调用方在异步保存结束之后才把服务端意图 ID 登记为活跃。后台执行协调在两者之间检查账本时，会把正要读取输入的准备误判为遗留记录，从同一个桌面身份调用取消。原运行没有记录每次后台协调的时点。隔离用例固定了这个交错，并重现相同服务端错误。

修复在准备条目进入恢复流程可见的内存账本前登记活跃意图 ID。实时准备继续按原顺序持久化，再读取输入。真实遗留准备仍沿用原回收路径。服务端状态机、回执和 Journal 校验未改。

Node 24.22.1 下，同一个并发用例载入基线桌面模块时从真实 SQLite `SharedCompaction.get` 返回 409，候选实现则读回原输入并保留 `prepared`。随后对同一已保存状态模拟重开，验证无活跃持有者时仍会收到取消回执。用例使用合成会话、真实共享服务和 SQLite，在本地持久化等待处固定调度顺序，不需要 Electron 或模型请求。

```bash
node --test --test-name-pattern='live compaction' tests/native/shared-compaction-input.test.cjs
```
