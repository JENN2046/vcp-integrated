# STABILITY-R1 日用前稳定性候选

起点和代码回退入口为 [UPSTREAM-CONVERGENCE-R1 合并提交](https://github.com/JENN2046/vcp-integrated/commit/5a0969e796778e8636bcdbc36fb039653f289216)。以下验收使用隔离数据。独立 Electron Profile 的配置与物理 History 由桌面宿主持有；接入 Core 的正式会话由 Core SQLite 持有。两条路径分别验证。

## 群聊排序与删除

主窗拖动原先经 `save-group-topic-order` 独立读取、改写群配置。读取与写回之间若群聊已删除，旧快照会清除 `_historyDeleting` 并重新发布旧话题。该 IPC 现在调用 `mutateGroupConfig`。操作排到队首后读取当前配置，只取排序指令中仍然存在的话题 ID，并保留未列入指令的当前话题；成员、标题、删除事实与其他字段继续来自宿主最新状态。

在落盘读取与队列发布之间交错执行重排、删除，旧基线能覆盖删除标记，候选保持标记与物理清理结果。真实 Electron 另经主窗 preload 保存顺序，冷启动重读同一 Profile，再依次核对话题删除、整个群删除、旧设置保存与迟到 History 写入。[生产入口](../apps/desktop/modules/ipc/chatHandlers.js) · [文件并发回归](../apps/desktop/tests/f06-host-lifecycle.test.cjs) · [Electron 联验](../tests/integration/desktop-lifecycle.cjs)

## TopicSponsor 已删除目标与历史回执

旧宿主从缓存返回创建或回复成功时，没有重新确认目标仍然存在。原生 Agent 删除又可能已移除话题成员、却没有写下删除墓碑；重放同一创建请求因而会重建同一 ID 和 History。另一个窗口出现在已受理的回复：旧版进程把请求记在内存，队列完成后清空，重启再投递可能产生第二条消息。

候选在原生配置中保存删除事实。投递先解析本次源、目标、发送者和意图，再检查当前可写性；回执返回前重新检查。带请求 ID 的回复复用原有 admission 文件的 v3 `dispatchReceipts`，在同一次持久化中记录请求证明、目标作用域、原 entry ID 和消息 ID。合法重放返回原受理身份，目标已删或参数冲突则拒绝。交接后中断的 `advancing` 项继续按 `uncertain` 恢复，不借旧回执续派。

已确认删除的重放在配置写队列内走不写盘分支，原生写权恢复后向调用方返回拒绝。另一合法话题随后能直接提交 History。升级能保留尚在 v2 队列中的受理身份及已有 v3 收据。对已在旧版本完全结算且失去请求 ID 对照的信息，无法追溯旧投递；本轮不从消息文本推断执行事实。[TopicSponsor 受理与冷重放回执](evidence/stability-r1/topic-sponsor.json)

## 删除中断恢复

旧 Agent 删除先改话题成员关系，再直接清理目录。配置中已没有目标时，旧路径报“未找到话题”，即使磁盘仍有 History，也无法续作。候选将移除成员与追加 `_historyDeletedTopics` 放入原配置写队列的一次原子发布；后续清理由原生 HistoryMutationQueue 承接。在冷进程中，确认目标仍有同一墓碑后可重试清理。删除最后一个话题时，只初始化此次删除创建的 replacement。已存在的 replacement History 原样保留，迟到写入和同 ID 重建仍被拒绝。

进程在配置发布尚持锁、配置更新已解锁、递归清理进行中、清理完成尚未回执四个位置收到 SIGKILL。另起进程核实物理残留、连续续删和旁支话题。破坏性清理前检查真实目录和 owner 身份；失败的相关 SideChat 清理可以在重试时完成。已存的配置锁不被抢占。旧版本若已留下孤儿目录却没有可证的墓碑，仍需人工核对归属，不能仅凭目录存在判定可删。[崩溃与冷恢复回执](evidence/stability-r1/native-delete-recovery.json)

## 群聊预览

CoreRunner 原已在轮次开始时产生稳定成员 ID、显示名与步号。移动端安全投影重建 `work_preview` 时漏传 ID 和步号，PWA 还会过滤非流式轮次的空正文；Electron 活动视图缺少常规群成员展示。候选沿用原有事件合同，把成员身份带到两个入口。非流式等待期间展示当前成员，流式增量归入同一轮。正式消息仍在 Work 结算时提交。

合成 Provider 控制两名成员分次回答，真实 Electron 与 Chromium PWA 在同一隔离 Core 观察 Ada（非流式）及 Bruno（流式）。每次新成员等待时，数据库中只有前面已确认成员的正式回复；完成后两个入口用正式消息替换活动预览。取消、流中断及观察重连另由原生群聊回归验证。[原生专项](../tests/native/core-group.test.cjs) · [双端场景](../tests/integration/core-group-preview.cjs)

## 日用边界

本轮保留上游收敛的独立能力差异：TopicSponsor 的 `mode=new_topic` 新任务派工、独立 VchatManager 的持久化排序和原生群聊结构化 FC 历史继承。主窗群聊手工排序有自己的宿主写入队列，不改变独立管理器的视图排序行为。可信人类高敏授权 `vcp_chat.c2` 维持 `DEFERRED_FAIL_CLOSED`。

代码回退适用于隔离候选。日后若开展日用试用，Core 的数据库、附件和设备会话，以及独立桌面的配置与 History，分别保留同一停机时间点的备份；回退代码不能还原已经合法删除的数据。旧宿主保存受理队列时可能丢弃新增的 v3 回复收据，回退演练应关闭候选，用基线代码打开升级前一致备份的副本，单独保留候选数据供核对。本轮未操作日用数据和生产环境。

## 运行源码变更

| 链路 | 变更位置 |
| --- | --- |
| 独立主窗重排与群删除 | [chatHandlers.js](../apps/desktop/modules/ipc/chatHandlers.js)、[groupchat.js](../apps/desktop/Groupmodules/groupchat.js) |
| 删除授权、清理与重试 | [historyMutationQueue.js](../apps/desktop/modules/services/historyMutationQueue.js)、[sideChatHandlers.js](../apps/desktop/modules/ipc/sideChatHandlers.js)，以及上行两个宿主入口 |
| TopicSponsor 创建、解析、投递和受理 | [pluginAgentOperationService.js](../apps/desktop/modules/services/pluginAgentOperationService.js)、[topicConversationResolver.js](../apps/desktop/modules/services/topicConversationResolver.js)、[topicSponsorDelivery.js](../apps/desktop/modules/services/topicSponsorDelivery.js)、[topicMessageAdmission.js](../apps/desktop/modules/services/topicMessageAdmission.js)、[agentConfigManager.js](../apps/desktop/modules/utils/agentConfigManager.js) |
| Core 观察与两个客户端 | [service.js](../apps/server/core/service.js)、[coreSingleClient.js](../apps/desktop/modules/services/nativeSync/coreSingleClient.js)、[sharedSessionView.mjs](../apps/desktop/modules/services/nativeSync/sharedSessionView.mjs)、[App.vue](../apps/mobile/src/App.vue) |

## 验收与复跑

- 独立桌面生命周期：`npm run test:integration -- desktop-lifecycle`。实际 Electron 使用同一隔离 Profile 两次冷启动；未删除的对照话题在重启后有真实写入，再检查已删话题的拒绝原因和磁盘状态，区分删除保护与宿主尚未就绪。
- 正式 Core 与客户端预览：`VCP_TEST_CORE_GROUP_PREVIEW=1 npm run test:integration -- core-remote`。[群聊预览回执](evidence/stability-r1/group-preview.json)
- 仓库默认入口为 `npm run build`、`npm run test:native`、`npm run test:collaboration`；远程恢复、权限、附件及同址换库通过 `VCP_TEST_CORE_RISK=1 npm run test:integration -- core-remote` 复验。图形联验使用 Xvfb 与 Chromium。
- 在相同 Node 版本、隔离夹具和相同用例集合下重跑已知的 25 项桌面失败。另对照原生 History 的旧套件，其用例与其他专项有交叉，分别列出分母、用例名及基线结果。[桌面及 History 基线对照](evidence/stability-r1/baseline-comparison.json)

**隔离验收结果为 `STABILITY_R1_PASS / READY_FOR_PILOT_PREPARATION`。** 实测产品提交为 [`71de323`](https://github.com/JENN2046/vcp-integrated/commit/71de323c91dbb424da2ab7c3600e51fea9b0cf21)，回退基线为 `5a0969e`。独立 Electron、Core local、Core remote 数据风险、群聊双端观察以及独立桌面 FC 冷重放均在该干净提交完成，运行开始与结束的输入树一致。 [统一验收回执](evidence/stability-r1/acceptance.json)

默认原生 **103/103**、默认协作 **14/14**、原生删除与 TopicSponsor 联合专项 **74/74**、群聊与上下文 **18/18** 均通过。桌面已知对照为两版相同的 25 项失败；额外 106 项历史合同对照中，两版均为 83 过、23 失败。后者包括直接移除仍登记话题的物理目录，以及依赖旧仓储 API 的场景。上述旧失败没有通过放宽断言消除。一次 PWA 图片视口等待以及一次 Electron 冷启动后第二条助手回复等待曾超时，分别在原断言下复跑通过，保留为试用时的观察项。独立 TopicSponsor 新话题派工的五项用例继续作为已知能力差异保留。
