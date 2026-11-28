# 上游能力继承 R1 隔离候选

| 来源 | 固定提交 | 用途 |
| --- | --- | --- |
| [JENN2046/vcp-integrated](https://github.com/JENN2046/vcp-integrated/commit/5f40589303011c83a3e9d90bbef6819f628484f3) | `5f40589303011c83a3e9d90bbef6819f628484f3` | 施工与停机备份回退基线 |
| [lioensky/VCPToolBox](https://github.com/lioensky/VCPToolBox/commit/699ed4b3a0c0b08124cb8f8cf14f7e154f00af24) | `699ed4b3a0c0b08124cb8f8cf14f7e154f00af24` | 混合来源：官方参照 `965afa8`、历史下游 fork `a6f37bfd`，按文件比对实际导入 |
| [lioensky/VCPChat](https://github.com/lioensky/VCPChat/commit/6f77337c42d1b7fdee00fc4ac6c75b3600177c1d) | `6f77337c42d1b7fdee00fc4ac6c75b3600177c1d` | 本地宿主 fork `b4d5b558` 与官方 main 的共同祖先为 `2fc8fc98` |

初次服务端导入包含官方文件和 Jenn fork 的覆盖。对照两个来源逐文件核查；仅以官方提交区间生成差异会漏掉工具尾部检测等真实执行路径。宿主历史及本地接缝分别见[桌面来源](../provenance/desktop.json)和[服务端来源](../provenance/server.json)。桌面上游 648 个变更路径中，484 个与目标 blob 相同，87 个保留集成适配，37 个保留原集成实现，35 个未在同路径引入或改放，5 个随上游删除。保留路径的主要约束是正式执行者、History 写入队列和删除墓碑。

2026-11-28 启动时 GitHub 列出的开放 PR 为 ToolBox #660–667，以及 VCPChat #340、#382、#383。Chat #382 已吸收并复验 typed settings 保存；#340 的 fileKey 处理不校验协议与端口，#383 的图表修复与模型刷新留待独立渲染验收。ToolBox 的逐项判定见[开放 PR 回执](../provenance/upstream-prs.md)。

## 正式执行与 HTTP 工具交接

`node tests/integration/native-fc-http.cjs` 启动实际 ToolBox 服务和回环 Provider。两种响应格式各执行两轮工具 HTTP 请求，并单独发送超预算请求。第一轮由客户端接收工具名、参数、调用 ID 和唯一的 `tool_calls` 终态，计算 `2 + 3` 后以相同 ID 回传；第二轮核对模型收到结果并返回正文。流式逐帧核对每轮唯一终态与最后一个 `[DONE]`。工具接管由测试客户端实际完成，Provider 输出为受控夹具。超过出站预算时，JSON 收到 HTTP 400 和 context_length_exceeded，SSE 收到带预算数字的终态及一个 [DONE]，Provider 调用数不增加。

原生 FC 准入、透传、工具消息、媒体结果、用量和上下文预算专项共 52 项通过。HTTP Sink 发送协议终态；Core Sink 继续按 Work 所有权提交，未完成的工具调用不能作为正文完成。

真实网络命名空间内的 Distributed / FileOperator 专项 10 项通过。覆盖节点重连与心跳、共享连接地址下的附加文件来源校验、并发获取同一文件、失败缓存按来源隔离，以及 stdio FileOperator 接收文件引用。对比 #661 的权限取舍见[开放 PR 回执](../provenance/upstream-prs.md)。

正式 Core 另行接收带正文前缀及客户端工具调用的受控模型响应。两种格式的 Work 均进入 `review_required`，正式消息中没有助手终稿，工具账本没有派发记录。

## 数据恢复

使用基线代码建立全新的合成 Core SQLite，写入在队 Work、请求回执、消息与删除事实后正常关闭。候选打开停机副本，比对元数据、消息、Work、变更序号和回执；重复受理同一请求取得原回执。候选写入额外消息后，另取停机备份由基线重开，两次完整性检查均为 `ok`。此项验证覆盖 Core 基线数据与按备份回退。

## 原生执行实测

- 隔离 ToolBox 加载本轮编译的 Vexus 原生扩展。49 份合成日记进入 River 联合检索和 MetaThinking V3 星池，首次模型请求和工具刷新后的下一次请求都包含目标日记标记。正式 Core Work 另验日记授权边界。TDB 用本轮 Rust 库摄取合成文档，并在同一次模型请求中注入其专属标记。模型与嵌入端点均为回环夹具。
- 宿主拥有的 FC 通过 HTTP 的 JSON、SSE 两条路径执行真实 VCPSleep 子进程，第二轮请求携带原调用 ID。Resident 在场时，普通调用可执行；文本提案混入 FC 及缺少指定提案格式的 FC 均在继续派发前被拒绝。三种 SSE 用例均收到一个终态和一个 `[DONE]`。
- Core 执行专项覆盖真实 WebSocket 分布式回执、stdio Archery 交接、审批批准、拒绝、过期和 Work 取消，以及 AA 子工具的独立账本。高敏 `vcp_chat.c2` 保持 `DEFERRED_FAIL_CLOSED`。
- V5 KBM 建立 49 个文件、49 个片段和 16 个标签，在停机副本上由 V6 读取旧 manifest 并完成查询。文件、片段与标签三表逐行摘要相同。另取备份交由 V5 宿主启动，通过原生 HTTP 检索读回相同标记。
- 真实 CDS 读取两个正式话题后，第二次查询读取话题历史 0 次；编辑、删除其中一个话题的消息分别只读取该话题 1 次。结果与各自的最新正式历史一致。用例见 [core-memory.test.cjs](../tests/native/core-memory.test.cjs)。
- 远程 Core 风险专项核对桌面删除墓碑、冻结提示词、设备撤权、同址换库拒绝和停机备份恢复。恢复后桌面冷启动读回 8 条消息、4 个 Work 及原附件。另一次同 Core 联验中，Electron 受理 Work 并退出，真实 Chromium PWA 观察该 Work 并发送下一轮。随后实体 Redmi 通过专用临时 WebView 接入同一隔离 Core；Electron、Chromium 和 Redmi 分别发送 1 个 Work，均已完成，两个 PWA 客户端核对到同一组 6 个正式消息 ID。实体壳及本轮 ADB 转发已回收。[三端联验回执](evidence/upstream-convergence-r1/three-clients.json)

## 桌面、构建与回归

Linux x64 完成集成构建、四个 Electron preload、CDS、语音输入 sidecar、ProjectForge indexer、CodeSearcher 和服务端 Vexus 原生扩展的构建。ProjectForge MCP Bridge 通过真实 stdio 完成握手、工具调用、原生搜索与临时工作区的编辑回滚。该套件 21 项通过，语音 sidecar 与适配器 12 项通过。语音验收覆盖协议与生命周期，未采集真实麦克风输入。可单独按 MCP Bridge 自带锁文件安装依赖。 [MCP Bridge](../apps/desktop/VCPDistributedServer/Plugin/ProjectForge/mcpbridge/README.md)

默认原生测试 99 项通过，1 项已知群聊预览 TODO；默认协作测试 14 项通过。冻结的服务端源码在独立网络命名空间运行 515 项上游 JS 测试，514 项通过。唯一跳过项依赖操作者现有 VectorStore；本轮另以新建合成星池通过实测。域外 VTrade Store 用固定上游源仅作关停验证。详见[服务端运行回执](evidence/upstream-convergence-r1/server-runtime.json)、[开放 PR 与桌面重载回执](evidence/upstream-convergence-r1/native-pr-and-reload-checks.json)。

## 五项遗留缺陷的复验结果

| 场景 | 本轮观测 | 复现入口 |
| --- | --- | --- |
| 群聊删除与重排并发 | 迟到的原生群重排提交可移除配置中的 `_historyDeleting` 标记。 | [桌面宿主生命周期测试](../apps/desktop/tests/f06-host-lifecycle.test.cjs) |
| TopicSponsor 重放已删除话题 | 相同请求在原服务与重启后的服务均返回 accepted。独立合成复验观察到原 ID 被重新发布，桌面物理 history.json 重建。复现范围限原生桌面宿主。 | [桌面宿主生命周期测试](../apps/desktop/tests/f06-host-lifecycle.test.cjs) |
| 删除中途崩溃 | 在配置更新后退出子进程，重开后重试找不到旧话题，清理没有完成。 | [桌面宿主生命周期测试](../apps/desktop/tests/f06-host-lifecycle.test.cjs) |
| 群聊预览事件 | 应有两名发言者的非流式预览缺少发言者身份。 | [群聊回归](../tests/native/core-group.test.cjs) |
| 群聊深度函数 | 定向与默认回归中函数引用相等，本轮未复现。 | [上下文规则回归](../tests/native/native-context-rules.test.cjs) |

前三项单独执行。群聊预览在默认原生回归中继续执行并报告为 TODO。群聊深度函数引用按普通断言复验。


## 已知能力差异与审查结论

TopicSponsor 的已有目标投递与路由 22 项通过。上游 `mode=new_topic` 的五项新任务话题用例未通过，分别涉及单聊来源、群聊来源、建题后重试、无效或歧义目标、idle-only Flowlock 派工。固定上游在桌面建立本地配置与 History，然后交由本地 admission 执行；当前 Core 合同要求目标话题已存在并经过授权。本轮保留该边界。此差异独立于前述重放已删除话题的缺陷。[详细来源与代码位置](../provenance/desktop.json)

本轮 Core SQLite 所有权及 Work 表结构没有变更。适配集中在 `executeTurn`、HTTP / Core Sink 的结算语义、原生工具派发、日记授权、Desktop/Core 路由与 CDS 客户端握手。原生模型与工具循环继续归 ToolBox，正式消息仍由 Core 单写。日用配置和硬件麦克风、扬声器、Windows/macOS 安装体验均未纳入这次 Linux/Android 隔离验收。

**隔离候选结论为 UPSTREAM_CONVERGENCE_PASS / READY_FOR_STABILITY_R1，范围以上述已吸收能力和明确保留项为准。** [验证摘要](evidence/upstream-convergence-r1/verification.json)

## PR #5 复查

1. Provider 在选择级结束原因同时给出 `stop` 与 `MALFORMED_FUNCTION_CALL` 时，非流式宿主曾执行失败响应中的结构化 FC。候选现在统一识别两个字段中的失败标记；SSE 同时带显式 Provider 错误和 malformed 标记时也停止恢复请求。隔离正式 Work 中两种格式均进入 `review_required`，助手终稿及工具派发记录均为零。
2. 独立 VchatManager 曾按旧配置快照提交话题排序，并发删除时会重新写回已删话题并抹去删除标记。独立管理器没有持有主宿主的配置写入队列。排序、置顶、置底和重置现限于当前视图；配置仍由原宿主发布。主窗已有的群重排、TopicSponsor 删除重放及崩溃续删问题继续留给 STABILITY-R1。
3. 远程 Core 联验在 Electron 冷读和同窗口重载后检查 A、B 两个隔离 Profile 的原生 History 均无正式消息，同时核对 Core SQLite 的终稿、Work 及删除回执。

三端复验固定在修复提交 `9f2ad5e5bd7c03416db6f72694ca67edaa2f6584`，启动与结束均记录为干净工作树。Core SQLite 中按顺序读取的 6 个消息 ID 与 Chromium、实体 Redmi 读到的 ID 逐一相同，3 个独立身份的 3 条 Work 均为 completed；两端 Electron Profile 的本地正式 History 行数均为 0。默认原生回归现在为 100 项通过与 1 项已知 TODO，协作 14 项通过。旧 `4263734` 的三端摘要保留为历史证据；本次复验另行记录客户端脚本、preload、PWA 实载资源和源码提交。 [PR 复查三端回执](evidence/upstream-convergence-r1/pr5-review-three-clients.json)
