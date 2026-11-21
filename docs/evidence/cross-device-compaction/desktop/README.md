# 共享单聊跨端检查点与丢回执恢复

在 Linux x64 上运行两个启用 Chromium 沙箱的 VCPChat 44.9.3 进程，分别使用独立的合成 Profile 和设备身份。两个进程连接同一套隔离的 VCPToolBox 与 SQLite。模型端点返回确定性的合成数据，工具经真实 ToolBox 执行并写入本次运行独立的计数文件。

1. B 打开共享单聊，确认压缩前历史可见，然后正常退出。
2. A 从原生消息菜单点击「压缩前文」。VCPToolBox 提交唯一检查点后，A 正常退出。一条先写入 Journal 的前文有约五分钟的显示时差，时间戳比检查点晚。
3. B 用自己的原 Profile 重开，显示 A 的检查点，通过正常发送按钮提交新输入。代理收到服务端成功接纳的响应后切断连接，并暂时拦住该请求的状态查询。B 保留同一 request ID 的待确认本地意图。
4. 原 Work 完成后，B 正常关闭，再用原 Profile 重开。B 的恢复查询返回原 Work 和原 request ID，状态为 `completed`。B 无需刷新即显示检查点、原输入和原回复，历史加载报错与待确认提示均已清除。中央接纳主体为 `desktop:deviceB`。发送 POST、Work、原生派发与真实工具写入各一次。Provider 首轮和工具结果续轮各一次。

| 实际模型输入 | 基线 `63b2fe70da9e` | 候选 |
|---|---|---|
| 原生 handler | 检查点 1 次，已压缩旧正文 1 条 | 检查点 1 次，已压缩旧正文 0 条 |
| Provider 首轮 | 同一条已压缩旧正文进入请求 | 检查点 1 次，已压缩旧正文 0 条 |
| Provider 工具结果续轮 | 同一条已压缩旧正文继续出现 | 检查点 1 次，已压缩旧正文 0 条；保留工具执行结果 |

两组都保留 B 的新输入和原 Journal 内容。回执含实际请求、序号、Work、工具调用和加载模块的 SHA-256。基线和候选均用同一类合成流程，基线先建立了接纳、恢复和工具次数，再因输入泄漏断言失败。

[基线回执](baseline.json) · [候选回执](candidate.json)

[开始前 B 的 History](B-before-A-compaction.png) · [A 提交检查点](A-checkpoint-committed.png) · [B 重开](B-reopened-with-A-checkpoint.png) · [丢回执](B-receipt-lost-after-tool.png) · [找回 Work](B-recovered-original-work.png)

候选在独立的第二套合成 Profile 与数据库中再次通过。第二次的原 Work ID 为 `request_2d69fa0a513b4d92b7e1fc4cc6ad3784`。Provider 首轮及工具结果续轮各 1 次，真实工具写入 1 次。重开后可见的检查点、输入和回复 ID 依次为 `checkpoint_compact_d4bcde679eb83ed94f3f5b76ef65bd41618ce025`、`msg_1795256723781_user_8fh2dl4i9r`、`reply_request_2d69fa0a513b4d92b7e1fc4cc6ad3784`，历史加载报错与待确认提示均已清除。两次加载的服务端关键文件和桌面主进程文件 SHA-256 一致。

## 复跑

按仓库说明安装锁定依赖并生成宿主运行产物。在 `vcp-integrated` 根目录用 Node 24 运行 `node tests/integration/run.cjs compact-cross-device`。夹具使用 Xvfb、真实 Electron 和临时仓库外 Profile。可用 `TMPDIR`、`XVFB_BIN`、`ELECTRON_BIN` 指定本地工具位置。

基线复跑使用 `63b2fe70da9e` 的干净 worktree，复制本轮 `tests/compact-e2e` 和 `tests/integration` 测试改动并生成同版本运行产物。测试应在排除已压缩文字的断言处失败。本次证据使用 Node 24.22.3 和 loopback 合成 Provider。
