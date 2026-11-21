# B 在最终模型回执抵达前退出

基线为 `2a36b507543287350a21d01ce9b29ccc3d970379`。测试运行真实 VCPChat Electron 44.9.3（Chromium 沙箱开启）、CDS、VCPToolBox、SQLite 和 Xvfb。所有数据来自彼此隔离的合成 Profile，模型由回环 Provider 提供。A 的合成计数工具经原生工具链调用，实际落盘一次，已确认的工具回执进入压缩检查点。B 通过恢复已被服务端接受的接管取得原 Work，再执行 generation 1。四组均实测 Provider 已收到 generation 1 请求后，B 通过桌面正常退出入口以状态码 0 离开，CDS 与进程组均退出。同一 B Profile 先连接原 ToolBox 重开，再连接被强停后重启的 ToolBox 做对照。

| 窗口 | B 重开，原 ToolBox 仍运行 | ToolBox 重启后 | 结果 |
| --- | --- | --- | --- |
| B 先退出，Provider 后结束 | ToolBox 发出完整 HTTP 200 和 `stop`。原 Work 为 `dispatched`，B 原生请求为 `model_terminal`，`native_terminal=1`。B 显示「原任务需要核对」，Journal、物理 History 与聊天界面缺少最终回复。 | 原 Work 进入 `review_required`，最终回复仍缺失。 | FAIL |
| ToolBox 先结束，B 尚未收到字节即退出 | ToolBox 在 B 退出前已发出完整 HTTP 200 和 `stop`，原生请求已记录 `model_terminal`。B 重开后的状态与上一组一致。 | 原 Work 进入 `review_required`，最终回复仍缺失。 | FAIL |
| ToolBox 先结束 SSE，B 尚未收到字节即退出 | 代理收到完整 HTTP 200、`stop` 和 `[DONE]`。原 Work 未结清，聊天历史无最终气泡。B 的原生观察预览仍可显示全文，标题显示「原生执行中」。 | 原 Work 进入 `review_required`。观察预览提示「部分实时输出暂不可恢复，完整结果以最终历史为准」，历史仍缺终稿。 | FAIL |
| Provider 未返回终态，B 退出导致实际断流 | Provider 连接终止时未发出回复。原 Work 为 `review_required`，B 原生请求为 `unknown`，`native_terminal=0`。B 显示「原任务需要核对」，继续按钮禁用。 | 状态保持，无终稿。 | PASS |

三次产出完整模型回复的采样里，B 的回程连接发送了 **0 个响应字节**。ToolBox 原生续接档案中的 `assistant` 保留了全文，`completion` 字段缺失，原 Work 的最终 Journal 记录也缺失。基线只证明 ToolBox 收到和发出了合法终态，以及保留了正文片段，尚未形成能让原 Work 自动结清的权威记录。工具计数保持 1，Provider 收到 A 初始、摘要、B 最终请求各 1 次，未观察到 B 提交最终回复或重开后重新派发。

- [A 已确认工具回执](A-confirmed-tool.png) · [B 已派发，退出前](B-dispatched-before-quit.png)
- ToolBox 在 B 退出后收到模型终态。[回执](lost.json) · [B 单独重开](lost-B-same-toolbox.png) · [ToolBox 重启后](lost-B-restarted-toolbox.png)
- ToolBox 在 B 退出前已收到模型终态。[回执](terminal-before-quit.json) · [B 单独重开](terminal-before-quit-B-same-toolbox.png)
- ToolBox 在 B 退出前已发出 SSE 终态。[回执](sse-terminal-before-quit.json) · [B 单独重开及实时预览](sse-terminal-before-quit-B-same-toolbox.png) · [ToolBox 重启后](sse-terminal-before-quit-B-restarted-toolbox.png)
- Provider 未发终态。[回执](unknown.json) · [B 单独重开](unknown-B-same-toolbox.png) · [ToolBox 重启后](unknown-B-restarted-toolbox.png)

B 重开后先等待应用加载、CDS 子进程启动、原共享话题选中及物理 History 投影，再等待 1.6 秒（控制面板轮询间隔为 1.5 秒）。保留原 ToolBox 时，另点击面板的「核对任务」，确认 `native-sync:executions` 调用返回并显示最新 Work 状态后记录。该操作前后的原 Work 状态一致，期间没有模型派发。ToolBox 重启后的对照也等待话题选中、History 投影及 1.6 秒。结论限于这些观察点。

## 复跑

在已构建的集成仓库根目录使用 Node 24、Xvfb 与带系统沙箱的 Electron。可设置 `TMPDIR`、`XVFB_BIN` 与 `ELECTRON_BIN` 选择运行环境。工具回执、接管、生成和重开均通过实际桌面入口验证，代理只控制本地 HTTP 传输，用只读方式核对 SQLite 和合成 Profile。

```bash
node tests/integration/run.cjs tool-handoff
node tests/integration/run.cjs tool-final-receipt-lost
VCP_TEST_TERMINAL_BEFORE_CLOSE=1 node tests/integration/run.cjs tool-final-receipt-lost
VCP_TEST_FINAL_STREAM=1 VCP_TEST_TERMINAL_BEFORE_CLOSE=1 node tests/integration/run.cjs tool-final-receipt-lost
node tests/integration/run.cjs tool-final-receipt-unknown
```

`tool-handoff` 是 B 正常接收模型终态的已通过对照。三个 `tool-final-receipt-lost` 采样 在基线都应触发产品结果断言，因为重开后原 Work 未完成，三个可见位置均缺少原请求正文。运行目录中留有完整合成证据及运行日志，仓库回执保留用于复核的业务状态、物理 History、Journal、传输时序、进程退出记录及已加载的源码哈希。
