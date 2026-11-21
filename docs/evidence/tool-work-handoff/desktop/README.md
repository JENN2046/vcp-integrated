# 工具型原 Work 的桌面接力

在 Linux x64 上运行真实 ToolBox、VCPChat Electron 44.9.3（Chromium 沙箱启用）、CDS 和 Xvfb。A、B 用独立的合成 Profile。工具由 ToolBox 通过原生工具链实际调用，计数器写入托管于夹具的文件并执行 `fsync`。模型输出由仅监听本地回环的合成 Provider 提供，便于准确安排工具调用、压缩与接续。合成摘要保留工具调用 ID、工具记录 ID 和结果，证据核对三个值在 ToolBox 档案、摘要输入及 B 的模型输入间一致。

- `baseline.json` 记录基线 `bd7f62d02bb551ad2a391b5f6dff58ba51f055e7` 的实际接纳请求。ToolBox 返回 HTTP 409 和 `CONTROLLED_MODE_UNSUPPORTED`，数据库未创建 Work，Provider 调用为零。
- `candidate.json` 记录 A 与 B 执行同一 Work、两代原生请求、唯一已结算调用，以及 A 发布检查点与 B 完成后的 History 和 Journal。HTTPS 代理截断已提交的接管响应。B 在关闭并重开同一 Profile 后核对归属，用户点击继续才触发下一次模型调用。
- `stream.json` 重跑完整接力，A 和 B 使用合成流式 Provider。`stream-pause-wire.json` 保存 A 收到的 HTTP 200 响应末尾合成帧，包含暂停事件。A 的 renderer 以 `interrupted` 收尾，B 完成原 Work。
- `unknown.json` 记录工具完成实际计数后抛出异常的路径。原 Work 进入核对状态，调用保留未确认记录。B 在重开 Profile 后看到核对状态，服务端拒绝它接管原 Work。

## 重跑

在已构建的检出内使用 Node 24、Xvfb 与带 Chromium 沙箱的 Electron。可通过 `TMPDIR`、`XVFB_BIN`、`ELECTRON_BIN` 指定环境。命令结束后，完整合成证据留在命令输出的临时目录。

```sh
NS_BASELINE_SERVER_REVISION=bd7f62d02bb551ad2a391b5f6dff58ba51f055e7 \
  node tests/integration/run.cjs tool-handoff-baseline
node tests/integration/run.cjs tool-handoff
node tests/integration/run.cjs tool-handoff-unknown
node tests/integration/run.cjs tool-handoff-stream
```
