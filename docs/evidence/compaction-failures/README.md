# 同端压缩两起故障的复现与修复

两起错误均在隔离桌面宿主复现。以 `941fb8149b75` 为基线，只改桌面端的路径检查和活跃压缩准备登记时机。原有同端、跨端用例和断言继续使用。[宿主差异](host.patch)

| 原故障 | 谁作出判定 | 修复 |
| --- | --- | --- |
| 同端重开后，首次发送返回 `SOURCE_PATH_ALIAS`，尚未接纳 Work | `sourceDirectory.plain` 检查共享 Agent 的 `config.json`。原生未读状态更新会用原子换名替换该文件。Linux 的路径查询可能刚取得旧 inode，它的链接数已经降到 0。旧检查将其判作别名。 | 仅在普通文件首次返回零链接时，按原路径再查一次。再次检查仍要求类型正确、普通文件链接数恰好为 1。 |
| A 点击压缩后，准备 IPC 返回 `SHARED_COMPACTION_SUPERSEDED` | 中央库只收到 A 的一个准备，紧随其后的是同一 A、同一意图 ID 的取消。A 的后台恢复在准备回执落盘期间把这条仍在使用的记录当成了遗留准备。服务端读取输入时看到 `cancelled`，返回该错误码。 | 在准备条目对恢复流程可见前，即登记它的活跃 ID。进程真正重开后，没有活跃持有者的遗留准备仍会取消。 |

**路径归因的证据边界。** 原故障 IPC 只记录了错误码。原 Profile 的配置文件换名时间与发起发送吻合；重开后的读取跟踪定位到共享 Agent 配置。零链接 inode 及其替换者来自本轮 Linux 复现。[原 IPC、文件时序和并发读取](alias/README.md) · [原压缩意图与取消回执](intent/README.md)

## 在 Electron 重现两种故障

每一组都运行真实的 `compact-e2e`、ToolBox 与回环合成 Provider。每个故障对照只切换被测模块的基线或候选实现。测试探针放大指定竞争窗口，原用例照常核验压缩、落盘和下一次发送。

- 路径对照让重开发送的配置读取与真实 `set-topic-unread` 写入同时进行。探针对该文件重复发起操作系统的 `lstat`，在看到零链接旧 inode 时把这次实测结果交给路径检查。基线报原错误，已保存检查点，新增共享会话 Work 为 0。候选看到同样的零链接值后读回单链接的新文件，重开后的两次发送均完成。另一次不固定调度的 Linux 文件竞争和真实硬链接、符号链接、目录占位负例见路径专项回执。[Electron 前后对照](alias/desktop-comparison.json)
- 意图对照在正在持久化对应准备回执时调用既有的恢复流程。基线取消活跃准备，摘要 Provider 调用 0 次。候选保住准备，摘要调用 1 次、检查点 1 个，随后重开并完成两次发送。[Electron 前后对照](intent/desktop-comparison.json)

## 正常入口验收

两次独立同端运行与一次跨端运行均通过。三次都记录了各 Electron 进程实际加载的两个宿主文件的 SHA-256，保留了原始回执的位置与摘要。[逐次请求、检查点和 Work 回执](acceptance.json)

| 场景 | 结果 |
| --- | --- |
| A 压缩并正常退出，同一 Profile 重开后发送两次 | 每次运行只生成一个检查点；原 History 和 Journal 前缀保留。两次发送各对应一个完成的 Work、一次派发；实际 handler 与 Provider 请求中的原检查点均恰好一次。 |
| A 提交检查点后退出，B 重开同话题发送并丢接纳回执 | B 凭原请求 ID 找回同一个已完成 Work。发送 POST、原生派发、工具执行各一次。Provider 首轮与工具续轮均只含一个原检查点，旧正文出现零次。B 再次重开，检查点、输入和回复的 DOM ID 均可核对。 |

Node 24 原生套件 229/229，桌面压缩、路径及共享压缩输入定向测试 75/75。以下命令使用仓库已有的隔离工具链和可启动的 Electron 沙箱。

```sh
node --test apps/desktop/tests/source-path-alias.test.cjs tests/native/shared-compaction-input.test.cjs
node tests/integration/run.cjs compact-e2e
node tests/integration/run.cjs compact-cross-device
```
