# 重开发送的 `SOURCE_PATH_ALIAS`

原故障来自同端 `compact-e2e` 的 `A-reopened`。压缩检查点和本地输入已保存。首次重开发送的 server-session 准备调用在本地失败。

原回执位于 `/home/jenn/sc-e2e-sbdQvK/vcp-integration-6V14dy/compact-e2e/events.jsonl` 第 108–115 行，对应 `A-reopened.log` 第 141 行。筛选后的 IPC 记录如下。[原始 IPC 摘录](original-ipc.jsonl)

| 时间（Unix ms） | 同一 Profile 内的事件 |
| --- | --- |
| 1795256397620 | `set-topic-unread` 进入原生桌面 IPC |
| 1795256397628.633618 | `Agents/ns_0e82735f1eb0aae57c9aac9a/config.json.backup` inode 的 ctime |
| 1795256397632 | `localOnly:true` 阶段成功 |
| 1795256397634 | `serverSession:true` 阶段进入桌面 IPC |
| 1795256397634.633576 | `Agents/ns_0e82735f1eb0aae57c9aac9a/config.json` 新 inode 的 ctime |
| 1795256397635 | server-session 阶段返回 `SOURCE_PATH_ALIAS` |

原生 `set-topic-unread` 调用 `AgentConfigManager.updateAgentConfig`，先以原子 rename 替换备份，再替换主配置。服务端会话走 `prepareSharedSend → SharedSessionClient.prepare/context → SharedConfigReplica.scanNative → SharedRuntime.readLocal → ownedJson → assertHistoryPath → plain`。原 case 的代码只回传错误码。文件时标与重开发送入口的只读调用跟踪把故障定位到主配置。结束后的合成 Profile 中，主配置及 History 均为单链接常规文件。[原生未读 IPC](../../../../apps/desktop/modules/ipc/chatHandlers.js#L1800) · [配置原子写入](../../../../apps/desktop/modules/utils/agentConfigManager.js#L190) · [路径检查](../../../../apps/desktop/modules/services/nativeSync/sourceDirectory.js#L5)

Linux 在文件名解析出旧 inode 后，允许与之并发的 rename 替换该文件名。旧 inode 若失去最后一个链接，`lstat` 可以成功返回 `nlink=0`。旧检查将其归类为路径别名。独立隔离验证使用真实 `AgentConfigManager.updateAgentConfig` 对 `Agents/synthetic/config.json` 执行 1,000 次未读标记替换，同时八个读取循环执行产品的 `assertHistoryPath` 和文件读取。只读探针捕获了旧 inode 的 `nlink=0`，重新从同名路径观察到另一个 inode 且 `nlink=1`。基线 `941fb8149b75` 出现 7 次 `SOURCE_PATH_ALIAS`，候选同样观察到 7 次瞬态旧 inode，别名错误为 0 次。[Linux 竞争回执](isolated-race.jsonl)

候选只在普通文件首次返回 `nlink=0` 时重新对当前路径执行一次 `lstat`，用原有类型和链接数要求判定结果。硬链接、符号链接和占位目录仍返回 `SOURCE_PATH_ALIAS`。回归测试用真实原子写入并保留旧 inode 的句柄，固定竞争顺序。Linux x64、Node 24.22.1 下专用回归、配置权威与 History 生命周期共 42 项通过。[回归测试](../../../../apps/desktop/tests/source-path-alias.test.cjs)

```bash
node --test apps/desktop/tests/source-path-alias.test.cjs apps/desktop/tests/f06-config-authority.test.cjs apps/desktop/tests/f06-history-lifecycle.test.cjs
```
