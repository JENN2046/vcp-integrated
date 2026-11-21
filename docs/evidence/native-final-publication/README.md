# ToolBox 原生终稿发布与恢复

对显式工具型共享单聊的 B 末代（`safe-tools-v1`，generation 1），ToolBox 现在在原生 handler 确认可发布的最终正文和 `stop` 时持久化回执，再以原回复 ID 发布到共享 Journal。B 可以在收到响应前退出。重开原 Profile 后，Journal、物理 History 和聊天气泡各有一条相同的正式回复。[宿主差异](host.patch)

## 同一故障窗口的前后对照

用本地合成 Provider 和会实际写文件并 fsync 的计数工具，先重跑 `5ed51ba784bf`，再跑候选。A 执行一次工具并压缩；B 接管同一 Work，最终模型请求派发后正常退出。下列终态丢失场景中，代理没有向 B 发送最终响应的头或正文。

| 故障窗口 | 基线 | 修复后 |
| --- | --- | --- |
| B 先退出，ToolBox 后完成非流式 JSON | 重开原 Work 待核对，无终稿 | B 重开取得原回复；再重启 ToolBox 后仍为该回复 |
| ToolBox 已完成 JSON，B 收包前退出 | 同样无法恢复 | 原 Work 完成，原回复 ID 对应一条正式记录 |
| ToolBox 已完成 SSE，B 收终态前退出 | 可见预览，Journal 和 History 无终稿 | B 正式气泡、物理 History 和 Journal 各一条 |
| B 退出时 Provider 只有派发、没有回复 | 进入待核对 | 原生请求 `unknown`，Work `review_required`，没有最终回复 |
| B 收到正文，补交后丢 HTTP 200 发布回执 | 已发布的回复可恢复 | B 补交读回同一发布序号，重开后仍只有一条 |

每个桌面场景中的模型请求为 A 首代、摘要和 B 末代各一次，原工具调用 ID 唯一，接收方计数为 1。先在原 ToolBox 上重开 B，再用同一份库重启 ToolBox，对照中均没有重新派发模型或工具。[桌面回执与复跑方法](desktop/README.md) · [基线 SSE 截图](desktop/baseline-sse-before-quit.webp) · [修复后同一窗口截图](desktop/candidate-sse-before-quit-toolbox-restarted.webp)

## 两份存储之间的中断

原生归档保存最终显示正文、模型结束原因、Work ID、代次、原生请求／回复 ID、执行者、定稿时间和摘要校验值。JSON 发回完成响应前、SSE 发出 ToolBox 的最终 stop 帧前走同一持久化入口。Journal 沿用 `work-reply:<Work ID>:<代次>` 操作。正常发布和启动恢复核对原执行身份、首代已结算工具及共享检查点，在同一个 SQLite 事务中写回复、序号与 Work 终态。B 的本地时间可与原生定稿时间不同；迟到提交相同正文及等价结束原因时返回原序号，冲突正文和错误执行者被拒绝。

独立的非流式及 SSE 实验在终稿文件完成目录 fsync 后、Journal 仍无回复行时强停 ToolBox。第一次重启按原 ID 补发一次，第二次重启以及 B 的迟到补交均保持相同 Journal 序号。另测正文遭篡改、上游错误以及只有前缀的 SSE 断开，均保留待核对状态。旧库若只有助手文本或 `model_terminal` 标记，也不能据此补写正式回复。[非流式崩溃回执](server/final-crash.json) · [SSE 崩溃回执](server/stream-final-crash.json) · [错误、截断和篡改对照](server/README.md)

本批验证范围是上述 B 末代，日用与验收实例均未部署。原生套件 241 项通过，6 项需提供上批原故障资产，指定该资产后的独立专项 13/13 通过。协作套件 53/53。四项 handler 定向断言另外核对显示转换开启和关闭时，正式持久化文本与实际输出一致。
