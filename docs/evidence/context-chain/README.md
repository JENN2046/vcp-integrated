# 共享单聊的上下文归属

**VCPChat 现在是“从哪个压缩检查点开始给模型看历史”的唯一实现来源。** 基线 `f73493e` 中，原生上下文流水线和 NativeSync 共享 worker 分别执行了内容等价的检查点选择函数。改后，桌面原模块保留原有导出；worker 通过本地包 `@vcp/native-history-window` 直接加载 VCPChat 的同一个模块。取最近有效 v1 检查点并排除 thinking 占位的行为保持一致。[原生实现](../../../apps/desktop/modules/chat/historyWindow/index.mjs) · [共享调用点](../../../apps/server/Plugin/NativeSync/mobile/effectiveContext.js) · [宿主差异](host.patch)

## 从物理 History 到实际请求

对照使用真实 Linux Electron 普通单聊、真实 ToolBox 的共享 HTTP 准入和 worker，以及同一个回环合成 Provider。改前使用独立检出的 `f73493e` 产品源码，改后使用当前分叉。每侧从新 Profile 或新数据库开始。两条路径使用相同的四条种子消息及时间、Agent 名称、系统提示、模型和参数，三条酒馆规则分别追加系统后缀、用户后缀和插入 depth=1 消息。相同的 22 字节 UTF-8 文本文件附在检查点之后的旧用户消息上。桌面 FileManager 存文件，共享端完成上传、校验、claim 和消息关联，读取的字节 SHA-256 均为 `ffab1c37dc2bc342afc7335048ae30f8874555457c3aa65537baa7fd03a9ae2b`。[固定输入](../../../tests/context-chain/input.json)

| 步骤 | 普通原生单聊 | 共享 worker |
|---|---|---|
| 取得输入 | 原生发送按钮 → 本机准入 → 单聊 orchestrator 读取本机 History | 共享准入登记 Work → worker 按已接纳输入的序号读取中央 Journal，纳入应见的前序回复 |
| 选择历史窗口 | `assembleRequestMessages` 调用 `effectiveContextHistory` | `effectiveRequest` 对排好序的历史调用同一原生选择器 |
| 装配请求 | 桌面读取本机附件引用，执行规则，原生 IPC 生成请求体 | worker 按冻结配置和有权限的 CAS 附件组装消息，登记 Work 身份再派发 |
| 抵达模型入口 | `chatCompletionHandler.handle` 收到本机请求身份 | 同一处理器收到与 Work 绑定的请求身份 |
| 观察输出 | 单独在 Provider HTTP 入口读取实际收到的请求 | 同样取证，按原生请求 ID 与 Work、正式回复和 Journal 对齐 |

在两组正式前后对照里，处理器入口均收到六条消息，依序是「系统提示与系统后缀、检查点、含附件正文的旧用户消息、旧助手回复、深度注入、带用户后缀的当前输入」。检查点之前的 `CTX_BEFORE_CHECKPOINT` 仍在两条路径的持久历史里，模型请求均从 `CTX_CHECKPOINT_V1` 开始取对话内容。四条时间戳绑定对应同样的位置 1、2、3、5。

**归属有运行证据。** Electron 的 Chromium precise coverage 将原生选择调用定位到改前的 `contextCompactionState.js`，改后定位到 `historyWindow/index.mjs`。共享 worker 的观测在原函数实际返回时记录了输入、输出 ID 及加载文件。改前命中插件镜像（SHA-256 前缀 `ca2a2e8b`），改后命中桌面原生模块（`bc6ac15b`），两次均从五条候选消息选出四条。测试同时检查桌面导出和 server 解析到同一函数对象。[改前完整合成 body、History 与回执](before.json) · [改后完整合成 body、History 与回执](after.json)

## 包差异与验证口径

- **同一路径前后**，完整 handler 入参 body 和 Provider 实收 body 均通过结构化深比较。归一项为新建的操作、对象和话题 ID，本机点击产生的时间，以及每次新建的合成 Profile 路径。附件路径变化会连带改变文本哈希；逐一从原始消息重算验证所有绑定哈希后，再按归一化路径复算。两份 JSON 保留归一化前的请求体，不含 HTTP 鉴权头。
- **本机与共享之间**，桌面系统提示包含本机 History 路径和话题创建时间；附件标签携带本机文件 URI，共享标签只用文件名。桌面对话正文抵达 handler 时是字符串，共享正文是 text part 数组。本次桌面当前用户消息有 `name`，共享提交未携带。Provider 端两者的当前用户消息均无 `name`。两条路径的规则位置、附件正文和实际消息顺序一致。模型均为 `synthetic`、非流式、temperature 0.5、max_tokens 128；处理器收到 contextTokenLimit 32000。
- **幂等与恢复**，正式改后对照的共享 Work 为 `request_74ffc8c4675945e6b1b3f5561bd86d76`。查询原请求并重放同一 body，回到原 Work，仍是一次派发、一次 Provider 调用。原 Journal 的 4 条种子消息后只有序号 5 的输入和序号 6 的回复。另从真实 Electron 跑了准入前拒绝、接纳后丢回执并重开、非空正文后断流并重开；三个用例全部通过，未知终态保持待核对。[故障回执](recovery.json)
- 定向选择与原生压缩测试 26/26，原生业务回归 199/199，协作与恢复回归 49/49。测试组之间有交集。隔离目录中从锁文件执行 `npm ci` 后，服务端也能加载同一原生模块。此批结论限于共享单聊、本机单聊和上述配置；执行归属、配置冻结、附件权限及工具结算沿用原路径。

根目录的 `npm run test:context` 可重跑一次普通单聊、一次共享发送及原请求重放。使用 Node 24 和已构建的 Linux 集成宿主；结果写入新的 `.runs/context-chain/server/run-*`。Xvfb 不在 PATH 时可指定 `XVFB_BIN`。

用 `node tests/context-chain/compare.cjs docs/evidence/context-chain/before.json docs/evidence/context-chain/after.json` 可重新比较两份已保存的完整请求，并逐条验证时间戳绑定。
