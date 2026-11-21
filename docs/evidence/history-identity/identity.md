# Shared History 文件身份

## 原故障

隔离验收 `compact-cross-device` 的原件位于 `/home/jenn/ns-tool-handoff.GCd8v5/vcp-integration-8x1fgn/compact-cross-device`。受影响的是设备 A 的 `profile-A/UserData/ns_eacc962a8dfc681fb4f70cd7/topics/ns_d0ea333d16dc4d659817258b/history.json`。该 Profile 中只有这份 History 含本轮原生压缩检查点。

| `events.jsonl` 时间（毫秒） | 设备 A 事件 |
| --- | --- |
| 1795258678725 | `native-sync:compact-commit` |
| 1795258678771 | 两次 `history-file-updated` |
| 1795258678772 | 请求 `native-history:snapshot` |
| 1795258678780 | `compact-commit` 返回 `HISTORY_IDENTITY_CHANGED` |
| 1795258678783–8784 | 又两次 `history-file-updated` |

事后 `lstat` 记录为 `dev=66315 ino=111448309 nlink=1`，mtime 为 2026-11-21 18:57:58.777667213 +0800。原始故障记录没有失败读的 `lstat`、`fstat` 或 rename 调用栈，无法从该次记录确认具体是哪一轮投影更换了 inode。原件以只读方式核对。

## 执行路径和复现

基线 `95311dea107fc5e273997ee88e9ae82f789bc05f` 中，`compact-commit` 的 `syncExecutionTopic → verifyHistory` 和返回结果两处都从 `SharedQueue.read → HistoryMutationQueue.read → inspect` 读取。原生 `native-history:snapshot` 已走 `readSnapshot` 进入 topic 队列。同一话题的共享事件经 `NativeSyncAdapter.applyRemote → SharedQueue.mutate → HistoryMutationQueue.#write → durableJson` 在本机落盘。共享事件应用即使因 ACK 已存在而保留相同消息数组，也会经既有 `mutate` 发布 History。该发布先 fsync 临时文件，再 rename，因此同一路径可在独立读的 lstat 与 open 之间指向新 inode。

Linux 隔离测试用 `fs/promises.open` 的测试调度点暂停读，保留真实磁盘 lstat、open、fstat 与原生投影 rename。通过本机描述符映射，读写同一份 `UserData/local_agent/topics/local_topic/history.json`。

| 场景 | lstat（dev, ino, nlink） | fstat（dev, ino, nlink） | 结果 |
| --- | --- | --- | --- |
| 基线读取路径横跨宿主的真实原子发布 | 51, 1186833, 1 | 51, 1186834, 1 | `HISTORY_IDENTITY_CHANGED`，发布后的再次读取见检查点 |
| 共享读先取得同一 topic 队列 | 51, 1186843, 1 | 51, 1186843, 1 | 本次读见旧快照，投影完成后下一次读见检查点 |
| 队列外直接替换 | 51, 1186853, 1 | 51, 1186854, 1 | `HISTORY_IDENTITY_CHANGED` |
| lstat 之后创建真实硬链接 | 51, 1186863, 1 | 51, 1186863, 2 | `HISTORY_IDENTITY_CHANGED`，再读为 `UNSAFE_HISTORY_FILE` |

受保护的共享读现在经 `HistoryMutationQueue.readSerialized` 使用同一个物理 topic 队列。已持有该 topic 的调用直接读取，沿用原生队列在 adapter 变更期间的读法。队列外进入复用 `HistoryAuthority.readAfterTransition`，等待正在运行的权威切换并保留关闭拒绝。文件与祖先检查依旧严格，遇到队列外身份更换直接返回原错误。另验证叶子符号链接、祖先符号链接及 Agent/Group 同名所有者冲突，均被拒绝。

## Electron 对照

使用独立 `ELECTRON_BIN` wrapper 运行真实 `compact-cross-device`。探针在设备 A 的压缩提交验证第一次读取已确认的 checkpoint History 时，从独立异步作用域调用同一个 adapter 的 `applyRemote` 重放 seq 9 原事件。旧路径对照仅将 `SharedQueue.read` 的分派恢复到基线的 `native.read`，其余载入同批代码。候选读等待写者入队后继续 open，写者由原生 topic 队列自行推进。探针记录原生 IO 调用和回执，临时 wrapper 未写入运行时或公共验收入口。

| 设备 A | lstat（dev, ino, nlink） | fstat（dev, ino, nlink） | 重放 rename 的目标 inode（前 → 后） | IPC 结果 |
| --- | --- | --- | --- | --- |
| 基线读路径 | 66315, 10663640, 1 | 66315, 10661154, 1 | 10661091 → 10661154 | `HISTORY_IDENTITY_CHANGED` |
| 候选队列读路径 | 66315, 15521801, 1 | 66315, 15521801, 1 | 15521801 → 15522481 | `success: true` |

基线 lstat 之后还有一次并发到达的同 seq 投影，随后受控重放的 rename 发布了 fstat 读到的 inode。候选首次读取持有队列槽，先完成 fstat，重放才执行 rename。两次受控重放的写栈均为 `HistoryMutationQueue.#write → durableJson → fs/promises.rename`，投影回执均为 `captured`。候选的双机验收完整通过。具体文件、顺序和写栈见隔离证据 `.runs/identity-electron.IeQx3G/vcp-integration-{7506Cj,TVhnKe}/compact-cross-device/writer-identity.jsonl`。

在集成仓以 Node 24.22.1 运行 `node --test apps/desktop/tests/history-identity.test.cjs apps/desktop/tests/f06-history-lifecycle.test.cjs`，39/39 通过。单独加载基线的 `SharedQueue` 后，回归用例在共享读未持有同一 topic 队列的断言失败。加入权威切换处理前，在磁盘临时目录运行 `npm run test:native`，230/230 通过。默认 `/tmp` 首轮遇到配额错误及 SQLite 磁盘 I/O 错误。

Node 测试创建的合成 Profile 与临时目录已清理。磁盘复跑的摘要日志留在 `.runs/identity-native.ppYJFf/result.log`。Electron wrapper、两个隔离 Profile 和筛选后的证据仍位于 `.runs/identity-electron.IeQx3G`，保留到本轮结果核对完成。表中 inode 来自所列轮次，重跑会产生不同值。
