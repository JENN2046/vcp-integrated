# 第三批施工前的阶段复审

**结论：先修两处已复现的问题，再开「压缩后跨端接续」。** 一处会让普通共享群聊的父 Work 和已完成的 AA 子任务无法结算，带着这份库重启时 NativeSync 初始化失败。另一处会把用户已修改或删除的旧回复重新交给压缩输入接口。评审对象为集成主干 `f00aa6d256a2`；以下新实测均使用隔离库、真实 ToolBox 和回环合成 Provider。本次提交只含审阅材料和测试夹具。

## 按影响排序的发现

1. **高｜普通群聊的两条结算路径不一致，本次实测。** 固定 A、B、C，不取消后续接力，让最后一位 C 启动一次 AA。若 C 先提交，三个成员回复均进 Journal，AA 仍在运行，群聊却进入 `blocked_config / SHARED_NATIVE_TERMINAL_REQUIRED`。AA 正常完成后再等 4.4 秒仍未释放；同话题新请求返回 409。使用原库重启，NativeSync 初始化在群聊恢复处报同一个错误。若 AA 先完成、C 后提交，中央准入已完成，移动执行记录却转为 `review_required / GROUP_PLAN_REVIEW_REQUIRED`。源码中正常收尾先提交共享 finish，再独立更新移动账本；后者统计了子模型使用的负序号绑定行，成员列表本身已正确排除这些行。取消后续成员的分支已有等待和重新结算逻辑。[子任务晚结束](uncut.json) · [子任务早结束](uncut-early.json) · [正常收尾及异常处理](../../../apps/server/Plugin/NativeSync/mobile/groupTurn.js#L249) · [启动恢复](../../../apps/server/Plugin/NativeSync/mobile/groupTurn.js#L143)
2. **高｜共享压缩输入会带回被替换的旧正文，本次实测。** 用发布版本支持的受控纯文本单聊完成一个 Work，通过正常消息编辑接口改写其助手回复。读取 `compact-input` 同时得到修改后的正式行和带 `native_evidence_…` ID 的原文；再通过正常接口删除正式行，Journal 记下同一消息 ID 的 delete，压缩输入仍含原文。整个探针只有一次模型请求，结束于读取输入，未生成摘要。代码按正文是否在当前 History 出现来决定是否补入原生事件，因此无法识别同一回复的版本与墓碑。修复时应让消息 ID、原生请求／代次与 Journal 的当前版本共同决定模型可见内容，保留核查所需的原生证据。[修改及删除前后回执](compaction.json) · [压缩输入组装](../../../apps/server/Plugin/NativeSync/sync/sharedCompaction.js#L24)
3. **接续约束｜「人工解除暂停」只能证明用户作了处理决定，本次实测。** 在独立的未取消群聊用例中，原发起者经已认证 PWA 会话确认放弃后，同话题新 Work 返回 202。此时原 AA 仍为 running、子模型请求仍为 dispatched，随后 AA 正常完成。此次为显式操作，没有观察到自动重复执行。后续自动接管必须单独检查子请求与工具回执；`reviewResolved` 不能充当它们的终态证明。[确认放弃和新准入回执](uncut-ack.json)

## 指定的组合故障通过了什么

A 已提交，B 发起 AA，原生 VCPLog 通道对同一审批允许一次。在 AA 首次子模型调用尚未返回时，发起端取消剩余接力，实际强停 ToolBox。使用同一库重启、重交原始输入并重试取消命令：

| 强停时刻 | 重开后的正式消息 | 执行归属和计数 |
|---|---|---|
| B 的父模型已经返回，AA 还在运行 | 用户、A、B 均保留。B 的正式消息含委托已受理的占位信息 | 同一 Work 待核查，B 已完成，同一 AA 为 unknown，取报告返回 409。C 已取消，零派发 |
| B 的父模型和 AA 子模型都还没有返回 | 只有用户和 A；B 保留中断记录 | 同一 Work 待核查，B 的原生请求与 AA 状态均为 unknown，C 零派发 |

两次试验都只启动一个 AA，原始提交和取消的重试没有增加 Provider 请求或 Journal 行。B 有两次父模型请求（提出工具调用、使用工具返回）；每次试验 AA 子模型只收到一次请求。PWA 分别呈现成员回复与 AA 状态。[B 先返回的回执](combined.json) · [B 仍在途的回执](combined-inflight.json) · [重开截图](combined.png)

## 职责归属与实际做掉的重复

| 事实 | 当前裁决者与持久依据 | 复审判断 |
|---|---|---|
| 本轮谁说、某成员实际看到什么 | 服务端准入保存发言计划；VCPChat 的历史窗口与酒馆深度函数用于桌面及 worker；入模位置可与消息 ID 对齐 | 已消除单聊窗口与单／群聊深度的重复实现。两端仍各自组装 prompt、发言者标签及附件，本机文件和共享附件的读权限各有所有者。[逐成员实测](../group-context/README.md) |
| 工具是否获准、是否实际调用 | PluginManager 保存原审批，原生执行上下文登记调用；共享账本关联 Work 和调用回执 | 应保留分工。审批待处理项随 ToolBox 进程存活；桌面可重开恢复。普通直连工具已验证，其他传输须看各自回执。[审批恢复](../approval-restore/README.md) · [普通工具](../ordinary-tools/README.md) |
| AA 与父 Work 是否完成 | AA 管原生委托、活跃循环和可校验归档；NativeSync 管父子身份、准入和话题占用 | 工具返回、成员正文提交、AA 报告、整轮释放各有依据。未取消群聊仍有两处独立的父 Work 完成判断，已出现相反状态。[单聊 AA 证据](../aa-delegation/README.md) · [本次反例](uncut-early.json) |
| 正式 History、部分正文和读端 | Journal 确认共享消息；桌面通过原生 History 写队列投影；PWA 根据权限观察 | 成员正式回复可以先于 AA 归档。流式预览、已返回调用和人工核对标志均不足以补写终稿。[群聊取消与恢复](../group-relay/README.md) |
| 压缩、检查点与下一代执行 | VCPChat 请求压缩模型；ToolBox 保存原生续接证据；NativeSync 校验来源版本、执行者并发布共享检查点 | 检查点的消费已有实测。共享压缩另行拼装原生事件的实现仍与 History 的编辑、删除归属冲突。[原生归档合并](../../../apps/server/modules/nativeContinuationStore.cjs#L57) · [既有窗口验收](../context-chain/README.md) |

从 `f73493e` 至本次被审 HEAD，`apps` 和 `packages` 排除 tests 目录的 Git 差异为 39 个文件、增加 874 行、删除 279 行。局部规则已经合一，新增代码主要用来承接审批恢复、成员控制与父子任务结算。行数本身不能证明维护成本已下降。

## 开工决定与修复验收

1. **先修普通群聊收尾。** 正常完成、取消剩余和启动恢复共用同一套「成员步骤＋子任务」结算条件。活跃子任务应等待，未知副作用应待核查。用本次两个完成顺序验收：中央与移动账本一致、同话题下一轮可用、已有故障库可以重开，历史完整且模型计数不增加。
2. **再修压缩输入。** 以消息身份关联原生事件，覆盖改写、删除、两条不同消息同文，以及应当保留的已结算工具事实。先验证源输入正确，再用隔离桌面真正生成一个空闲话题检查点，核对发布、丢回执、重开及下一条请求的消费范围。
3. **工具型 Work 跨设备接续仍需单独设计。** 当前发布策略只开放桌面受控纯文本单聊的 steering；该模式禁止调用工具，活跃的普通共享 Work 又不满足压缩门槛。原计划要求的「同一 Work 已结算工具、压缩后换端继续」当前没有受支持的完整路径。前两项修复通过后再确定最窄的准入合同，并用原调用 ID 和接收端计数验证重放安全。[发布策略](../../../apps/server/Plugin/NativeSync/sync/releasePolicy.cjs) · [活跃 Work 压缩条件](../../../apps/server/Plugin/NativeSync/sync/sharedCompaction.js#L15) · [原生工具门槛](../../../apps/server/modules/requestExecutionContext.js#L143)

## 复跑

使用已构建的 Linux x64 检出、Node 24、Chrome、OpenSSL 和本地合成数据。这些是对被审版本的诊断用例，其中 `uncut` 的断言描述已复现的故障。修复批次应把这些断言改为期望的成功条件。

```sh
node tests/stage-review/combined.cjs .runs/review-combined.json
CRASH_WITH_B_IN_FLIGHT=1 node tests/stage-review/combined.cjs .runs/review-combined-inflight.json
node tests/stage-review/uncut.cjs late
node tests/stage-review/uncut.cjs early
node tests/stage-review/uncut.cjs owner-ack
node tests/stage-review/compaction.cjs
```
