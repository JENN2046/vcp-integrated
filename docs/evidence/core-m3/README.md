# Core M3 隔离架构候选

施工由 `e21fa4f` 开始，保留 `4477301` 的正文增量、可空 Work 来源及独立 AA 取消边界。M2 的 Canvas、Workspace、Live Reference、AgentAssistant、TopicSponsor、Flowlock 和压缩结果沿用 [M2-R2 验收](../core-m2-r2/README.md)。本批使用隔离工作区、合成历史和本机模型。

## 常规群聊与旧职责退出

| 路径 | 候选版本行为 | 验证 |
| --- | --- | --- |
| Sequential | Core 冻结原生配置，依序调用 ToolBox 原生 Handler，每位成员独立提交正式回复。后续成员在原生上下文窗口中看到前序成员的正式内容。 | 桌面运行时发送，配对 PWA API 订阅 SSE 并读回 |
| NatureRandom | Core 复用原生 @、Tag、概率和保底规则，保存已选计划供恢复。 | @ 指定测试成员，实际原生请求有发言 |
| InviteOnly | 普通输入只提交用户消息，显式邀请产生独立 Work，沿用受权主体和原请求 ID。 | 配对 API 邀请并重发同一个请求 ID，模型只调用一次 |
| 重启 | 已持久化且有效的成员终稿先结算，只有尚未派发的下一位成员重新排队。 | 首位成员终稿落盘后重开 Core，实际调用恰好一次 |
| JEV、Game、本地群聊和待导入群聊 | 保有各自现有入口和授权。 | JEV、Game 创建的新话题均未标记 Core 所有权，JEV 的 Core API 请求被拒绝 |

Core 接管启用工作区中新建的三类群聊话题，也接管显式导入并与旧中央快照核对一致的常规群聊话题。接管标记持久化，Core 服务暂缺时旧路由仍拒绝执行。接管后，桌面群聊发送、邀请、读取和取消进入 Core，旧群聊调度、成员接管、终稿补交、Journal 回写和旧移动执行路径退出该话题。新话题验收的三张旧表均为零写入，已导入话题的旧 Journal 行保持原样。已有消费者的旧实现继续作为原生入口。旧目录的合并操作遇到 Core 话题会明确拒绝，以免按旧 Journal 判定两个正式历史可合并。

本轮覆盖桌面运行时、原生 Handler、配对 HTTP 与 SSE。开发验收未复测实体手机和 Electron GUI。群聊空话题邀请、redo、桌面活引用、Flowlock、steering 和群聊压缩仍受当前显式限制。

## 历史迁移与核对

`apps/server/core/importHistory.js` 接收独立快照目录和新目标目录。用 SQLite backup 导出旧中央数据库和 CDS。原生 History 与附件文件复制到快照目录，按下方清单映射。两种 SQLite 输入只读打开，文件路径必须定位在源快照内。

```json
{
  "workspace": "isolated-workspace",
  "central": "central.sqlite",
  "cds": "chat_data.sqlite3",
  "topics": [{
    "key": "shared_topic_key",
    "ownerType": "group",
    "ownerId": "shared_group_key",
    "topicId": "shared_topic_key",
    "history": "history/topic.json",
    "attachmentFiles": {
      "message_id": { "attachment_id": "files/note.txt" }
    }
  }]
}
```

```sh
node apps/server/core/importHistory.js /tmp/vcp-source-snapshot /tmp/vcp-imported-core
```

共享话题的键和三元身份使用隔离中央目录中的正式身份。原生 History 保留数组相对顺序，匹配的中央编辑更新投影，中央独有的消息按首个 Journal 序号插入下一个匹配锚点之前，无锚点的追加。正文和时间戳由 Core 读回，额外字段及原始附件描述保存在迁移元数据。附件字节按哈希入 Core。中央删除、CDS 现行 owner/topic/message 删除字段和旧式消息墓碑在导入后留存。目标目录在完整写入后发布，同样的快照重跑返回既有回执。启动时核对映射、中央头及遗留 Work，避免接管仍有未结算执行的话题。

测试使用原生 History、经 NativeSync `CentralStore` 写入的 edit/delete、CDS 两种 SQLite 墓碑布局和实体附件文件。新进程重开后核对 2 个话题、4 条可见消息、4 个删除事实和 1 个原件。另一个用例从旧中央 SQLite 备份导入共享群聊，重新启用 Core 后从桌面读回原消息 ID，并确认旧移动写入入口拒绝。

本工具处理历史消息和历史删除。当前目标要求全局唯一消息 ID、文本型 user/assistant 正文和可定位的原件。出现重复身份、不支持的正文或缺失原件时，整批保持待处理。附件描述中的本机原路径仍保存在离线迁移元数据中，普通消息 API 只发布可用的附件描述。CDS 头像墓碑和旧执行记录留在各自历史数据库。既存真实工作区之间的归并和生产切换均未执行。

## 搜索选型

保留 **CDS/Tantivy**。DeepMemo 的在用 `DeepMemoService` 调用 `searchMemories`，依赖同一所有者范围、当前话题排除、加权布尔表达式、相邻消息窗口、窗口合并与输出预算，可在其上执行可选 rerank。较旧的 DeepMemo stdio 路径仍有独立 minisearch 代码。TopicMemo 的 `ListTopics` 读 Agent 配置，`GetTopicContent` 直读原生 History，属于按话题读取。CDS 还负责桌面历史 ingest、修订核对、增量索引和删除投影，桌面桥也公开 `searchMessages`。单换 FTS 无法退出 CDS 的其余运行职责。

用真实 Linux CDS 二进制及 SQLite 3.46.1 + Jieba 0.42.1 测试同一份 3006 条合成中文语料。七种短词、地名、复合词查询的相关消息集合均命中，含主作用途中的跨话题排除。CDS 的带权 OR 加排除词返回预期两条，DeepMemo 邻居请求返回含三条消息的窗口。FTS5 原型为预分词后的 phrase + BM25 查询。带权复合表达式、窗口与协议投影仍需在其上实现。

| 单机样本 | CDS/Tantivy | FTS5 + Jieba 原型 |
| --- | ---: | ---: |
| 服务启动或分词器初始化 | 71 ms | 516 ms |
| 索引重建或批量建表 | 203 ms | 164 ms |
| 单次命中范围 | 约 2.2–4.6 ms，含 HTTP | 约 0.05–0.17 ms，进程内 |
| 内存样本 | 79,144 KiB 服务 RSS | 88,156 KiB Python 峰值 RSS |
| 搜索文件样本 | 95,718 B 索引 | 462,848 B FTS SQLite 文件 |

内存、启动和文件口径各有差异，数字仅反映对应原型与接线。语义、消费者与维护工作量是保留依据。复跑使用 [基准脚本](search-benchmark.cjs) 和 [原始计数](search.json)，用独立 Python 环境安装 `jieba==0.42.1`，再将其解释器路径传给 `M3_SEARCH_PYTHON`。本轮完成选型，Core 新正式消息进入 CDS 索引，以及 TopicMemo 从获授权的 Core 读取，仍是接入缺口。

## 压缩保真度对照

同一隔离 llama.cpp b12728 实例下，分别走桌面原生 HTTP 压缩入口与 Core 的正式压缩命令，均由真实 ToolBox Handler 转发。每组两次请求的上游 messages 逐项一致。

- Qwen2.5 1.5B 英文样本两路均丢失全部五项值。 [原始回执](compaction-qwen-1.5b.json) · [模型来源](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF)
- Qwen2.5 3B 中文样本两路均保留五项值，原生标识审计为 3/3。两路均只写待审时间。要求显式输出审批状态的另一组，桌面输出保留“未批准”，Core 输出仍只有待审时间。五项字面值保真可复现，状态保真仍有落差。 [中文回执](compaction-qwen-3b.json) · [状态回执](compaction-qwen-3b-status.json) · [模型来源](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF)

[对照脚本](compaction-fidelity.cjs) 通过环境变量接收环回端口。Windows 构建产物、Resident 正向 Provider Seal、生产可信客户端和 WebTransport 仍独立跟踪。

## 回归结果

Node v24.22.1。移动前端构建通过。隔离原生套件 350 通过、6 跳过、0 失败。协作套件 61 通过，桌面群聊、JEV 和本轮定向用例合计 13 通过。
