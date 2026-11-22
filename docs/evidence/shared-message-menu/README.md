# 共享助手回复的原菜单编辑与删除

在同一台 Linux 主机上启动两个隔离的 VCPChat Electron 44.9.3 客户端。两端各运行真实 CDS，连接同一个 ToolBox / SQLite。Xvfb 和两个 Electron 客户端均复用仓库的 integration 夹具。模型是确定性的回环 Provider，ToolBox 通过原生插件管理器实际调用隔离的 `OrdinaryToolCounter`，随后模型收到工具结果并生成正式助手回复。基线与候选分别创建相同配置和输入的新合成资料，消息 ID 在每次运行内核对。

| 检查项 | 基线 `1eb2a27` | 候选 |
| --- | --- | --- |
| A 用原右键菜单编辑正式助手回复 | `SHARED_NATIVE_ADMISSION_REQUIRED`，两端保持原内容 | A 和 B 显示已编辑内容，两端 History 持久化同一消息 ID |
| A 用原右键菜单删除并确认 | `EXPLICIT_DELETE_REQUIRED`，A 提前隐藏气泡，B 保持原回复 | A 和 B 移除该气泡，两端 History 只保留原用户消息 |
| A 退出并使用原资料重开 | 助手回复重新出现 | 助手回复维持删除 |
| 中央 Journal | 序号 1、2，编辑和删除均无新行 | 序号 1、2 保持，追加同一回复 ID 的 3 `upsert`、4 `delete`。回复的元数据版本依次为 1、1、0，内容 hash 有变化 |
| 最终同步状态 | 两端 cursor 2 | 两端 cursor 4 |
| 执行次数 | Provider 2，工具调用 1，提交 1，执行尝试 1 | Provider 2，工具调用 1，提交 1，执行尝试 1 |

两次运行最终的 inbox、outbox 和 pending 均为空。点击使用真实 Electron 的鼠标事件。编辑走文字框和原「保存」按钮，删除走原确认框。Probe 只读取中央 SQLite 和磁盘状态，并通过 Electron 读取 DOM 和抓图。验收范围为隔离 Linux 桌面和回环 Provider。逐步快照和实际加载的源码校验值见 [对照回执](./receipt.json)。

- [基线的原右键菜单](./before-menu.png)
- [基线删除被拒后，A 暂时缺少回复](./before-delete-rejected.png)
- [基线 A 重开后恢复了原回复](./before-A-reopened.png)
- [候选 B 显示编辑结果](./after-B-edited.png)
- [候选 B 显示删除结果](./after-B-deleted.png)
- [候选 A 重开后保持删除](./after-A-reopened.png)

在仓库根目录以现有集成环境运行。设 `NS_MENU_BASELINE=1` 验证已固定的 `1eb2a27` 基线，`NS_MENU_BASELINE=0` 验证候选。固定基线用 `git archive 1eb2a27` 作为隔离副本，保留本地已构建依赖，并从候选目录提供同一份 `menu-probe.cjs`。运行两组使用同一 Node 24、Xvfb 与有沙箱的 Electron 二进制。

```bash
NS_MENU_BASELINE=0 node \
  --require ./docs/evidence/shared-watch/fault-probe.cjs \
  --require ./docs/evidence/shared-watch/visibility-probe.cjs \
  --require ./docs/evidence/shared-message-menu/menu-probe.cjs \
  tests/integration/run.cjs lost-only
```

## 普通本机单聊对照

最终组合版本 `9f00f62` 的 A 使用未加入共享空间的本机资料。A 通过原右键菜单编辑正式助手回复，磁盘上的本机 History 保留同一回复 ID 和原用户消息。确认删除后，界面和本机 History 只剩原用户消息。同一资料重开并进入同一个话题后结果保持一致。原发送发生一次本机请求和一次 Provider 调用。此后 Provider 计数保持 1，中央 Journal、Work、共享原生请求、共享提交与准入均为 0。 [本机逐步回执](./local-receipt.json) · [编辑后](./local-menu-edited.png) · [重开后](./local-menu-reopened.png)

```bash
node --require ./docs/evidence/shared-message-menu/local-menu-probe.cjs \
  tests/integration/run.cjs local-only
```
