# 共享桌面单聊重新回复

Linux Electron 44.9.3 沙盒连接回环 ToolBox、独立 Central SQLite 与合成 Provider。使用全新合成会话，保存两轮对话并重新打开桌面后，通过鼠标右键菜单点击「重新回复」。基线为 `4cfc2716bd8eaa051f8ff2d02d87fa56a5b598f3`。

- 基线点击两轮对话的第一条回复后，主进程抛出 `SHARED_NATIVE_ADMISSION_REQUIRED`。旧回复和后续整轮从视图消失，本地 History 和 Central Journal 保持原样，Provider 没有收到新请求。[基线截图](baseline-error.png)
- 候选在 SSE 响应结束前保留旧回复与后续消息，并提示正在重新生成。期间重复点击只产生一次 admission 和一次 Provider 调用。[进行中截图](candidate-pending.png)
- SSE 和 JSON 正常响应均保留目标的消息 ID 和原有位置，其他消息逐条相同。Central Journal 只新增一条针对该 ID 的 upsert。重复提交同一完成请求返回同一个回执序号，History、Journal 和 Provider 调用数保持原样。[完成截图](candidate-completed.png)
- 立即再对同一条新回复操作。SSE 收到部分文本后提前结束，JSON 收到 HTTP 502。两个场景的 admission 进入 `review_required`，原位回复与后续整轮仍显示，且没有额外 History 或 Journal 写入。[SSE 失败截图](candidate-failed.png)
- 本地单聊仍从原菜单生成并保存新回复，未创建共享 admission。

[验证回执](receipt.json)记录上述检查的计数、回复顺序、错误与终态。运行使用合成数据，覆盖 Linux 桌面路径。

在已准备好 Electron、CDS、ToolBox 构建资产和 Xvfb 的仓库使用 Node 24 运行：

```sh
node tests/shared-single-review/regenerate-desktop.cjs
NS_REGENERATE_MODE=json node tests/shared-single-review/regenerate-desktop.cjs
NS_REGENERATE_MODE=local node tests/shared-single-review/regenerate-desktop.cjs
```

基线在独立 checkout 中复用同一测试脚本并设置 `NS_REGENERATE_BASELINE=1`。测试生成的完整流程和截图位于终端打印的临时目录。
