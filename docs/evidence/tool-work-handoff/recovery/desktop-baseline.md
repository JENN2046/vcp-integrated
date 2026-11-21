# 桌面相关套件基线对照

以完整提交 `bd7f62d02bb551ad2a391b5f6dff58ba51f055e7` 的 Git 快照为基线。基线与候选复用同一份锁定桌面依赖，使用相同 Node v24.22.3。基线用其自身的 build-shared-renderer-rules 脚本生成受测入口需要的工具区域解析模块。以下命令均在各自的仓库根目录运行。

```bash
node --test apps/desktop/tests/{vcp-stream-bridge.test.mjs,main-chat-response-body.test.mjs,main-chat-stream-consumer.test.js,main-chat-surface-adapter.test.mjs,stream-manager-terminal-cleanup.test.js,stream-coordinator.test.mjs,chat-compaction-interrupt.test.mjs,context-compaction-*.test.mjs}
```

原候选与基线均为 129 项、108 通过、21 失败。按用例完整名称排除耗时后，两个失败集合完全一致。
加入空前缀暂停回归后，候选为 130 项、109 通过、21 失败，失败集合仍与基线完全一致。

- Main Chat IPC 的 18 项用例在基线已失败。既有夹具缺少带本地 Topic 归属验证的 NativeSync authority，也未向 VM 提供动态模块加载。临时补齐这两项后，部分旧样本仍使用缺少 choices 或有效终止帧的 SSE 流。保留原有夹具，独立添加已归档空前缀暂停的渲染回归。
- Main Surface 的一项失败源于历史断言期待“已保存”措辞，而实际结尾明确表示本轮仍待核实。
- 两项样式断言从仓库根读取相对路径 styles/chat.css，因而报 ENOENT。从 apps/desktop 单独重跑两项均通过。

## 两边共同失败的用例

- DONE before EOF cancels the actual response body and retains a single end event
- DONE closes a real local HTTP response which the server deliberately leaves open
- a non-Error cancellation rejection cannot throw from the cleanup reporter
- a real HTTP disconnect after a data chunk emits one read error and releases the task
- a synchronous reader cancellation failure still releases ownership and the lock
- accepted interruption retains producer terminal delivery and its received content
- chat presentation surfaces retain frosted backdrops without nested card captures
- checkpoint text survives sanitizers and its private protection flag stays local
- failed interruption (hung) releases the caller's HTTP reader without a duplicate terminal
- failed interruption (missing-settings) releases the caller's HTTP reader without a duplicate terminal
- failed interruption (rejected) releases the caller's HTTP reader without a duplicate terminal
- failed interruption (transport-error) releases the caller's HTTP reader without a duplicate terminal
- failed interruption from another IPC window cannot abort the original HTTP reader
- main Surface renders terminal stream errors with the initial messageId
- normal EOF preserves a final partial SSE line and does not cancel a completed body
- pending old cancellation does not retain its reader or finish a reused message task
- read failure remains the primary terminal error when cancellation also rejects
- rejected cancellation is reported without duplicating the successful terminal event
- sender navigation aborts the real HTTP stream without delivering into the next document
- the streamed request body does not ask the server for stream usage
- thinking and streaming messages opt out of content-visibility clipping
