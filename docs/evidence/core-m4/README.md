# Core M4 隔离候选

基线为 `af5b8f9`。M3 的常规共享群聊、历史迁移和 CDS/Tantivy 选型沿用 [M3 验收](../core-m3/README.md)。本轮使用隔离工作区、原生 CDS、合成游戏牌局和本机模型。

## 原生能力及边界

| 能力 | M4 验证 |
| --- | --- |
| CDS/Tantivy | 使用现有 CDS 进程和原生 ingest、reconcile、Tantivy。Core 读事务按正式顺序生成可重建索引输入，检索前更新。原生查询用例验证新增、修改、删除、带权 OR、排除词、当前话题排除和三条相邻消息窗口。 |
| DeepMemo | 桌面已授权会话转入 Core 索引。Core Work 本身通过原生插件格式和工具执行账本检索，沿用调用主体的工作空间及所有者范围。非 Core 话题继续使用桌面 CDS。 |
| TopicMemo | 现有插件改用 direct。Core Work 通过授权目录与正式消息读取，各端查改删一致。已知 Core 话题离线时拒绝读旧物理文件。原生非共享话题仍读取原有 History。 |
| JEV | 复用原生 `JevGroupSessionOrchestrator`、仲裁规则、队列和人工插入。实际 ToolBox Handler 执行被选成员。桌面退出后执行继续，后续成员看到正式终稿。测试在仲裁服务边界注入确定性响应，实体 JEV Provider 联验仍待验证。 |
| 斗地主 Game | 原生 `GameService` 持有牌局、回合、发牌、座位和动作。原生编排器发起座位决策，Core 提交公开事件、派发模型并通过原生分布式 WebSocket 绑定 GameController。真实牌局测试走人类叫分和出牌、两名 Agent 出牌判断以及回到人工回合。私有邀请、工具观察和模型推演只在执行中使用。正式游戏历史包含五条公开事件。 |
| 常规群聊缺口 | 空话题邀请产生无用户占位消息的 Work。redo 按已观察版本原子记录原发言删除及同一成员的重做。群聊 Canvas、Workspace 及活引用通过原生注册节点读取。JEV 动态仲裁和普通群聊 Work 都经过桌面退出后的继续执行验证。 |
| 压缩保真度 | Qwen2.5 3B Q4_K_M 走真实原生 HTTP 和 Core 压缩入口。两路完整模型输入与参数逐项相同，温度 0、seed 54、420 tokens、关闭提示缓存。输出逐字一致，保留五项精确值和“未批准”状态。样本为单一合成场景。 [模型回执](compaction-qwen3b.json) |

Core CDS 由隔离 ToolBox 的 `VCP_CORE_CDS_BINARY` 启用。原生 CDS 只接触 Core 独立数据目录下的 `cds-index-input`，该目录可从 Core 数据库重建。常规历史继续由 Core 数据库授权和提交。本文档的搜索验证覆盖检索前更新，后台推送索引没有引入。

在隔离部署中用已有授权的 JEV Provider 配置 `VCP_CORE_JEV_API_KEY`、`VCP_CORE_JEV_PROVIDER`、`VCP_CORE_JEV_URL` 和 `VCP_CORE_JEV_MODEL`，实际设置可使用原生服务默认值。启用后，新建或显式迁移的 JEV 共享话题可进入 Core。仲裁队列沿用原生进程生命周期，进程重启后只按 Core 语义核对已接收的成员 Work，原仲裁会话暂停。斗地主通过 `VCP_CORE_ENABLE_GAME=1` 独立启用，由登记的发源桌面访问私有牌局与 Core 游戏会话。VTrade 及游戏大厅其他独立领域操作继续使用各自原生入口。

## 历史迁移

在隔离副本验证原生 History 数组和 `messages` 封装、文本对象、纯文本分段、ISO 时间与数值时间、原生删除标记、NativeSync 中央编辑和删除、CDS 新旧墓碑、附件字节及重复导入。链路读取保留归一化前的扩展元数据。使用 `af5b8f9` 代码生成旧 Core 数据库，再由 M4 执行 schema 升级，旧 Work、原用户消息引用、工具回执和外键均通过核对。

可定位附件文件从隔离快照读取。重复跨话题消息 ID、内联非文本部件和无法定位的原件仍由导入器拒绝，保留待校对状态。格式样本来自现有原生解析器与隔离测试数据，真实日用历史尚无获准处理的脱敏副本。

## 旧职责退出

- 对已接管的 JEV 话题，桌面负责界面和原生按钮转发。原生动态仲裁移至 Core 宿主，桌面旧执行、成员接管、终稿补交和 History 写入路径退出该话题。
- 对已接管的斗地主，桌面只拥有牌局状态、原生交互及 GameController。模型 Work 和公开事件由 Core 接受与落盘。旧桌面模型派发、公开 History 写入及中转终稿退出。
- 对 Core 话题，TopicMemo 的旧 stdio 入口退出。已迁移话题的桌面旧 History 不参与插件读取与索引写入。
- 对仍有原生本地、旧共享域和游戏大厅消费者的模块继续保留，避免误删仍能执行的入口。

## 构建与验收证据

- Linux x64 整合构建通过，重建 PWA、桌面 preload、原生 CDS 和 ToolBox Vexus 模块。Linux CDS SHA-256 为 `7bf1eba873cf2b4902c661b78d43ba760e234945d22f67f08715efb2fad8c2e8`。
- 实际 Electron 44.9.3 从新隔离目录加载 Linux 主窗口、preload 和独立 CDS，走正常退出清理。完整后台 GUI 联验在启动时碰到宿主 inotify 的 `MaxFilesWatch` 限额。 [启动回执](linux-electron.json) · [单机测试入口](desktop-smoke.cjs)
- Linux 桌面包由干净索引副本和全新安装的锁定依赖生成。实际 unpacked Electron 校验 140 个运行文件，渲染器达到 ready，退出码为 0。运行闭包 SHA-256 为 `8c1c8eee979f8f3b4b996fb191780da0b87023035990bdf8c7f1e2e89f00e677`。 [打包启动回执](linux-package.json)
- Windows x64 原生 CDS 使用独立 MinGW 工具链生成 PE32+ 可执行文件。Windows 整机、安装包和 macOS 实机仍待验证。 [交叉构建回执](windows-cds.json)
- 原生隔离套件 354 通过、6 跳过、0 失败。Chrome 协作套件 61 通过。桌面原生 JEV、Game 和回忆插件相关用例 45 通过。斗地主真实分布式 WebSocket 接线和 TopicMemo 离线边界另行定向复测通过。

Resident、生产可信客户端与 WebTransport 继续独立跟踪。本轮活动限定在隔离开发和验证环境。
