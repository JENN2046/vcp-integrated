# ToolBox 工具回填回环验证

Node v24.22.1，独立临时 ToolBox 和本机回环 Provider。原版服务器通过 Git 内容安装，提交为 `de203be6673649b9c69be8c8d385f4adeec0e3fa`。候选从同一提交的工作树安装。两份记录保存实际运行文件 SHA-256。Provider 返回合成响应，ToolBox 真实解析并调用 direct 插件。插件写入独立调用日志。探针读取工具执行器的原始返回和 RAG 刷新入口参数，原实现照常运行。

[原版记录](baseline.json)和[候选记录](candidate.json)各包含一轮 JSON 会话和一轮 SSE 会话。每种模式有四次 Provider 请求、三个回填批次、四个工具调用。首批同轮执行两个工具，分别返回标量文本和 JSON 文档文本。第二批执行会返回业务对象的工具，其业务字段故意使用 `original_plugin_output`。第三批工具按文本、PNG、文本的顺序返回三个部件。标量样本包括换行、反斜线、引号以及类似协议的文字。

- 第一批的原版 Provider 回填包含序列化过的文本部件和标量元数据包装。候选用 `contentForAI` 回填标量原文，并逐字符保留 JSON 文档文本。
- 第二批在候选 Provider 消息中保留业务对象字段和值。第三批在两版 Provider 中均有完全一致的图片 URL、部件与顺序，RAG 刷新接收的图片 URL 为 `[Omitted]`。
- 消除自动生成的时间戳和工具记录 ID 后，RAG 入参、客户端可见响应、执行器原有字段逐项相同。Provider 的其他消息及每轮调用次数一致，各样本只执行一次。

[字节测量](comparison.json)计算每次 Provider 请求的 `JSON.stringify(messages)` 的 UTF-8 字节数。量到的是固定样本的请求大小。

| 模式 | 轮次 | 原版字节 | 候选字节 |
| --- | --- | ---: | ---: |
| JSON | 首次回填 | 912 | 701 |
| JSON | 含前两批回填 | 1446 | 1176 |
| JSON | 含全部回填 | 2001 | 1731 |
| SSE | 首次回填 | 909 | 698 |
| SSE | 含前两批回填 | 1440 | 1170 |
| SSE | 含全部回填 | 1992 | 1722 |

## 兼容性

- 共享 Work 协议在旧能力声明下拒绝双工具执行，收到允许的单工具返回后暂停，并阻止第二执行端重放。调用副作用计数保持 1。[协议回执](shared-work-protocol.json)
- 真实 Electron 桌面双工具 SSE 流程经工具安全暂停、压缩、丢失交接回执恢复和第二执行端接续完成。两种工具各执行一次。[桌面回执](desktop-duo-sse.json)
- 本地 AA 完成和取消各有一次子任务派发。共享 AA 测试通过。真实 Electron 桌面 AA SSE 流程从等待子任务到接收已验证报告，压缩交接后由第二执行端完成原来的 Work。[共享回执](shared-aa.json) [桌面回执](desktop-aa-sse.json)

## 复现

```sh
node tests/tool-payload/run.cjs /tmp/payload-baseline.json de203be6673649b9c69be8c8d385f4adeec0e3fa
node tests/tool-payload/run.cjs /tmp/payload-candidate.json
node tests/tool-payload/compare.cjs /tmp/payload-baseline.json /tmp/payload-candidate.json
node tests/tool-work-handoff/protocol.cjs
node tests/aa-delegation/local.cjs
node tests/aa-delegation/run.cjs --candidate
node tests/aa-handoff/run.cjs sse parent
node tests/integration/run.cjs tool-duo-returned-stream
```

本机主用户的 inotify 配额耗尽后，上述运行通过独立低权限 UID 和临时目录复测。桌面测试使用仓库已有的 Xvfb 运行资产。所有 Provider 调用限定在本机回环。
