# 两成员群聊桌面接力

## 改动前的三个断点

基线检出为 `88a5d8f1ff1d6f52987e09fb1e091e8bab94be65`。两台独立 Profile 的沙箱 Electron 通过回环 HTTPS 连接真实 ToolBox，使用各自的 CDS 及 History。发送通过普通群聊输入框和发送按钮。回环合成 Provider 可精确阻塞任一成员的流。三个基线和候选复用同一份两成员顺序群及输入种子。记号 A、B 指群成员。桌面 A 发起，桌面 B 断开后重开同一 Profile。

| 断点 | 原 Work 重开后 | 原 History | Provider A/B |
|---|---|---|---|
| A 已显示 SSE 前缀，未提交 | `review_required`，A 为 `unknown` | 原输入 | 1/0 |
| A 已提交，B 的请求在到达 ToolBox 前被代理扣住 | `dispatched`，A 为 `model_terminal`，无 B 请求行 | 原输入、唯一 A 最终回复 | 1/0 |
| B 已显示 SSE 前缀，关闭发起桌面并重启 ToolBox | `review_required`，A 为 `model_terminal`，B 为 `unknown` | 原输入、唯一 A 最终回复 | 1/1 |

每个 JSON 保存同 Work 检查、请求 ID、群成员 ID、模型包、退出结果与加载的服务端文件摘要。每个断点配一张关闭发起桌面前的截图和一张另一桌面重开后的截图。

测试入口为 `node tests/group-member-handoff/run.cjs a-partial|a-committed|b-unknown`。使用带 Node 24、Xvfb、Chromium 沙箱、CDS、Vexus 和移动页面构建产物的隔离检出。所有输入、身份、数据和模型回复均由夹具生成。

## 共享数据库兼容性

服务端首次接纳显式接力时，在同一事务写入共享 schema 版本 3。合成库验证显示，基线 `88a5d8f` 的完整模式与配置专用模式均以 `SHARED_SCHEMA_UPGRADE_REQUIRED` 拒绝启动共享服务，当前版本可继续打开。首次接纳之前可以仅回退代码。接纳后应使用支持版本 3 的服务端保留并恢复当前 Work。需要在旧服务端验证回退时，应把功能启用前另行保留的一致备份恢复到独立数据目录，保留当前数据库、Journal 与执行归属。

## 候选的实际双桌面流程

用同一两成员群启动显式接力。桌面 A 完成第一位成员并正常退出。强停并重启实际 ToolBox 后，SQLite 中原 Work、甲最终回复、归属版本、请求状态及 Journal 逐项保持一致，Provider 仍只收到甲的一次调用。桌面 B 点击接管，回环 HTTPS 代理等到 ToolBox 成功提交后，只转发一个响应字节就断开连接。B 强停并重开相同 Profile，看到原 Work 等待继续。在正常完成分支中，代理也截断第一次继续的成功回执，服务端已保存 `continuing`，此时仍没有乙请求。B 再次强停并重开，点击继续时以完全相同的 opId 和参数重试，随后仅派发一次乙请求。

- `candidate-handoff.json` 保存原 Work 与乙的 native request ID、接管回执、History 和 Journal，以及真实 ToolBox handler 和回环 Provider 收到的完整合成乙包。甲的原 Journal 消息保留原 ID、共享成员 ID、名称和正文。乙 handler 包上的时间绑定指向该消息原 ID、时间、索引和正文哈希。重开和乙流式显示时，桌面仅显示一个甲回复。handler 与 Provider 包各含一次同一署名的正文 `[A的发言]: RELAY_A_FINAL`。两成员各调用一次，最终三条 Journal 记录分别是原输入、甲、乙。
- `candidate-handoff-unknown.json` 记录 B 已实际收到乙流前缀后断流、强停 B 和重启 ToolBox。B 重开后原 Work 为 `review_required`，乙原请求为 `unknown`，控制面禁用接管和继续。已用完全相同的乙 handler 包在同一身份下尝试本机原生 HTTP 调用，ToolBox 返回 HTTP 409 `SHARED_GROUP_HANDOFF_FENCED`，检查前后持久状态相同，A/B 调用数仍为 1/1。
- `candidate-handoff-a-partial.json` 记录显式接力中 A 已收到并显示甲的 SSE 前缀。此时 B 的接管按钮禁用，专门用 B 身份提交接管请求实际返回 HTTP 409 `SHARED_GROUP_HANDOFF_FENCED`。A 强停及 ToolBox 重启后，甲原请求为 `unknown`，原 Work 为 `review_required`。Journal 只有原输入，调用 A/B 为 1/0。
- 截图覆盖 A 暂停、B 丢接管回执后重开、乙流式输出、原 Work 完成及未知结果待核对。三个候选均保存加载的实际群聊、接力模块和渲染源码摘要，并与当前产品源码核对一致。

候选入口为 `node tests/group-member-handoff/run.cjs handoff` 、`node tests/group-member-handoff/run.cjs handoff-unknown` 和 `node tests/group-member-handoff/run.cjs handoff-a-partial`。使用候选自身的 preload bundles 和同一套沙箱 Electron、Xvfb、CDS、Vexus 及 Node 24 环境。

## 最终候选源码

三条候选回执及截图均来自最终冻结版，包含主窗口主 frame 校验、接管端本地 History ACK 校验和人工确认操作的原 Work 绑定。继续时接管端核对甲原回复的 Journal 序号、成员身份与正文哈希后，才构造乙请求。验收保留两条未知请求供核对，未触发人工确认放弃。以下 SHA-256 来自实测加载文件，并与当前检出逐项核对。

- Desktop IPC 主 frame `ac16c6e761d57188dbca24fcf274ee1117da3c79a47622c5721137fca898dcaf`
- Desktop 甲回复本地 ACK 校验 `7636f35958500a069e1307ed60a4478e797e3cb7321cbdaddbaf5a3c2f72123e`
- Desktop 已接管记录查找 `86f2e16b5bf6d7c049c687b1dc7b50513cdf281d655fc5dda53f2a89c63a43ec`
- Desktop 核对操作与 Work 绑定 `e018c44cf40b1576f4f60f84ad119839128968a6f7b182e0b0cdecde01560aee`
- ToolBox 接力边界 `5e69cf03ff7ae15e233676ac7026af62cd42e2ade428d18ea5e270053155c13c`

## 使用与复核

新版桌面连接具备 `group-member-handoff-v1` 能力的 ToolBox 后，在两成员顺序共享群的话题内打开「跨端任务」，选择「开始两成员接力」。原生群聊照常承担每个成员的组包、模型调用和正文处理。甲提交后，中央在写入正式 Journal 的同一事务记录暂停位置。另一台有执行权限的桌面点击「接管到本端」后，还需显式点击「本端继续执行」。这条模式仅接受纯文本，工具、AA、附件、邀请和随机计划都不在本批范围内。

正向样本 Work 为 `request_4ab869ad939a4ef1ad9b903ff1e8fdf3`。甲对应原生请求序号 0、正式 Journal 序号 2，乙对应原生请求序号 1、正式 Journal 序号 3。乙的 Handler 仅有一条时间戳绑定指向甲的原消息 ID，Provider 以 assistant 角色收到一次带甲署名的文本；本次 Provider 消息没有单独的 name 字段。另做存储层对照，暂停时把群配置的成员顺序调换，接管端取回的仍是原 Work 受理时的成员顺序和冻结配置。[正常接力及请求包](candidate-handoff.json) · [甲未提交](candidate-handoff-a-partial.json) · [乙结果未知](candidate-handoff-unknown.json)

两端均使用沙箱 Electron 和独立合成 Profile、真实 ToolBox 与回环合成 Provider。复跑前用固定源码重新构建桌面 sandbox preloads；旧 bundle 缺少新增 IPC 时，控制面不会显示入口。普通顺序群聊的原生桌面与共享 worker 组包夹具也在此组合复跑通过。原生主套件 303 项通过，6 项因缺少历史压缩夹具跳过；另外的冻结顺序用例通过。协作套件 60 项、桌面队列／watchdog／preload 等定向测试 21 项通过。日用端未部署。

[甲已提交后的暂停画面](handoff-A-paused-after-first-member.png) · [接管成功但回执丢失后重开](handoff-B-reopened-after-lost-ack.png) · [原 Work 完成](handoff-B-original-work-completed.png) · [乙结果未知，保留核对](handoff-unknown-B-original-work-needs-review.png)
