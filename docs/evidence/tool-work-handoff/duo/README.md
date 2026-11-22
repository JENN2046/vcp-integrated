# 同一代的两个普通原生工具

在 Linux x64 使用两份独立的合成 Profile、启用 Chromium 沙箱的 VCPChat Electron 44.9.3、原生 CDS、ToolBox 和回环 Provider。两个独立的原生直连测试插件各自写入计数文件并执行 `fsync`。Provider 在一个响应中发出两个不同的普通工具块。两个场景使用相同的模型输入和工具请求。

## 基线

冻结 ToolBox 于 `54ed2b9fd41363623ebec0e93521df72dfb0d9cd`。第二个插件分别配置为返回回执和落盘后挂起。旧 ToolBox 在第一个模型响应解析完毕后以 HTTP 500 和 `CONTROLLED_TOOL_CALL_LIMIT` 拒绝两个调用，两个计数文件均无记录。B 打开同一任务时显示需核对。

- [第二个工具可返回](baseline-returned.json)
- [第二个工具配置为落盘后挂起](baseline-unknown.json)
- [A 的状态](A-baseline-two-tool-limit.webp) · [B 的状态](B-baseline-observes-rejected-work.webp)

## 候选

**两份回执齐全。** 夹具在第一个计数落盘后暂扣回执，确认第二个工具尚未开始。放行后两个计数均为一次，同一代原生档案和暂停证明均保留两份回执。ToolBox 在暂停后正常退出，再启动时归档、暂停证明中的两个调用 ID 和 Journal 都保持一致。A 随后手动压缩，摘要输入与 B 的接续上下文均保留两个调用 ID、记录 ID 和结果。回环代理在服务端已接受 B 的接管后切断响应。B 重启读取同一个 Work 的执行权，继续并完成。再次重启 B 后，最终回复在界面、物理 History 和 Journal 均只有一份，两个计数仍各为一次。

- [完整验收回执](candidate-returned.json)
- [A 暂停](A-settled-tool-boundary.webp) · [A 压缩](A-compacted-original-work.webp) · [B 恢复接管](B-recovered-handoff-after-lost-receipt.webp) · [B 重开完成结果](B-completed-original-tool-work.webp)

**第二份回执未知。** 第二个计数执行 `fsync` 后挂起，夹具对隔离 ToolBox 发出 `SIGKILL`，再从同一账本启动 ToolBox。B 显示第一个工具已返回、第二个工具结果待核对。接管和继续按钮均禁用。实际调用后端时，A 的压缩准备及 B 的接管均被 HTTP 409 和 `WORK_SAFE_BOUNDARY_PENDING` 拒绝。B 的继续准备被 `SHARED_REQUEST_FENCED` 拒绝。两个计数仍各为一次，Work 无第二代、无暂停检查点、无压缩意图、无最终回复。

- [完整验收回执](candidate-unknown.json) · [B 核对原请求](B-side-effect-needs-review.webp)

**双工具 SSE。** A 收到 HTTP 200 和 `WORK_SAFE_TOOL_BOUNDARY` 暂停事件，桌面将这一代标为已中断。两份原生回执随 ToolBox 重启保留。B 重新打开桌面后恢复已获准的接管，接续原 Work 并完成。最终再次重开 B，Provider 调用总计三次，两个工具各执行一次，History 和界面各保留一份终稿。[SSE 回执](candidate-returned-sse.json)

**旧单工具 Work。** 回环代理移除双工具能力声明，并核对接纳记录未写入双工具上限。JSON 和 SSE 分别收到 HTTP 409 和 HTTP 200 暂停响应。两次独立测试均在接管回执丢失后重开 B，继续原 Work，只生成最终文本。每次测试的工具执行计数均为一。[JSON 回执](legacy-single-json.json) · [SSE 回执](legacy-single-sse.json)

## 复跑

在已构建的集成仓根目录使用 Node 24、Xvfb 和具备 Chromium 沙箱的 Electron。测试仅访问回环地址，完整回执的位置由命令输出。

```bash
NS_BASELINE_SERVER_REVISION=54ed2b9fd41363623ebec0e93521df72dfb0d9cd node tests/integration/run.cjs tool-duo-baseline-returned
NS_BASELINE_SERVER_REVISION=54ed2b9fd41363623ebec0e93521df72dfb0d9cd node tests/integration/run.cjs tool-duo-baseline-unknown
node tests/integration/run.cjs tool-duo-returned
node tests/integration/run.cjs tool-duo-returned-stream
node tests/integration/run.cjs tool-duo-unknown
node tests/integration/run.cjs tool-handoff
node tests/integration/run.cjs tool-handoff-stream
```

## 兼容与验证边界

`safe-tools-v1` 在接纳新 Work 时根据桌面声明的 `shared-controlled-tool-pair-v1` 冻结至多两个调用。旧 Work 和未协商的工作仍只允许一个工具。输入来自同一个模型响应，两个不同的名单内插件按原解析顺序逐一派发。每项沿用原生审批和调用身份。两份回执都归档且账本确认后，下一次模型派发前暂停。B 的后继代仍为文本生成；本批没有启用跨多个模型轮次的工具规划、嵌套调用、AgentAssistant 或群聊移交。

冻结版本的原生套件 276 项通过，6 项因未提供旧压缩数据而跳过；协作套件 60 项全部通过。[原生批次预检](../../../../tests/native/tool-batch-preflight.test.cjs) · [凭证与协商验证](../../../../tests/native/shared-tool-boundary.test.cjs)
