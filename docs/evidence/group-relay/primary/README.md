# 共享群聊取消剩余接力的独立环境验收

使用真实 VCPToolBox、构建后 PWA 和两个独立的 Chrome 设备会话。模型端走本机回环 SSE，使用固定的 A → B → C 成员顺序。每位成员的请求按其系统提示中的合成标记在 Provider 端独立计数。数据库通过只读连接核对，执行、历史和接力命令均由实际宿主处理。复跑方式见 [测试入口](../../../../tests/group-relay/README.md)。

| 场景 | 实际结果 | 回执 |
| --- | --- | --- |
| 修改前 | A 已保存，B 流式输出，C 排队。实际点击旧版同名按钮后，B 的 Provider 连接被关闭，C 未启动，B 未完成。 | [baseline.json](baseline.json) |
| B 正常完成 | 点击后丢弃成功响应的 JSON 正文。发起端重开并核对原 Work，显式重试得到同一 Work 的成功响应。只读端实时看见 B 继续执行和 C 被取消。A、B 各保存一次，C 未调用。新一轮从同一话题的输入框发起，A、B、C 各执行一次。 | [finish.json](finish.json) |
| B 的 SSE 中断 | Provider 的实际响应套接字关闭。Work 与共享 admission 保持待核对，B 临时片段仍可见，B 的正式回复不存在。 | [cut.json](cut.json) |
| B 执行中后端 SIGKILL | 收到同 Work 的成功重试响应后向实际后端发送 SIGKILL，用同一合成库重启并分别重开两端。两端按原生步骤 ID 显示同一段带缺口标记的临时内容，历史仍只有用户消息与 A 的正式回复。 | [crash.json](crash.json) |

第一轮 A/B/C 的 Provider 调用均为 1/1/0。成功停止剩余接力后，Work 为 cancelled，已完成的共享 admission 为 completed。界面显示「剩余接力已取消」并列出已保存的 A/B 与取消的 C。只读观察界面未发起执行请求，测试驱动另行向同一路由发送一个越权请求，宿主返回 404。回执含实际加载的后端文件和浏览器收到的 PWA bundle SHA-256。

- [旧版点击前](baseline-owner-before.png) 与 [旧版点击后](baseline-owner-after.png)
- [发起端点击前](finish-owner-before.png)、[只读端看到 C 取消且 B 仍执行](finish-observer-reopened.png)、[发起端看到 B 已正式保存](finish-owner-after.png)
- [SSE 中断后的发起端](cut-owner-after.png)
- SIGKILL 后重新打开的 [发起端](crash-owner-after.png) 与 [只读端](crash-observer-after.png)
