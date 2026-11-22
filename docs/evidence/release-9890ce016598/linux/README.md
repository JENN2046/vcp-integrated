# Linux 发送及重开

Linux 实机运行固定提交干净检出构建的 Electron 与 CDS，在独立 X11 显示、空 Profile A 中选中目标话题。点击发送按钮一次，在原窗口看到原用户消息和合成回复，持久 History 含同两条 ID。原窗口 PID `670578` 正常退出，重开 PID `681331` 读回同一 Profile 中的原话题。原生状态接口返回同一 Work、request ID、`completed` 和 `last-known`，终态 row 在状态面板的 DOM 中，完成态面板默认隐藏。消息在主会话界面可见。重开进程随后正常退出。

- 首次终态与退出 [会话摘录](./initial-completed.json) · [截图](./initial-completed.png) · [进程事件](./initial-lifecycle.ndjson)
- 重开后 [原生状态、DOM 与 History 摘要](./reopened-readback.json) · [截图](./reopened.png) · [正常退出](./reopened-exit.json)
- Watcher 容错和实际加载摘要见[构建回执](../build/README.md)。中央在重开前后均保持一份完成 Work、一次 Provider 调用和两条 Journal。

首次补充探针把旧一代执行投影中的可选 `replyMessageId` 当成了必填字段。原版硬件测试入口继续保留首次终态界面及原 History 的两条 ID。重开探针从本机原生状态读取 Work 和 request，从真实消息 DOM、磁盘 History 逐条核对回复 ID。两条消息的 DOM `textContent` 比对应的持久正文各多一个 Markdown 渲染产生的尾随换行，去除尾随换行后正文一致。回执保留各自的原始 UTF-8 字节数与 SHA256。
