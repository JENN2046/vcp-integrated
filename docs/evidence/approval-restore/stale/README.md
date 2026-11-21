# 已失效的原审批

在 Linux x64 的隔离运行中，用 Electron 44.9.3 和真实 VCPChat、CDS、ToolBox 发送共享消息。Provider、工具、桌面 Profile 和手机配对均为合成夹具。每次只启用一台可审批的桌面。Chrome 的 390 × 844 PWA 通过正常配对入口获得该共享空间的只读 Cookie。

桌面看到原生审批卡后退出，原 Work 仍在等待。取消场景经原 Work 所有者的正常 HTTP 命令取消。超时场景等待 ToolBox 自身的审批计时器，夹具通过原生配置将时长设为 18 秒。两个场景均等到原 Work 达到终态才重新打开原 Profile。重新打开的桌面没有原审批卡。用桌面已鉴权的 VCPLog 通道尝试发送一次原审批 ID 的迟到允许答复，客户端确认已入发送队列。原 Work、原生请求和 Journal 保持原身份，工具计数器与共享调用账本均记录零次工具调用。

基线复用同一桌面和 PWA，对照 ToolBox 来自 `fb742edb8513eded7bd46d78124c4800edb9fda1`。候选与基线均保有失效审批防护。取消结果为 `review_required`，只有原用户消息和一次 Provider 请求。自然超时后，原生工具审计记录失败超时，Provider 正常续写并提交说明，原 Work 为 `completed`。迟到允许未增加 Provider 请求、Journal 行或工具调用。

PWA 在等待期间显示原生审批状态，隐藏原审批 ID、工具参数和操作控件，发信禁用。终态也不显示审批 ID，PWA 在正常观察过程中没有提交执行写请求。超时终态的已提交回复可以包含原生工具超时摘要。

- [四组结构化回执](receipt.json)
- [桌面原审批卡](desktop-pending.png) · [取消后重开](desktop-reopened-cancelled.png) · [自然超时后重开](desktop-reopened-expired.png)
- [只读 PWA 等待状态](pwa-pending.png) · [取消终态](pwa-cancelled.png) · [自然超时终态](pwa-expired.png)

用仓库 README 所列的 Linux x64、Node 24、Xvfb 和可启用系统沙箱的 Electron 环境重跑。可用 `CHROME_BIN`、`ELECTRON_BIN` 和 `XVFB_BIN` 指定等价的本机运行程序。

```sh
node tests/integration/run.cjs approval-restore-stale
NS_EXPIRE_APPROVAL=1 node tests/integration/run.cjs approval-restore-stale
NS_BASELINE_SERVER_REVISION=fb742edb8513eded7bd46d78124c4800edb9fda1 node tests/integration/run.cjs approval-restore-stale
NS_BASELINE_SERVER_REVISION=fb742edb8513eded7bd46d78124c4800edb9fda1 NS_EXPIRE_APPROVAL=1 node tests/integration/run.cjs approval-restore-stale
```
