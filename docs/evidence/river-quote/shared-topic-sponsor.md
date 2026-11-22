# 共享 TopicSponsor 河流引用验证

基线为 vcp-integrated `e6fdf5b`。使用 Node 24.22.1、本地隔离宿主副本、合成共享空间与回环 HTTP。测试实际走 ToolExecutor、WebSocket 路由绑定、共享 grant、HTTP accept 和目标话题 Journal，模型端使用 fixture 的固定回复。

改前，两条相同正文到达目标 Journal 时分别保留 `user` 和 `assistant`，但丢失「诺宝」和「小雨」。无名行只有角色和正文，正文中的「假名字」仍是正文。改前测试在读取持久化 Journal 后的结构断言失败。

修复后，分发参数和目标 Journal 的 V1 JSON 行均携带去掉首尾空白的可选 `name`。无名行维持原结构。旧消息选段、私有字段和多模态数据的过滤通过。测试模拟 HTTP accept 后传输响应丢失，沿原 ledger 取得收据，并在重开后端后重放同一请求，得到原收据和唯一一条内容相同的 Journal 消息。

原有设备校验、伪造或缺少权限、同一请求 ID 内容变更、未确认操作留待恢复的专项均通过。

```bash
node tests/run-host-suite.cjs native --test-name-pattern='real ToolExecutor and distributed bridge|missing or forged authority|an unconfirmed distributed delivery'
node tests/collaboration/run.cjs --test-name-pattern='real ToolExecutor and distributed bridge|missing or forged authority|an unconfirmed distributed delivery'
```

两套入口各执行三项匹配测试，均通过。隔离宿主目录由运行器清理。
