# CORE-NATIVE-MEMORY-R1

基线为 Integrated `906e0661c08e3f0c756a49d85febb741386cf980`。完整 RAGDiaryPlugin 来自宿主 provenance 固定的 [VCPToolBox 965afa8](https://github.com/lioensky/VCPToolBox/tree/965afa8ab98c5afacb058d06dc1be3bb4d682f43/Plugin/RAGDiaryPlugin)，版本 1.0.0。正常 ToolBox 发现、配置、初始化和关闭机制仍负责该插件。仓库是本轮集成来源，固定上游仍是插件及 Memo 引擎的来源。

## 作用域与配置

Core 的配对权限决定设备可对哪个工作区执行、读取或配置。Core 数据目录中的 `native-capability-grants.json` 仅用于原生入口缺少的日记本授权和显式跨 Agent 历史读取。运营者可通过同目录普通文件原子替换授权，无需重启。同步检索共享一份授权快照，原生工具刷新或模型派发前重新核对已使用的授权。

```json
{
  "version": 1,
  "workspace": "sandbox",
  "agents": {
    "sender-agent-id": {
      "diaries": ["FixtureDiary"],
      "TopicMemo": ["peer-agent-id"],
      "DeepMemo": ["peer-agent-id"]
    },
    "aa:FIXTURE_PEER": {
      "diaries": ["FixtureDiary"]
    }
  }
}
```

- `diaries` 使用 ToolBox 中的日记本名。原生日记没有绑定 Core Agent ID 的所有权字段，需要明确授权；显示名和占位符不创建授权。首轮、原生刷新、直接文本、AIMemo、ContextBridge、VRef 及原生查询按授权范围工作。文本文档缓存只在本次原生请求中复用；普通 ToolBox 查询缓存照原生规则使用。只有本轮原生格式化器生成的区块可被刷新，派发前清除输入中遗留的其他区块并复核本轮已访问的资源。
- `TopicMemo`、`DeepMemo` 的显式跨 Agent 授权使用目标 Agent 的稳定 ID。执行 Agent 的自身 History 与 DeepMemo 读取当前群会话 History 沿用原有权限。名称只参与定位，匹配歧义时可使用稳定 ID。TopicMemo 的列表与正文查询以及 DeepMemo 的 CDS 检索均沿用原生工具及 Core 正式 History，Core Work 下拒绝旧分布式路径替代读取。设备对正式 History 的原有读取权限仍按设备授权判断。
- `TopicSponsor` 沿用原生 ReplyToTopic 寻址、设备执行权限、工作区、调用记录与幂等。递送前复核合法来源和准确目标。
- `AgentAssistant` 仍需通过原生 VCP 工具审批和 Core 现有委托白名单，原生配置解析委托目标，子轮复核同一委托许可与设备权限，任务结果从已记录原生任务读取。子轮的日记授权归独立的 `aa:<baseName>` 身份，避免继承父 Agent 的日记许可。没有本 Work 范围的旧归档占位符不触发裸文件查找。

设备权限、Core Work 有效性、准确目标与原生审批同时成立才允许操作。已完成的结果和回执保持可审计。撤权后的新派发不会继续使用此前注入的日记或已读取的工具结果。

## 构建与回滚

1. 使用干净检出、Node 24 和锁定依赖，执行 `npm run deps`、`npm run build`。Linux x64 的 Vexus-Lite 由仓库 Cargo 锁和 Rust 1.89 构建；日记目录、个人 Agent 和真实 Key 不进入产物。
2. 运行 `scripts/package-core-native-memory.sh full /absolute/candidate.tar.gz` 或 `scripts/package-core-native-memory.sh readonly /absolute/readonly.tar.gz`。归档由 Git 确定源码和时间戳，附所列构建资产及 SHA-256 清单。安装依赖仍用仓库锁。
3. 发行包的 RAGDiaryPlugin 以 `plugin-manifest.json.block` 交付。隔离验证可通过原生插件管理入口启用，或把隔离目录里的清单改为 `plugin-manifest.json`；同时配置独立 `KNOWLEDGEBASE_ROOT_PATH` 和 `KNOWLEDGEBASE_STORE_PATH`。Core Agent 在原生 system prompt 使用对应日记占位符。部署启用由运营者另行批准。
4. 若需回退，先正常停止候选进程，确认在途 Work 状态并保留 Core、History、Journal、会话和索引资料。先通过原生机制禁用 RAG，切回原已验证产物或从基线构建，再保留相同数据目录重开。旧专用代码和暂存脚本在 `906e066` 的 Git 历史中；回退默认也保持旧试点关闭。不得把运行数据复制进发行树，或通过恢复陈旧数据库替代代码回滚。
