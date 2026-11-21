# 同一工具 Work 的压缩与跨端接续

A 能交出的最早边界是**一个直接工具调用已返回，原生调用账本与归档结果相符，且下一次模型派发尚未开始**。ToolBox 将这代的部分回复以原请求 ID 和 `interrupted` 写入 Journal，并为同一代提交原生检查点证明。A 此时可以压缩。B 要等共享压缩检查点提交后，才能显式接管；接管完成后还需单独点击继续。[宿主差异](host.patch)

## 实际路径

这批实现的是显式新建的共享单聊工具任务 `safe-tools-v1`。服务端设置 `NativeSyncSharedSafeTools` 为 JSON 名称列表后，两端的「跨端任务」才提供工具入口；缺省为空。A 的第一代最多执行一个已列入名单的本地同步直连 hybridservice 插件，仍经过原生审批策略和工具记录。B 的下一代使用已提交的检查点生成文本。普通发送、已有的普通 Work、群聊、附件、分布式或嵌套工具、AgentAssistant 均在本次边界之外。

| 阶段 | 实测事实 |
| --- | --- |
| A 开始执行 | 旧版拒绝新模式。候选由 A 显式开始第一代，原生工具接收方写入计数并 fsync，一次调用产生一个 invocation ID 和一个工具记录 ID。 |
| A 压缩 | 提前接管被拒绝。确认回执后，压缩模型的真实输入恰含一条对应原调用的已结算结果，压缩意图关联同一 Work 和原生证明。 |
| B 接管并继续 | A 退出。代理截断已提交的接管响应。B 重开自己的 Profile 后查回执行归属，点击继续才派发下一代。A、B 的原生模型请求 ID 可区分，两代的 Work ID 相同；工具计数始终是 1。 |
| 未知副作用 | 计数写入后工具抛错，或未返回时 ToolBox 被强停。相应 Work 留待核对，压缩、移交、续代均不能通过。重复请求和重启都没有新增模型轮次或工具调用。 |
| 已知回执后强停 | 用原库重开 ToolBox，仍能核对原 Work、原调用 ID、Journal 和归档证明，压缩输入可取回该工具回执一次。 |
| B 再次提出原工具 | 合成模型在接管后要求执行与 A 相同的操作，原生执行层拒绝。Work 留待核对；工具账本仍只有 A 的原调用，接收方计数保持 1。 |

非流式与流式均从两台独立 Profile 的沙箱 Electron 窗口发起。已确认的暂停可通过 HTTP 控制响应或 SSE 暂停事件送达；桌面按原请求 ID 向 Work 权威核对已发布的 Journal 消息。当实时输出落后于暂停状态时，桌面撤下旧代的实时预览。B 恢复后的检查点、原生调用和最终回复可与 Journal 逐项核对。[两端请求、控制回执和截图](desktop/README.md) · [重启与未知结果](recovery/README.md) · [重复工具请求的实测结果](recovery/protocol.json)

## 范围与回归

使用回环合成 Provider、隔离 ToolBox 和可独立计数的测试插件，日用和验收端均未部署。本批保证来自宿主已落账的原生回执；外部副作用的结果如果无法确认，就保留原执行身份供核对。B 的模型输入使用共享摘要；原工具结果和 ID 由原生归档、调用记录及检查点链接提供核查。

原生套件 230/230，协作套件 53/53。桌面相关套件从仓库根目录执行为 109/130；21 个失败用例与基线逐名一致，新加的已确认空前缀暂停回归通过。两项样式用例单独从桌面目录运行通过。[基线命令与逐项对照](recovery/desktop-baseline.md)

[非流式回执](desktop/candidate.json) · [流式回执](desktop/stream.json) · [A 在回执处暂停](desktop/A-settled-tool-boundary.png) · [B 重开后找回归属](desktop/B-recovered-handoff-after-lost-receipt.png) · [B 完成原 Work](desktop/B-completed-original-tool-work.png) · [B 查看待核对调用](desktop/B-side-effect-needs-review.png)

既有跨端压缩用例的一次附加回归在本机校验 History 文件身份时返回 `HISTORY_IDENTITY_CHANGED`。当时共享检查点与物理 History 均已提交，随后在新 Profile 独立复跑通过。该次本机读取竞争未单独修复。
