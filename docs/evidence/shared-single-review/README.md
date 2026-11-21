# 共享单聊阶段复审

审阅提交 `69573c475e3a`，覆盖普通共享单聊，以及 A 执行一次工具、B 接管原 Work 生成文本的单聊。**工具型 Work 的 B 末代已由 ToolBox 定稿并发布。普通共享 worker 仍有一个终稿恢复缺口；两条路径也尚未完全按相同的有效上下文判断能否在后端执行。** 下一批优先处理前者。此次提交复审记录和复现实验。

## 三项需要处理的发现

| 优先级 | 本次隔离实验 | 用户影响 |
| --- | --- | --- |
| 1．普通共享 Work 的终稿依赖第二次持久化 | 同一组普通单聊请求均由真实 ToolBox 与直连计数插件执行。worker 收到完整 `stop`，在写 `pending_operation` **之前**强停，重启后 Work 为 `review_required`，Journal 的正式回复为 0 条；移到写入**之后**强停，重启后同一 Work 完成，Journal 恰好一条，正文哈希与已保存意图一致。两侧相同提交均找回各自原 Work，模型首轮、工具续轮各一次，工具各执行一次。 | 用户可能已经等到模型生成完，却无法在同一会话恢复答案。本机 A 退出与整个 ToolBox 强停是不同故障。普通路径尚不能继承 B 末代的原生终稿保证。[ToolBox 两个切点的回执](toolbox-terminal.json) · [worker 的发布意图](../../../apps/server/Plugin/NativeSync/mobile/execution.js#L256) |
| 2．检查点以前的桌面依赖仍参与准入和执行判断 | 用同样的当前输入和固定摘要，经共享接口准备、读取和提交检查点。只把 Canvas 占位或桌面文件引用放到检查点前，原生窗口已只选中摘要和新输入，桌面的服务端会话准备却返回空，直接请求 `/shared/session-send` 得到 409。手机发送接口接纳后，旧 Canvas 场景成功；旧桌面引用场景在模型派发前进入 `review_required`。将引用移到检查点后，保留引用的对照确实应阻止后端派发。 | 普通桌面会转向桌面持有的执行入口；手机可能留下已经接纳、实际未运行的 Work。应让客户端路由、服务端准入和 worker 按同一有效窗口检查资源，服务端继续校验当前输入、配置和权限。[四组回执](context.json) · [桌面分流](../../../apps/desktop/modules/services/nativeSync/sharedSessionClient.js#L69) · [服务端准入](../../../apps/server/Plugin/NativeSync/sync/sharedSession.js#L25) · [worker 预检](../../../apps/server/Plugin/NativeSync/mobile/execution.js#L201) |
| 3．确定尚未派发的普通请求，手机与桌面重启行为不同 | 在持久状态刚由 queued 转为 running、尚无任何原生请求登记的同一切点退出进程。桌面入口创建的 `kind=shared_session` 恢复到 queued，手机入口创建的 `kind=NULL` 进入 `review_required`。两者模型调用均为 0，均保有原 Work 和原用户消息。 | 手机端要由有权的原会话显式处理暂停。以后若统一恢复条件，必须逐项核对派发意图、原生请求、工具和任务记录；已经派发或副作用未知的行继续留待核对。[重启对照](ordinary.json) · [手机准入](../../../apps/server/Plugin/NativeSync/mobile/sharedSingle.js#L12) · [启动恢复](../../../apps/server/Plugin/NativeSync/mobile/execution.js#L52) |

第一项在真实服务端进程、SQLite、回环 Provider 与有独立落盘计数的普通插件上复现，故障注入只选择进程退出时点。第二、三项使用真实桌面运行时、共享 HTTP、SQLite 和移动 worker，模型端为回环合成响应器；没有把程序入口实验计作实体手机或 Electron 窗口实测。这些是故障窗口对照，不能据此估计日常出现频率。

## 两条路径的职责与凭据

普通桌面用原生发送入口。符合条件的文本走 `session-send` 和服务端 worker；本轮发送带新附件或需要桌面上下文时会转入桌面持有的原生执行。PWA 的普通发送从会话消息接口进入 worker。既有附件对照验证了 worker 读取已绑定在历史上的附件。显式工具任务需要启用服务端允许名单，A 首代最多执行一个允许的本地同步直连工具，B 末代生成文本。两者的执行、恢复保证以实际选中的入口为准。[桌面发送与回退](../../../apps/desktop/modules/services/nativeSync/sharedRuntime.js#L668) · [历史附件的实际请求](../context-chain/README.md) · [工具模式发布边界](../tool-work-handoff/README.md)

| 环节 | 普通共享单聊 | 显式工具 Work | 持久凭据与重试入口 |
| --- | --- | --- | --- |
| 输入、身份和准入 | 桌面先保存输入 ID，中央按主体与 request ID 校验请求哈希，写入准入、用户消息及 worker 执行记录；PWA 另有会话鉴权入口。 | 桌面显式准入 `safe-tools-v1`，冻结模式、配置、执行者和第 0 代；普通 Work 不能在途中转换。 | 草稿在本机；接纳后的用户消息、Work 归属在中央。回执丢失按原 request ID 查询，核对 Work 后观察／投影。[普通准入](../../../apps/server/Plugin/NativeSync/sync/sharedSession.js#L51) · [重连核对](../../../apps/desktop/modules/services/nativeSync/sharedSessionClient.js#L241) · [准入前拒绝与丢回执](../linux-acceptance.json) |
| 送给模型的上下文 | worker 按请求的 Journal 水位取得对应版本，交给 VCPChat 的原生历史窗口、酒馆规则和配置组包。压缩前的数据仍留在完整历史。 | 桌面组装本代请求，ToolBox 校验请求身份、配置和请求体。B 的接续依据原压缩检查点与原生证明组装模型输入。 | 冻结配置、消息 ID、Journal 序号、附件关联与内容哈希用来核对真实请求。第 2 项暴露的是进入原生窗口前的资源判断。[原生窗口](../../../apps/desktop/modules/chat/historyWindow/index.mjs#L11) · [worker 调用](../../../apps/server/Plugin/NativeSync/mobile/effectiveContext.js#L10) · [规则对照](../context-rules/README.md) |
| 执行、工具和审批 | VCPToolBox 的 handler 执行模型，PluginManager 执行工具与审批，NativeSync 将原调用、任务和审批归属关联到 Work。 | A 仍走同一原生审批与工具桥；只有已返回、可与归档匹配的 invocation ID 和 record ID 才能形成工具停点。 | 服务端的审批 ID、截止时间、原请求当前执行权决定能否处理。获准桌面重开可取回原审批；只读端可观察。调用接收方计数验证只执行一次。[审批恢复及过期／取消对照](../approval-restore/README.md) · [原生调用账本入口](../../../apps/server/modules/requestExecutionContext.js#L176) |
| 中止、断流和观察 | 有权发起取消，服务端检查原任务、原生信号和副作用；只收到部分正文可以保留预览或待核对记录。 | 工具已产生副作用却未返回时，原调用保持待核对，压缩、移交和续代都被挡住。 | SSE 游标、预览和取消回执用来恢复观察；完成与否仍由原生结果和中央提交裁决。[取消入口](../../../apps/server/Plugin/NativeSync/mobile/execution.js#L282) · [已执行但未返回的强停对照](../tool-work-handoff/recovery/unknown.json) |
| 压缩与移交 | 原生桌面压缩服务调用摘要模型，中央校验来源版本，登记意图并提交检查点；另一设备据此发送通常是新 Work。 | A 必须到达已确认的工具停点，提交与原证明绑定的检查点；B 显式接管同一 Work 后再开始下一代。 | 压缩以原 intent ID、消息 ID、sourceHash 和提交序号核对。A 本机读回失败可复用原检查点。移交另核执行者、代次、修订和未结调用。[压缩权威](../../../apps/server/Plugin/NativeSync/sync/sharedCompaction.js#L17) · [本机确认重试](../history-identity/README.md) · [移交条件](../../../apps/server/Plugin/NativeSync/sync/sharedSteering.js#L410) |
| 正式回复与恢复 | 普通 worker 持久保存 `pending_operation`，沿共享完成入口结算准入和执行记录。上表第 1 项给出了恢复保证开始的精确位置。 | B 末代的 JSON/SSE handler 先持久化规范正文、结束原因和身份，再按 `work-reply:<Work ID>:<代次>` 发布到 Journal。 | 完成凭据、原 Work／代次／回复 ID 和 reply_seq 决定是否已有正式回复。B 迟到补交相同结果取原序号；只有派发记录仍待核对。[普通结算](../../../apps/server/Plugin/NativeSync/mobile/sharedSingle.js#L40) · [原生终稿恢复](../../../apps/server/Plugin/NativeSync/sync/sharedNative.js#L41) · [终稿丢失、重启与补交实测](../native-final-publication/README.md) |
| 桌面呈现 | 两端按中央提交序号同步，由本机 History 唯一队列投影。 | B 退出后也能从同一中央 Journal 投影；原生暂停回复与末代正式回复各有自己的 ID。 | 本机 History 修订、投影意图和水位决定何时可显示已保存。页面预览、选区和草稿留在各端；它们不授权重新派发。[共享读写队列](../../../apps/desktop/modules/services/nativeSync/sharedQueue.js#L56) · [投影与重新观察](../../../apps/desktop/modules/services/nativeSync/sharedSessionClient.js#L102) |

共享层仍须承担成员权限、共享 Journal 的版本和墓碑、Work 幂等、执行归属，以及各端重新观察和核对所需的水位。模型显示文本的构造、工具批准与实际执行、压缩窗口和可信终止原因已有原生所有者。原生工具归档与审批等待保留在服务端，桌面按权限读取所需结果和控制状态；设备私有的草稿、DOM 状态和 History 写入互斥各自由本机维护。

## 桌面补交能减到哪里

**新版本 B 末代的补交只需确认原生已发布的回复。** 既有真实双桌面回执中，B 未发任何补交也恢复一条正式回复；B 正常收到模型响应再补交时，返回原发布序号。本次进一步验证同一回复 ID 的发布序号为 5、编辑序号为 6、删除序号为 7。B 在编辑与删除后用新的或旧的操作 ID 补交，都只得到 5；当前投影仍是序号 7 的墓碑。错误回复 ID 和 A 冒领均被拒绝。[本次编辑、删除与迟到补交](final.json) · [既有双桌面实测](../native-final-publication/desktop/desktop-results.json)

可做的小幅删减是 `completeTurn` 同一同步调用内重复检查执行者和回复 ID：入口已核过两者，回执事务里的第二处检查重复。更有价值的后续设计，是让识别新版原生凭据的桌面只读回同一条 Journal 并确认本地投影。保留服务端对主体、代次、正文、已有发布操作的检查及旧 B 的补交接口。本次用真实旧版 ToolBox 运行后升级了两份隔离库：旧库有文本和 `model_terminal`、没有正式凭据时仍待核对；旧库已发布时，旧 body 精确重放可取回原序号。同一旧 opId 改时间会触发原哈希冲突，新 opId 可确认同一条发布。删除旧哈希兼容会改变既有重放行为。[两处身份检查与旧收据兼容](../../../apps/server/Plugin/NativeSync/sync/sharedSteering.js#L233) · [原发布操作检查](../../../apps/server/Plugin/NativeSync/sync/sharedSteering.js#L262) · [桌面补交与核对](../../../apps/desktop/modules/services/nativeSync/sharedSteeringClient.js#L99)

## 验证欠账与下一批

在审阅 HEAD、Node 24.22.3 下，从集成仓根重跑相关桌面套件，130 项中 109 通过、21 失败，失败用例名与历史记录完全一致。优先恢复 Main Chat IPC 的 18 项行为验证，特别是断流后 reader 释放、终态只发一次，以及失败中断的归属。另有 1 项提示语义断言和 2 项依赖工作目录的样式断言。上批六项「压缩自动中断」已有独立修复与真实回执。当前 21 项的失败集合不能代替宿主故障清单。[本次重跑](desktop-baseline.json) · [基线分类、命令与逐项名称](../tool-work-handoff/recovery/desktop-baseline.md) · [压缩自动中断实测](../local-stream-interrupt/README.md)

**建议先补普通共享 worker 的终稿窗口。** 普通 worker 的原生响应解析器已在内存里生成带请求 ID、结束原因和正文哈希的终态证据。先核对它与现有发布意图能否共用，再按本报告的两个强停点验收：原生终稿的身份与正文都能核实时，重启用原 Work 写入原回复 ID 一次；只有派发或不完整输出时保持待核对。两边的模型与工具计数都不得增加。随后让可移植性判断复用同一有效窗口，再单独处理手机未派发请求的恢复分支。桌面旧测试按受影响路径修夹具；终稿补交的小幅删减排在这些用户可见问题之后。[worker 的终态证据](../../../apps/server/Plugin/NativeSync/mobile/nativeResponse.js#L14)

### 复跑本次实验

在集成仓根的 Node 24 环境运行。临时目录应放在有可用配额的本地磁盘上。以下用例利用已有的集成依赖、合成服务及已构建的原生资产；检查点摘要对照使用固定合成文字。

```sh
node tests/shared-single-review/toolbox-terminal.cjs
node tests/shared-single-review/ordinary.cjs
node --test tests/shared-single-review/context.cjs
node tests/shared-single-review/final.cjs
node tests/shared-single-review/final.cjs --legacy-without-proof
node tests/shared-single-review/final.cjs --legacy-with-receipt
```
