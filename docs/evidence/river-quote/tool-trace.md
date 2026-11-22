# TopicSponsor River 派发与投递证据

实测输入固定为 [合成来源消息](../../../tests/river-quote/tool-fixture.json)。青岚、白露两条消息正文和角色相同，来源 ID、成员 ID、名称和原始位置各异。无名对照另用三条消息和短文本「收到。」。

| 路径 | 工具派发 `river_context` | 进入集成桌面历史 admission 的引文 |
| --- | --- | --- |
| 作者 ToolBox `d9233bc`，`semantic:3`，七条源消息 | 取最近五条，未请求向量。索引 0、1 被窗口截掉，白露在派发参数中仍可识别 | 正文和角色保留，名称消失 |
| 作者 ToolBox `d9233bc`，`last:7` | 两个名称和无名行都在，源 ID 和索引均未进入投递参数 | 两位成员的引文完全相同，无名正文仍在 |
| 集成 `e6fdf5b`，`semantic:3`，七条源消息 | 一次批量向量请求，取原始索引 0、1、2，保留两个名称与 `_river_index`，源消息 ID 和成员 ID 已丢失 | 两位成员的引文完全相同，无名正文仍在 |
| 集成 `e6fdf5b`，`last:7` | 两个名称、源消息 ID 和成员 ID 都在 | 两位成员的引文完全相同，无名正文仍在 |
| 三条源消息，`semantic:3`，短无名正文 | 作者版派发全部三条且无向量调用。集成原版在语义候选长度过滤阶段丢弃「收到。」 | 作者版工具参数可产出三条引文。集成原版参数只产出两条 |

候选版对七条和三条源消息沿用作者版窗口。短无名「收到。」通过原生派发进入引文，青岚与白露维持同文异名。三版均验证 `last:7`、`last:3`、`last:2` 和未请求 River 的对照。另行传入伪造 `river_context` 时，原集成版仍将其送达，作者版与候选版均删除该入参。候选版另验证转发源文本含已有 V2 引文时，桌面投递会清掉嵌套引文，保留原正文和发言人，并按 V1 格式写出。

[tool-trace.json](./tool-trace.json) 逐次保留输入、审计入口、实际分布式派发参数、桌面投递入参、桌面服务返回和工具执行器返回。`sources` 内记录了每个组合的提交版本及实际装载的 ToolBox 和桌面投递关键源码 SHA-256。三个组合均运行真实 `ToolExecutor` 和插件管理器的分布式派发。作者和集成原版的回环传输连接同一个集成原版桌面 TopicSponsor direct 服务、操作服务及投递服务，以隔离 ToolBox 的行为差异。候选组合运行候选 ToolBox 和桌面投递 formatter。测试在虚构地址解析及历史 admission 边界捕获消息，历史落盘与渲染由桌面验证覆盖。向量提供者返回两维本地固定向量，真实执行器负责评分和排序，JEV 重排关闭。测试替换了工具调用审计写入。

复现时分别将作者 ToolBox 和集成仓的上述固定提交解到临时目录。再复制集成基线，覆盖候选 `apps/server/modules/vcpLoop/toolExecutor.js` 与 `apps/desktop/modules/services/nativeSync/topicRiverQuote.js`。作者 ToolBox 的最小测试材料为 `modules`、`Plugin/VCPSleep`、`Plugin/RAGDiaryPlugin`、`ToolConfigs`、`TVStxt/JevToolCallDecision.txt`、`EmbeddingUtils.js`、`TextChunker.js`、`Plugin.js`、`FileFetcherServer.js`。集成仓需要 `apps/server`、`apps/desktop/modules`、`apps/desktop/VCPDistributedServer/Plugin/TopicSponsor`，并使用隔离进程加载开发环境已有的 Node 依赖。

```sh
NODE_PATH="$SERVER_DEPS:$DESKTOP_DEPS" node tests/river-quote/tool-trace.cjs \
  "$AUTHOR_TOOLBOX_EXPORT" "$INTEGRATED_EXPORT" "$CANDIDATE_EXPORT" /tmp/river-tool-trace.json
```
