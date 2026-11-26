# VCP Core 独立 Pilot 01

基线为 `bcb03a8`。RC-01 的安装包、校验清单与验收证据继续按原版本归档。Pilot 01 使用独立的数据目录、合成后端和脱敏历史副本。

## 本机资格与生命周期

- ToolBox 持有 Core 的启动、排空和停止。设置 `VCP_CORE_DATA_DIR` 后默认启用独立本机模式，`VCP_CORE_WORKSPACE` 可选，默认 `personal`。Core 在自己的 SQLite 中保存话题定义、配置快照、消息和 Work。原生模型参数及上下文验证由 Core 与旧发布路径复用。
- 本机接口沿用 ToolBox Bearer，要求宿主监听回环，按实际套接字识别连接。桌面用原有 Agent、群组、话题配置和 Core IPC。首次打开空话题即可登记，桌面和服务端按原生所有者与话题 ID 计算同一个键。
- 真实 ToolBox 运行目录的 NativeSync 插件清单已移除，后端加载清单确认 NativeSync 服务模块从未载入。真实 Electron 发送消息并退出，Core 正常完成。后台重启后客户端冷启动读回原回复。Provider 调用一次，旧中央 SQLite 未创建，桌面物理 History 保持为空。 [运行回执](local-core.json) · [读回画面](local-core-desktop.png)

## 原生能力差异及退出清单

| 路径 | Pilot 行为 |
| --- | --- |
| 单聊 | Core 持有消息、Work、Steering、压缩与 Flowlock。工具调用和副作用回执沿用 Core 的既有执行语义。 |
| 群聊 | 新模式实测顺序发言与成员身份落盘。原生群聊的标题摘要与上下文窗口继续各有职责。既有群聊代码中的摘要用于话题标题，Flowlock 主聊天入口只接受 Agent。群聊 Steering、Flowlock 和压缩未新增。 |
| JEV、游戏和实时资源 | 保留既有 Core 路由与原生配置验证。JEV 仍需 Provider 配置，游戏仍需既有原生游戏节点，Canvas 与 Workspace 通过原有分布式能力读取。RC-01 的外部 JEV 联验证据保留。本批没有重新调用外部模型或复测游戏节点。 |
| 工具与记忆 | 本机 TopicSponsor 只接受已登记的明确目标话题，并核对当前 Core Work 与调用回执。AA 既有受准委派可通过 `VCP_CORE_DELEGATION_AGENTS` 授权。临时联系、额外工具注入和间接委派仍受现有 Core 边界限制。已接入的话题标题与记忆读取指向 Core 历史。 |
| SideChat、语音、桌宠 | SideChat 父快照读取 Core 正式历史，孩子对话按原生 `sidechat-child.json` 身份继续本地写入。实测本机组和旁路子话题的历史归属。语音、桌宠保留原生模块，本批没有复测实体音频设备。 |
| 删除及多设备 | Pilot 保留 Core 的消息编辑与删除。整个所有者和话题的 Core 生命周期协调仍有限制。独立本机路径没有旧共享设备配对。 |

本机入口不启动旧双向副本、Core 话题的旧中央 Journal 执行、领回派发或终稿补交。桌面启动器复用已有 IPC 注册和附件客户端，已接管的主话题拒绝原生 History 写入，合法 SideChat 子话题保留自己的写入归属。

含实际消费者的旧 NativeSync 插件仍单独保留，包括旧 PWA 和共享设备。同一分支的旧环境只有显式选择 `VCP_CORE_MODE=shared` 才会接入旧共享授权，旧共享执行不参与本机路径。旧模式通过 RC 联验复跑。原 RC-01 仍是保留的独立安装与回退来源。WebTransport、Resident 正向 Provider Seal 与生产可信客户端另行跟踪。

## 离线迁移与六项历史夹具

- Pilot 迁移使用原 RC-01 脱敏样本。目标 `manifest.json` 使用 `"authority": "local"`，并将各话题 `key` 按原生三元组计算为 `local_` 加 SHA-256。重复导入与重开通过，保留 5 条消息、1 项附件及 1 个删除事实。客户端以独立的原生配置建立对应话题，原始日用 History 和 CDS 未被写入。 [迁移回执](local-import.json)
- 离线导入支持字符串、文本对象、纯文本分段、旧时间戳和可定位的本地附件。非文本内联部件、跨话题重复消息 ID 和缺失原件仍明确拒绝。已填充的桌面旧 History 需要经过离线迁移；不会在首次打开话题时自动接管。
- 标准原生套件的六项跳过全部来自 `NATIVESYNC_ORIGINAL_COMPACTION_ROOT` 未提供。保留的合成验收档已在检查点之后继续写入。本批用副本和真实历史 Journal 前缀还原检查点边界，在副本上通过旧取消入口取得回执后复跑，专项 **13 通过**，其中包含六项重放。未修改保留的合成档。标准原生套件通过 356 项、跳过 6 项，协作套件通过 61 项。

## Pilot 启动与产物

1. Linux ToolBox 使用正常安装和 Provider 配置。在工具根目录使用现有回环部署时，设置绝对的 `VCP_CORE_DATA_DIR` 与 `VCP_LOCAL_LISTEN_HOST=127.0.0.1`，保持 ToolBox 已配置 Bearer。用 `npm run deps`、`npm run build` 复建。CDS 搜索可按需用 `VCP_CORE_CDS_BINARY`。
2. 先在独立桌面 profile 中配置对应的回环 VCP 服务器 URL 与同一 Bearer，再以 `VCPCHAT_APP_DATA_DIR` 指向该 profile，`VCPCHAT_LOCAL_CORE_WORKSPACE=personal` 启动。此路径无需 NativeSync 授权目录或 Source 注册。Core profile 标记绑定原来的 origin 与 workspace，后续启动仍会使用这个绑定。用 `node tests/integration/run.cjs core-local` 复跑本机 GUI 联验。
3. Pilot 发布目录中提供 Linux AppImage、Windows x64 未签名 NSIS、固定源码及 Linux ToolBox 构建产物。Linux AppImage 以原有宿主 SUID sandbox helper 进行隔离提取启动，渲染器达到 ready。 [Linux 启动回执](linux-appimage.json)
4. 最终 Windows 包在断网 Windows 11 x64 虚拟机中由标准账户安装，安装退出码为 0，渲染器达到 ready，回执中的安装包与内置 CDS 校验值均与交付产物相符。ToolBox 原生后端目前仅在 Linux 构建及联验。当前无 macOS 验收环境。 [Windows 安装回执](windows-install.json) · [机内回执画面](windows-install-proof.png)
