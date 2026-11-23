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

固定候选 `7829b83ccb63` 完成 Linux、原 Windows 虚拟机及 Android 16 的同一 Work 核对。Android 系统选档、拒绝后保留附件改发、丢回执后找回原 Work 均已实测。首次配对显示已连接后 108 毫秒内强停，冷开仍需重新配对。[本轮差异、回执与截图](evidence/three-client-candidate/README.md)

Android 首次配对立即强停已定位到隔离 WebView 的 Cookie 写盘时序。测试壳在会话查询前等待写盘，原手机冷开能以同一会话标识直接恢复。[改前改后回执与冷开截图](evidence/android-pair-force-stop/README.md)

在原 Android 16 的独立用户中，Firefox 已安装 PWA 首次配对后强停也会丢失 Cookie。补上设备签名恢复后，82 毫秒强停并冷开，页面自动找回原 sessionMarker，中央仍只消费一枚配对码、保留一条会话。[实体手机前后对照、产品差异和截图](evidence/android-installed-pwa-pair/README.md)

双桌面空闲复测三个一分钟窗口。复用同轮目录扫描得到的话题配置后，两端合计每分钟少读 72 次配置文件、33,792 个逻辑字节。观察端离线后重开追平原游标，在线第三轮收到完整回复。[空闲复测和恢复回执](evidence/idle-review/README.md)

共享桌面已接入空间 SSE、事件唤醒、故障退避和 15 分钟审计。12 组共 372 个实测分钟；大健康夹具含审计的 31 分钟均值为每分钟 0.52 次新同步请求、0.0168 MiB 归因逻辑读取、0.0368 核秒归因 CPU。低负载同话题新增、编辑、删除均在 1 秒内可见，高并发主机上的新增和删除观测曾超出 1 秒。[分项回执、可见性边界与复现方法](evidence/shared-watch/README.md)

普通共享单聊的桌面右键菜单现在按原消息 ID、内容 hash 与 Journal 序号编辑或删除已确认的助手回复。两台真实 Electron 从序号 2 的正式回复读到序号 3 的修订、序号 4 的墓碑，A 重开后与 B 一致；计数工具共执行一次。本机单聊从同一菜单改删、重开，中央没有新增记录。[菜单回执与截图](evidence/shared-message-menu/README.md)

普通桌面 IPC 和共享 worker 共用请求封装实现。固定 History、酒馆规则和附件后，实际 Handler、Provider 请求按各路径归一比对一致；原共享请求重放只返回原 Work。插件内仍有三处包外规则实现。[实际加载与组包对照](evidence/request-envelope/README.md)

原生 Agent 表单沿用共享 GET 的配置完整性判断，四次首次共享保存的预读校验合计从八次降至四次。隔离对照覆盖本机保存、共享名称与头像、旧版本冲突和已提交丢回执；错误 hash 在任何配置 POST 或本机写入前被拒绝。[保存链路、文件和中央回执](evidence/native-config-write-path/README.md)

以上三项合并后的原生套件 256 项通过、6 项因原压缩夹具未提供而跳过，协作套件 60 项通过。另跑的侧聊删除夹具有 7 项在创建测试 History 时返回 HISTORY_OWNER_MISSING；干净的改前基线也在同一处失败。

`nativeRules` 剩余三个入口已完成归属复审。实测后，普通单聊时间戳标注归到原生 History 包，群聊模型选择和流片正文提取归到共享规则包。统一模型 ID 带首尾空格时，共享派发与获准图片的准入恢复；模型授权仍按规整后的精确 ID 校验。所有旧入口保留兼容转发。[复审与前后回执](evidence/remaining-rules/README.md)

固定候选 `9890ce016598` 完成干净重建和三端隔离收口。Linux、原 Windows R16 虚拟机和原 Android 手机上的已安装 Firefox PWA 在重开后各自读回同一已完成 Work 和同两条消息；中央一次尝试、一次派发、一次合成 Provider 请求。手机隔离用户 12 按 Jenn 的选择保留。[构建哈希、三端核对与截图](evidence/release-9890ce016598/README.md)

显式共享工具单聊已支持第一代在同一个模型响应中顺序执行两个不同的名单内直连工具。新桌面与 ToolBox 协商后在接纳时冻结上限，旧 Work 和旧客户端保持单工具语义。原生回执与调用账本逐项核对后，A 才能压缩、B 才能接管原 Work 并显式继续。真实双桌面对照中，第二个计数落盘后丢失回执时，ToolBox 重启保留第一项 returned、第二项 started 和原 Work 的 review_required；压缩、接管、继续均被拒绝。[同一代双工具前后对照、截图及重跑命令](evidence/tool-work-handoff/duo/README.md)

第 2 项显式 AA 父子任务接续已通过隔离双桌面验收。A 退出后 B 能观察原生子任务；只有父调用结算、子任务成功终止并核对原报告后才能接管。B 丢接管回执后使用同一 Profile 找回原 Work，完成压缩和续写。子模型派发后强停、报告哈希冲突均保留原身份待核对，未重新委托。[前后回执、故障对照、截图与复跑](evidence/aa-handoff/README.md)

显式两成员纯文本顺序群聊已有跨设备成员接力。甲正式回复的 Journal 提交与暂停位置同事务确认，Y 接管并另行继续后，乙才使用原计划和原生请求 ID 派发。丢失接管与继续回执的双桌面复跑中，成员各派发一次；两种成员中断窗口均保留未知原请求。首次使用会写入共享 schema 3，回退边界见[完整实测、请求包及截图](evidence/group-member-handoff/README.md)。

说话人语义已对齐作者的桌面群聊和 ToolBox 出站边界。不同成员同文保留不同身份，历史正文带本人署名时只保留一次；已提供的对话展示名在工具循环内保留，在 Provider 副本清理。双桌面接力的乙请求仍按原消息 ID 绑定甲，两成员各派发一次。[基线、候选、请求摘要与截图](evidence/speaker-semantics/README.md)

工具结果在原生 ToolBox 回填时保留文本、JSON 文档和多模态部件。回环 Provider 逐轮记录了 JSON 与 SSE 两条路径，另有双工具、AA 接续回归。[工具回填前后对照](evidence/tool-payload/README.md)

单聊压缩现在识别 ToolBox 代理返回的上游拒绝状态。配置备用模型时，明确的 HTTP 400、404、422 或 429 可以触发一次备用尝试。鉴权失败和状态未明的断流保留原 History。历史中已有错误摘要时，桌面和共享 worker 从最近有效检查点继续；提交回执丢失后按原意图核对。[压缩、重开与原 Work 接续回执](evidence/compaction-fallback/README.md)

TopicSponsor 的 River 引用对齐作者的最近消息窗口。两位成员同文和一条无名短消息经工具派发、桌面投递和冷重开后仍逐行对应；旧 V1 与作者 V2 均能读取。共享目标在提交后丢回执时仍按原收据恢复。[工具对照、History 与冷开截图](evidence/river-quote/README.md)

在群聊接力原故障库的隔离副本中，当前执行端人工结清了乙已派发、结果未知的原 Work。丢失结清回执后重开，桌面同时显示接力已结束和乙结果未知。甲的正式回复仍只有一份；新的普通群聊轮次在同一话题完成。只读会话能观察原 Work，三项代办操作均被拒绝。[改前改后回执及截图](evidence/group-review-closeout/e2e/README.md)

普通共享单聊遇到上游 502 时，错误说明在流读取入口截断，Work 与准入进入待核对，Journal 和桌面 History 保留用户输入。原作者人工结清后，可在原右键菜单删除这类无正式回复的输入，中央按原消息 ID、版本和 hash 追加墓碑。两端删除及重开、原提交重投、同话题新请求和旧版遗留的待发布意图均已核对。[502 收尾](evidence/shared-upstream-closeout/desktop/README.md) · [删除与权限](evidence/shared-upstream-closeout/delete/README.md)

共享单聊已验一份 67 字节 UTF-8 文本跨端续问：A 的本地原件和缓存移离后，B 重开原话题且未附加文件，中央 worker 的 Handler 与 Provider 各收到一次原附件正文。A 首轮桌面原生请求仍含本机路径，B 的服务端续问请求没有。私有实时引用只携带引用元数据，跨空间读取共享附件被拒绝。[双桌面收包、权限对照与截图](evidence/shared-attachment-continuation/README.md)

普通桌面和桌面执行的共享单聊均在原生 renderer 生成 History 提示与附件标题。共享首轮已移除本机 History 投影路径；显式禁工具时，已内联正文的文本附件只带文件名，默认可调用工具时保留定位 URI。A 退出后的 B 续问仍只得到一份原文件正文。[本机与共享收包前后对照、文件工具实测](evidence/attachment-path-ownership/README.md)

共享 A 首轮文件工具已验证跨端实取：在 ToolBox 看不见 A 附件缓存的独立挂载中，合成 Provider 以实际收到的完整 URI 发起一次摘要工具调用，A 经原生 WebSocket 返回 67 字节，工具回填与原文件 SHA-256 一致。只读内联正文无需取件；同工具只传显示文件名得到 ENOENT。[三组回执、源端字节及工具账本](evidence/file-uri-roundtrip/README.md)
