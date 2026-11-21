# 桌面主聊天收流回执

在隔离的 Xvfb 中，用开启 Chromium 沙箱的 VCPChat Electron 44.9.3 和真实 CDS 跑通三个主聊天窗口。每个窗口使用独立合成 Profile。桌面主进程通过真实 HTTPS 直连回环合成 SSE 端点，夹具能独立控制原流和 Stop 响应的字节与断开时间。回执包含原请求 ID、运行中源码哈希、任务和 reader 事件、IPC 与 renderer 终态、物理 History 及磁盘待核实记录。[结构化回执](desktop-results.json)

| 场景 | 原流与终态 | 磁盘与重开 |
| --- | --- | --- |
| A · 发出 `[DONE]`，服务端保持连接 | 主进程发出一次 IPC `end`，renderer 发出一次 `completed`。真实 reader 调用 `cancel()` 后解锁，合成端点观察到连接关闭且未主动发送 EOF。 | `history.json` 保存一条用户输入和一条 `completed` 终稿。同一 Profile 重开显示同一条终稿。[重开截图](A-reopened.png) |
| B · 正文可见后切断 TCP | 原流只有正文 delta。主进程发出一次 IPC `error / STREAM_READ_ERROR`，renderer 发出一次 `error`。 | `history.json` 仅保存用户输入。完整已收前缀保存在 `TopicMessageQueue/pending.json` 的 `uncertain.reviewPartial`，状态码为 `MODEL_RESPONSE_INCOMPLETE_REVIEW_REQUIRED`。重开仍在待核实面板显示正文。[重开截图](B-reopened.png) |
| C · 正文可见后点击 Stop，ACK 丢失 | 合成端点接收了相同请求 ID 的 Stop，发送 HTTP 200 和 JSON 首字节后断开 ACK。Stop IPC 返回 `success:false`，任务按 `interrupt-local-fallback` 取消。原 SSE 只有 delta，未收到服务端终态，主进程未发送 SSE 终态 IPC，renderer 发出一次 `failed`。 | `history.json` 仅保存用户输入。部分正文保存在同一待核实机制中，重开仍可见。[重开截图](C-reopened.png) |

三个窗口均在正文可见、收束触发之前核对物理 History 只有用户输入。每个流只发起一次，收束后连接已关闭、reader 已解锁、任务数为零，发送按钮恢复可用。各 Profile 正常退出和重开，磁盘 History 与待核实队列保持一致，未再次调用合成端点。Stop 场景记录的是桌面面对不完整 ACK 和缺失原流终态时的行为，合成回环端点未运行 ToolBox。

使用 Linux x64、Node 24、Xvfb、已构建的 CDS 和启用沙箱的 Electron，从仓库根目录复跑。必要时用 `TMPDIR` 指向短路径，使用 `XVFB_BIN` 和 `ELECTRON_BIN` 指定隔离运行程序。完整合成日志与截图留在命令输出的临时目录。

```sh
node tests/integration/run.cjs desktop-stream-close
```
