# 三端集成分叉 · 2026-11-20

基线提交为 `c837e2a`，来源为 NativeSync `7fb8bdbd` 和候选 `NS-NATIVE-OPS-d5a7f9b15f35`。Linux 联验的源码提交为 `c379d0c`。新仓包含桌面、服务端、手机源码和共享规则。上游仓库、原工作树以及原审阅包继续保留。[桌面来源](../provenance/desktop.json) · [服务端来源](../provenance/server.json)

在第二份独立检出重新安装并构建后，六个真实 Electron 系统场景全部通过。原生业务测试 197/197，协作与升级恢复测试 49/49，所选桌面宿主回归 132/132，共享规则回归 51/51，Feature 与启动回归 28/28。各组覆盖存在交集，分别计数。测试结束时 Git 工作区干净。

## 原生用户操作

| 操作 | 所有者及本轮验证 |
|---|---|
| 共享发送、重开 | 桌面先留存输入和操作 ID。ToolBox 接纳 Work 并派发，中央 Journal 确认正式消息。成功回执丢失后，按原 ID 找回同一 Work；观察端关闭不增加 Provider 调用。用户主动再发同文得到独立身份。 |
| 断流与本机发送 | 首段已可见时切断回环 TCP，原生请求保留 unknown，Work 保留 review_required。相同终态和水位重放仍会核对物理 History，已确认投影无需再写一遍 pending。普通本机输入和回复均进入本机 History，共享准入为零。 |
| 改名、头像与删除 | 快捷改名携带用户开始编辑时看到的版本；冲突保留输入，丢回执按原操作核对。原生表单一起改名和换头像只提交一个版本，两端头像字节相同。配置旁文件、设备级移除和全端墓碑沿用现有归属入口。 |
| 群聊、手机与工具 | 服务端保留已选发言计划。独立手机会话能配对、观察原 Work 并重载，TopicSponsor 复用已定向的投递。工具到达后丢去结果会进入待核对状态。由合成接收方计数，审批和工具路由使用宿主实现。 |
| 退出与恢复 | 桌面冻结准入，排空已接纳的工作，再停止 History 权威和 CDS。只终止 Electron 主进程，受管 CDS 随父控制管道断开释放锁，原 Profile 能重开。另用同一合成库完成基线正常退出、派发后进程被杀、候选恢复及基线代码回退，保留 ACK、Cursor 和未知执行身份。 |

[逐请求回执、两端 History 与截图](evidence/linux-acceptance.json) · [退出与异常重开](evidence/desktop-shutdown.md)

## 消除的重复和保留的边界

- 两个宿主从本仓同一份 core-rules 加载群聊窗口、发言模式、请求 URL、流监视器、上下文清洗、酒馆规则、工具结果扫描及轨迹实现。浏览器直接加载的脚本在构建时生成。上下文清洗使用各宿主锁定的 DOM 依赖；共享轨迹的持久记录选项继续生效。四份协议构建产物仍来自唯一契约源码。
- 桌面按实际模块入口注入同步服务，普通 Feature 获取公共宿主接口。新仓复用了原生 History 写入队列、共享配置版本提交和服务端执行账本。具有不同调用约定的消息元数据及续接适配仍由对应宿主维护。
- 本分叉实测的旧手机协议为 wire 1.5。它能写普通本机话题，遇到受保护的同一物理 History 会收到 `SYNC_WRITER_EXCLUDED`。固定作者版本的 wire 1.6 未实现该宿主写入约定，在服务注册前被拒绝。该结论覆盖本宿主加载的写入路径；独立运行、直接修改文件的其他进程不在此次验证范围内。移动同步 HTTP 日志仅保留操作、路径及状态，成功和拒绝路径均检查凭据与查询串没有进入日志。
- 两组各测三个完整空闲分钟。已有 Cursor 为 0、基线水位也为 0 时，原代码反复写回相同状态。修复后两端归因到这条路径的写入从 **1,438 次、851,296 字节降到 0**。两组后端请求均为 **34 次/分钟**，其中 24 次 shared/info。读、CPU 和请求分列记录；本轮只将可重复解释的写入差值归因于该修复。[同口径空闲测量](evidence/idle.json)
- Node 24、CDS、Vexus、Electron preload 与手机静态资源均从锁定输入安装或构建。上游完整普通插件目录未作为默认可发现插件启用。本次另构建了普通管理 UI 和日记检索程序，验证管理服务的回环入口。日用、验收及生产实例未安装。
- Linux 用户的 inotify watches 上限从 65,536 临时调至 262,144；实例数上限仍为 128。独立 fs.watch 以及真实后端 Vexus 监听启动通过。该修改未写入开机配置。测试 Profile 的 CDS 文件通知与全文索引开关沿用了夹具设置。

## 设备验收进度

初次 Linux 联验使用两个隔离 Electron Profile 和独立的 Chromium 手机会话。后续在 Android 16 实体手机上完成同一 Work 的运行中观察、锁屏、断开测试通道、强停临时 WebView 和重开后的终态核对。手机与 Linux 的输入、回复及中央 Journal 的 ID 一致，Provider 共调用一次。临时手机应用已经卸载。Linux 草稿保留；实体联验期间记录到一次终态刷新后选区变空，独立 pointer 选区用例未稳定复现。[实体 Android 回执与截图](evidence/android-device/README.md)

原 Windows 11 虚拟机上的同版联验已完成。使用原基盘的独立写入层，以 R16Limited 正常登录。Windows B 在 Work 完成后加入，在真实窗口读到输入和回复；已落盘 History 的两个 ID 和正文与 Linux、实体 Android 及中央 Journal 一致，Provider 共调用一次。Windows 使用测试进程专用的 HTTPS 信任配置。三端分别在运行中或完成后观察了同一 Work，三端同时观察流式正文仍属此次用例之外。[Windows 与三端汇总回执](evidence/windows-device/README.md)

本机开发仓保留已构建的桌面、服务端、PWA 和 Node/Xvfb 工具链。Linux 干净检出的重建产物已回收；脱敏回执与截图随提交保留。

后续长回复实测覆盖了实体手机首段观察、锁屏恢复及 Windows 阅读位置独立对照，见[长回复联验记录](evidence/long-stream/README.md)。

共享单聊的 History 窗口已交还原生 VCPChat。普通桌面和共享 worker 的实际 handler 与 Provider 请求、附件及原操作恢复对照见[上下文归属回执](evidence/context-chain/README.md)。

共享单聊中的普通直连工具已接入原生审批等待和持久调用记录。停止后迟到批准、工具已执行后断电以及桌面重开的前后对照见[普通工具审批与恢复](evidence/ordinary-tools/README.md)。

单台有审批权限的桌面现在可以在重开后找回原 Work 的待审批卡并直接处理。审批原始 ID、取消和自然到期对照、只读 PWA 观察见[单桌面审批恢复](evidence/approval-restore/README.md)。

AgentAssistant 长委托已接入共享单聊的 Work。桌面重开、发起端停止、只读 PWA 看报告以及 ToolBox 中断后的原身份核对见[共享委托实测](evidence/aa-delegation/README.md)。

共享单聊的酒馆深度注入现由 VCPChat 的同一原生入口定位。带有历史系统消息的输入在两端得到相同的注入位置，实际请求、附件和恢复回执见[单聊酒馆规则对照](evidence/context-rules/README.md)。

共享群聊的「取消剩余接力」现允许已认领的成员完成，并阻止后续成员派发。原生桌面对照、PWA 实测、工具审批及进程中断恢复见[共享群聊取消剩余接力](evidence/group-relay/README.md)。

群聊逐成员上下文现复用原生桌面的酒馆深度规则。A 的正式回复在 B 的 handler 和 Provider 请求中均恰好一次；同一 History、规则、附件与发言计划的前后对照见[群聊逐成员请求验收](evidence/group-context/README.md)。

在进入「压缩后跨端接续」前，阶段复审核对了群聊、原生审批和 AA 的组合故障，并复现普通群聊收尾与共享压缩输入的两项阻断问题。[职责归属、实测回执和开工判断](evidence/stage-review/README.md)

普通共享群聊的成员回复与 AA 已按同一组证据结算。两种完成顺序及原故障库升级结果见[群聊收尾修复](evidence/group-settlement/README.md)。阶段复审记录中的压缩输入问题另案保留。

共享单聊压缩输入已按原消息 ID 和 Journal 当前版本处理编辑与删除。同文不同 ID、真实桌面生成检查点以及重开后的模型请求见[压缩输入交付](evidence/compaction-input/README.md)。

本机单聊的六项自动中断测试已通过。真实桌面在两种角色分隔设置下均能在工具返回处中断，部分回复以原 ID 落盘后触发自动压缩。基线、候选、重开结果与截图见[本机流式中断回执](evidence/local-stream-interrupt/README.md)。

共享单聊已完成 A 发布检查点并退出、B 重开同话题发送和丢接纳回执后的恢复验证。原生窗口按 Journal 消息顺序选择检查点，两次独立桌面实测均找回原 Work，无重复派发或工具执行。[跨端接续差异、回执和截图](evidence/cross-device-compaction/README.md)

同端压缩的两条中间故障已复现。桌面现在核实原子替换后的实际配置路径，并在持久化准备回执前登记活跃压缩意图。同端重开及跨端丢回执恢复均已复验。[原故障、宿主差异与验收回执](evidence/compaction-failures/README.md)

工具型共享单聊支持在第一个已确认的直接工具回执处暂停。A 压缩后，B 可以在同一 Work 中接管并生成文本；副作用不明时保留待核对状态。流式与非流式、丢接管回执、ToolBox 强停重开及重复工具请求见[工具 Work 的跨端接续](evidence/tool-work-handoff/README.md)。

共享检查点提交后的 History 身份报错已用真实投影重放复现。A 的共享读现在与原生话题写队列串行；本机确认失败后重试会找回原压缩意图与检查点，B 能用同一检查点继续。[文件身份、宿主差异与回执](evidence/history-identity/README.md)

工具 Work 的 B 末代已派发、终稿尚未送达时退出：未得到模型终态会保留待核对；ToolBox 已输出全文但 B 未发布时，重开仍无法恢复终稿。中央 Journal 已经接受终稿、只丢发布回执的对照通过。[最终确认窗口实测](evidence/final-work-receipt/README.md)

工具型共享单聊的 B 末代已接入 ToolBox 原生终稿持久化。B 收到 JSON 或 SSE 最终响应前退出，重开能按原 Work、代次和回复 ID 取回一条正式回复。归档 fsync 后强停、迟到补交、未知派发及损坏凭据的结果见[原生终稿发布与恢复](evidence/native-final-publication/README.md)。

共享单聊阶段复审核对了普通 server-session 和受控工具 Work 的两条执行路径。普通 worker 在发布意图写入前仍有终稿恢复缺口；检查点以前的桌面引用也会影响后端准入。工具 Work 末代迟到补交保留编辑与删除，旧库的回执兼容仍有实际用途。[职责、实测发现与下一批顺序](evidence/shared-single-review/README.md)

普通共享单聊 worker 现在能从原生终稿凭据恢复原回复发布意图。JSON/SSE、手机共享消息入口、两次重启、损坏凭据和仅派发对照见[普通 worker 终稿恢复](evidence/ordinary-final-recovery/README.md)。

普通共享单聊的桌面路由、中央准入和 worker 现按同一 Journal 检查点窗口核对桌面依赖。已归档的 Canvas 和文件引用不再阻塞后端；有效依赖仍走桌面路径，PWA 在接纳前得到拒绝。[窗口对照回执](evidence/portable-context/README.md)

PWA 普通共享单聊在可证明尚未派发时按原 Work 回到队列；派发意图已写、结果未知或身份不符时保留待核对。取消记录保持终态。[强停、两次重启和原请求重放回执](evidence/mobile-undispatched/README.md)

桌面 Main Chat IPC 的 18 项流式验证已修复。真实 Electron 核对了 DONE 后连接保持打开、部分正文后断流及 Stop 回执丢失时的唯一收尾、reader 解锁与重开后的持久记录。[差异和三窗口回执](evidence/desktop-stream-close/README.md)

Android 16 实机已验证共享发送的两个恢复入口：明确 409 后冷开可编辑原草稿并复用原上传；成功 202 被截断后冷开核对原 Work，模型及工具调用数保持不变。[实机前后对照、截图与清理回执](evidence/android-send/phone/README.md)

已支持原生终稿发布的显式工具 Work，其 B 末代现凭原 Work、代次、回复 ID 和 Journal 水位只读收尾。新组合完成补交为零，旧组合保留兼容补交，编辑和墓碑均经实际窗口复验。[B 末代终稿读回](evidence/final-readback/README.md)
