# Main Chat IPC 测试夹具回执

本机 Node.js v22.23.1。在集成仓 `95cc27e18198a848622e50992c4fb4d8a2be3969` 执行：

```sh
node --test apps/desktop/tests/main-chat-response-body.test.mjs
```

| 运行 | 通过 | 失败 | 观察 |
| --- | ---: | ---: | --- |
| [原始基线](main-chat-ipc-baseline.tap) | 0 | 18 | 夹具漏接 `topicExecutionAuthority`。请求在执行授权阶段提前结束，`fetch` 未收到请求。 |
| [VM 加载诊断](main-chat-ipc-no-vm-loader.tap) | 0 | 18 | 从修复后的夹具临时移除 VM 动态加载器。到达真实读流代码后报 `A dynamic import callback was not specified.`。临时探针由测试命令清理。 |
| [仅修复夹具](main-chat-ipc-fixture.tap) | 15 | 3 | `#10` 普通取消拒绝无告警。`#12` 取消同步抛错跳过解锁。`#13` 取消拒绝值为 `null` 时无告警。 |
| [夹具与宿主修复后](main-chat-ipc-verified.tap) | 18 | 0 | 取消拒绝告警、同步抛错解锁及终态独立性均通过。 |

修复后的夹具执行真实 IPC 处理器、请求准备和 SSE 解码器。测试注入仅认可合成 Agent / Topic 的本地执行分类。SSE 使用 `choices` 内容帧，正常 EOF 用例在无尾分隔符的最后帧中携带 `finish_reason`。三项测试通过本地 HTTP socket 验证 DONE、传输断开和文档导航。
