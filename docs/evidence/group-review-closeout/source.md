# 原故障恢复输入

原始合成运行位于 `/tmp/vcp-integration-thtI35/ready`。夹具 `tests/group-member-handoff/review-source.cjs` 默认在此定位输入。若同一快照已移存，可通过 `NS_GROUP_REVIEW_SOURCE` 指向包含 `data`、`profile-B`、`seed/L4-SYNTHETIC-ONLY` 的目录。夹具启用前核对固定数据库 SHA-256、合成标记与候选故障证据。

- Work `request_9c83476f43f546a1a8f96d54254467fe` 为 `review_required`，原生请求 `group_request_9c83476f43f546a1a8f96d54254467fe_0` 已完成模型输出，`group_request_9c83476f43f546a1a8f96d54254467fe_1` 为 `unknown`。接管后的执行者是 `desktop:deviceB`，版本为 1。
- 话题 `shared_846c39801b47445ca51fae9b0c64a85d` 的 Journal 与原始候选故障证据逐字段相符。B 的合成 History 包含相同的两条消息，消息 ID、内容和时间戳与 Journal 相符。原 History 文件 SHA-256 为 `18a91b0527e0badaa20ac0b4cc87961d69f3ff69ec0fdfc3f8a847f8592a014d`。
- 原 `data/central.sqlite` 的 SHA-256 在复制前、复制后均为 `99db7df76016daf3624e66a220ef80891ac84be3bd151d1f3d877dc79bb27c44`。新隔离库启动前的 SHA-256 相同。首次源库只读检查生成了空 WAL 和临时 SHM，确认主库哈希未变后清除这两份当次检查产生的文件。复测使用 SQLite immutable URI，源库旁无 WAL、SHM 或回滚日志。
- B 只复制原生群配置、合成 Agent 配置、目标 History 和 NativeSync 投影必要文件。夹具根据原库中的身份绑定新建本轮回环连接与合成凭据，并在副本中更新本地目录绑定。原 Profile 的连接设置、缓存、浏览器状态和认证文件不进入副本。

原运行与约定输入只读保留。夹具冒烟验证使用 Node 24 在临时隔离目录中复制中央库和还原 B，并在检查后清理临时目录。端到端 Electron 与 ToolBox 的运行结果见同目录验收证据。
