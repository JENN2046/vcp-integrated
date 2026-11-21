# B 丢失最终响应后的桌面对照

基线以 `5ed51ba784bf029fc0a16896da1d57451a36cb7c` 暂存 ToolBox 源码。候选加载当前工作树，实际加载的源码哈希见[桌面回执](desktop-results.json)。两组使用相同的 VCPChat Electron 44.9.3、CDS、SQLite 和 Xvfb。Chromium 沙箱开启。测试仅使用隔离合成 Profile、回环 Provider 和落盘计数的合成工具。

A 通过桌面提交原 Work，工具回执结清后压缩前文。B 接管的 HTTP ACK 被代理切断，B 从原 Profile 重开后读取原 Work 并继续 generation 1。在模型终态丢失的场景，B 正常退出且 CDS 和 Electron 进程组已退出。B 随后使用同一 Profile 重开两次，先连接原 ToolBox，再连接强停后重启的 ToolBox。

| 场景 | 基线 | 候选 |
| --- | --- | --- |
| B 先退出，ToolBox 后发送 JSON `stop` | 原 ToolBox 上原 Work 为 `dispatched`，重启后为 `review_required`。两次均缺最终气泡、Journal 与 History。 [截图](baseline-json-after-quit.webp) | 两次重开均完成原 Work，最终气泡、Journal 与 History 各一条。 [原 ToolBox](candidate-json-after-quit.webp) · [重启 ToolBox](candidate-json-after-quit-toolbox-restarted.webp) |
| ToolBox 先发送 JSON `stop`，B 在代理交付前退出 | 同上。 [截图](baseline-json-before-quit.webp) | 同上。 [原 ToolBox](candidate-json-before-quit.webp) · [重启 ToolBox](candidate-json-before-quit-toolbox-restarted.webp) |
| ToolBox 先发送 SSE `stop` 和 `[DONE]`，B 在代理交付前退出 | 原 Work 未完成。实时预览能显示正文，最终气泡和持久历史缺失。 [截图](baseline-sse-before-quit.webp) | 两次重开均完成原 Work，最终气泡、Journal 与 History 各一条。 [原 ToolBox](candidate-sse-before-quit.webp) · [重启 ToolBox](candidate-sse-before-quit-toolbox-restarted.webp) |
| B 退出，Provider 未发终态 | 两次均 `review_required`，继续按钮禁用，无最终回复。 [截图](baseline-unknown.webp) | 同上。 [原 ToolBox](candidate-unknown.webp) · [重启 ToolBox](candidate-unknown-toolbox-restarted.webp) |
| B 收到模型响应，`steer-turn-complete` 的 HTTP 200 ACK 丢失 | B 正常退出后重开，恢复原回复一次。 [截图](baseline-publication-ack.webp) | 服务端返回原生已发布的同一条 Journal 回执，标记为 `replayed: true`。B 重开后原回复仍恰好一次。 [截图](candidate-publication-ack.webp) |

三组丢失模型终态的场景，代理没有向 B 发出 HTTP 响应头或正文，也未观察到 B 补交最终回复。基线的原生确认只有 `model_terminal` 和 `native_terminal=1`，无原生完成记录及最终 Journal 条目。候选的持久完成记录绑定原 Work、generation 1、原回复 ID 与 B 执行者，原生结束原因是 `stop`，Journal 和物理 History 中的消息结束原因是 `completed`。原 Work 的 `reply_seq` 与唯一最终 Journal 条目一致。所有通过的场景均只有三次 Provider 请求（A 初始、摘要、B 续接各一次）和一次工具调用。

三个终态丢失的基线运次只触发了预期的产品结果断言。基线与候选均核对实际加载的后端 SHA256。候选按原回复 ID 核对真实聊天气泡，实时预览不计入。回执文件仅保留合成身份、原生确认、传输时序、计数、退出结果和必要源码哈希，截图均来自隔离的桌面。

## 复跑

在已构建的集成仓根目录使用 Node 24、Xvfb 和带 Chromium 沙箱的 Electron。用 `NS_BASELINE_SERVER_REVISION=5ed51ba784bf029fc0a16896da1d57451a36cb7c` 复跑基线，不设置时加载当前工作树中的后端。

```bash
node tests/integration/run.cjs tool-final-receipt-lost
VCP_TEST_TERMINAL_BEFORE_CLOSE=1 node tests/integration/run.cjs tool-final-receipt-lost
VCP_TEST_TERMINAL_BEFORE_CLOSE=1 VCP_TEST_FINAL_STREAM=1 node tests/integration/run.cjs tool-final-receipt-lost
node tests/integration/run.cjs tool-final-receipt-unknown
node tests/integration/run.cjs tool-final-publication-ack
```

本宿主的共享 `/tmp` 用户配额阻止 Xvfb 写入 X11 临时状态。复跑实际在私有挂载命名空间使用临时 `/tmp` 与套件自带 Chromium SUID helper。临时挂载已随进程退出释放，隔离合成运行目录保留在 `/var/tmp` 供本批比对。
