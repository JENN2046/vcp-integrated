# 普通共享 worker 的终稿恢复

复审基线 `d8f2a5296cc8` 的普通共享单聊在原生终稿返回后、worker 保存 `pending_operation` 前强停，会留下原输入和 Work，但没有正式回复。现在 ToolBox 在有效 JSON 或 SSE 终稿返回前，将可见正文、`stop`、原 Work、原生请求、已接纳主体和原始请求体哈希绑定到原回复操作，一起持久化在原执行记录。恢复验证依据是这份带 SHA-256 的终稿凭据及已确认的原生执行状态。[复审对照](../shared-single-review/toolbox-terminal.json) · [宿主差异](host.patch)

重启后，worker 验证原主体、话题、工具状态、操作身份和正文摘要，恢复同一个待发布操作，沿用既有共享完成入口写 Journal。原有的发布意图直接按原逻辑恢复。完成后清理临时终稿副本。缺少可信终稿或证据损坏的执行保持待核对；升级旧库不会从 `model_terminal` 单独推断正文。

| 实际强停时点 | 重开及重放原请求后的结果 |
| --- | --- |
| 已取得完整原生终稿，worker 尚未写发布意图 | 基线进入待核对；候选完成原 Work，用原回复 ID 发布一次。 |
| 原生终稿刚持久化，HTTP 终态尚未交给 worker | JSON、SSE 均恢复为同一条正式回复；手机共享消息入口也通过。 |
| worker 已保存发布意图 | 与基线一致，重启后只产生一条正式回复。 |
| 只有派发记录、终稿封存前退出，或合法 JSON 中的正文被改动而摘要不符 | 原 Work 进入 `review_required`，Journal 无正式回复。 |

16 个独立 ToolBox 用例均使用回环合成 Provider。桌面共享会话 HTTP 准入覆盖 6 个切点 × JSON/SSE，手机共享会话以真实配对 Cookie 走消息 HTTP 入口，覆盖封存前后 × JSON/SSE。每例二次启动并按原请求重放；已执行的计数工具保持一次，未执行的保持零次。模型请求次数也保持不变。此次实测覆盖服务端 worker 和 SQLite，不含实体设备界面。[逐例身份、计数、终态与加载源码哈希](toolbox-terminal.json)

在已构建的集成仓根目录使用 Node 24 运行 `node tests/shared-single-review/toolbox-terminal.cjs`。测试需要有可用配额的本地临时目录。
