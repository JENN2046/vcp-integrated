# CORE-NATIVE-MEMORY-R1

基线为 Integrated `906e0661c08e3f0c756a49d85febb741386cf980`。完整 RAGDiaryPlugin 来自宿主 provenance 固定的 [VCPToolBox 965afa8](https://github.com/lioensky/VCPToolBox/tree/965afa8ab98c5afacb058d06dc1be3bb4d682f43/Plugin/RAGDiaryPlugin)，版本 1.0.0。正常 ToolBox 发现、配置、初始化和关闭机制仍负责该插件。仓库是本轮集成来源，固定上游仍是插件及 Memo 引擎的来源。

## 作用域与配置

Core 的配对权限决定设备可对哪个工作区执行、读取或配置。Agent 的原生能力由现有 Core 数据目录里的 `native-capability-grants.json` 补充；只有运营者有权维护这个授权文件。Agent 提示词、工具参数和设备的配置权限不能改写它。缺失、不可读或不匹配的文件使对应能力默认无授权。使用同目录普通文件原子替换以生效，无需重启；把目标从授权列表移除即撤权。

```json
{
  "version": 1,
  "workspace": "sandbox",
  "agents": {
    "sender-agent-id": {
      "diaries": ["FixtureDiary"],
      "TopicMemo": ["peer-agent-id"],
      "DeepMemo": ["peer-agent-id"],
      "TopicSponsor": ["local_0123456789abcdef"],
      "AgentAssistant": ["FIXTURE_PEER"]
    },
    "aa:FIXTURE_PEER": {
      "diaries": ["FixtureDiary"]
    }
  }
}
```

- `diaries` 使用 ToolBox 中的日记本名，支持显式授权读取其他 Agent 的日记本。首轮、原生刷新、直接文本、AIMemo、ContextBridge、VRef 及原生查询按授权范围工作。文本文档缓存只在本次原生请求中复用；普通 ToolBox 查询缓存照原生规则使用。只有本轮原生格式化器生成的区块可被刷新，派发前清除输入中遗留的其他区块并复核本轮已访问的资源。
- `TopicMemo`、`DeepMemo` 使用目标 Agent 的稳定 ID。名称只参与定位，匹配歧义时可使用稳定 ID。TopicMemo 的列表与正文查询以及 DeepMemo 的 CDS 检索均沿用原生工具及 Core 正式 History，Core Work 下拒绝旧分布式路径替代读取。设备对正式 History 的原有读取权限仍按设备授权判断。
- `TopicSponsor` 使用 Core 规范话题 key。交付继续用原生 ReplyToTopic 寻址、设备执行权限、工作区、调用记录与幂等。目标 Work 派发前复核原发 Agent 的目标授权。
- `AgentAssistant` 仍需通过原生 VCP 工具审批和 Core 现有委托白名单，目标以原生配置的稳定 `baseName` 授权。每个委托子轮复核原发 Agent 授权，任务结果从已记录原生任务读取。子轮的日记授权归独立的 `aa:<baseName>` 身份，避免继承父 Agent 的日记许可。没有本 Work 范围的旧归档占位符不触发裸文件查找。

设备权限、Core Work 有效性、准确目标与原生审批同时成立才允许操作。已完成的结果和回执保持可审计。撤权后的新派发不会继续使用此前注入的日记或已读取的工具结果。

## 构建与回滚

1. 使用干净检出、Node 24 和锁定依赖，执行 `npm run deps`、`npm run build`。Linux x64 的 Vexus-Lite 由仓库 Cargo 锁和 Rust 1.89 构建；日记目录、个人 Agent 和真实 Key 不进入产物。
2. 运行 `scripts/package-core-native-memory.sh full /absolute/candidate.tar.gz` 或 `scripts/package-core-native-memory.sh readonly /absolute/readonly.tar.gz`。归档由 Git 确定源码和时间戳，附所列构建资产及 SHA-256 清单。安装依赖仍用仓库锁。
3. 发行包的 RAGDiaryPlugin 以 `plugin-manifest.json.block` 交付。隔离验证可通过原生插件管理入口启用，或把隔离目录里的清单改为 `plugin-manifest.json`；同时配置独立 `KNOWLEDGEBASE_ROOT_PATH` 和 `KNOWLEDGEBASE_STORE_PATH`。Core Agent 在原生 system prompt 使用对应日记占位符。部署启用由运营者另行批准。
4. 若需回退，先正常停止候选进程，确认在途 Work 状态并保留 Core、History、Journal、会话和索引资料。先通过原生机制禁用 RAG，切回原已验证产物或从基线构建，再保留相同数据目录重开。旧专用代码和暂存脚本在 `906e066` 的 Git 历史中；回退默认也保持旧试点关闭。不得把运行数据复制进发行树，或通过恢复陈旧数据库替代代码回滚。
