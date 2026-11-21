# B 退出后，最终回复能恢复到哪一步

**基线 `2a36b5075432` 未通过终稿送达前的恢复验证。** B 的末代模型请求已实际派发，ToolBox 能拿到完整回复并记录 `model_terminal`。如果 B 在收到回复并提交终稿之前退出，重开原 Profile 后可以识别原 Work，却读不到可确认的最终回复。模型和工具均没有重跑。

| 退出的切点 | B 重开后的实测 | 判定 |
| --- | --- | --- |
| Provider 已接到 B 请求，但没有返回终态，连接随 B 退出而断开 | 服务端同一 Work 为 `review_required`，原生请求为 `unknown`。Journal、物理 History 和对话窗口都没有 B 的终稿。 | 未知结果保护通过 |
| 代理保留 B→ToolBox 的上游请求，阻断返回 B 的全部响应字节；ToolBox 给出完整终态 | 非流式分别在 B 退出前后放行，流式另实测 ToolBox 在 B 退出前已发完 SSE 的 stop 和 [DONE]。各组原生请求均为 `model_terminal`，Work 仍是 `dispatched`。B 重开显示需要核对；ToolBox 同库重启后，Work 转为 `review_required`。 | 终稿恢复失败 |
| B 已收到模型回复并提交到共享 Journal，代理截断成功的发布回执 | Journal 已有原回复 ID 和完成的原 Work。B 正常退出并用原 Profile 重开，物理 History 和窗口读回同一条完整回复。 | 发布回执丢失的对照通过 |

各桌面用例均从隔离 Profile 的真实 VCPChat 窗口发起，使用本机 ToolBox、回环合成 Provider 和实际 fsync 的计数工具。各自的 A 工具代、压缩摘要和 B 最终代都只调用模型一次，工具计数为 1。主验先让原 ToolBox 持续运行、只重开 B，再单独对照 ToolBox 强制重启。[早、晚两种退出时序与待核对截图](desktop/README.md) · [已发布回执](published/receipt.json) · [B 读回已发布终稿](published/B-reopened-published-reply.png)

## 证据断在哪里

在已返回完整模型文本的一组，原生归档的 `assistant` 留下了文本，`completion` 却为空；中央没有该回复 ID 的 Journal 行，B 本地也没有可重交的发布意图。任务面板提示需要核对。在流式样本中，实时预览仍显示「第 2 代 · 原生执行中」并带有相同正文；正式聊天气泡、Journal 和物理 History 均没有这条末代回复。独立服务端实验也复现了这段状态，精确重放原生请求会被拒绝。[服务端实验](server/README.md) · [B 重开截图](desktop/lost-B-same-toolbox.png)

本版提供了写入原生终稿记录的 `checkpointCompletion` 接口。受测 handler 只归档每轮的助手文本；正式回复仍依赖 B 经 `steer-turn-complete` 发布。若要补上这段恢复，最窄的改动是在宿主确认最终输出时把正文与终止原因绑定到原 Work、代和请求 ID，并允许重开时依该凭据幂等发布同一条回复。证据缺失或不一致时继续保留待核对。[原生终稿接口](../../../apps/server/modules/requestExecutionContext.js#L338) · [Journal 发布入口](../../../apps/server/Plugin/NativeSync/sync/sharedSteering.js#L235)

本批提交实测夹具与回执。已发布的成功对照可在相同隔离环境运行 `node tests/integration/run.cjs tool-final-publication-ack`。
