# 真人验收中遇到的 502

固定现场版本为 `b5648e96d883`。Linux A 的第二笔发送已进入中央 Journal。本机推理进程在请求到达前退出，回环转发收到 ECONNREFUSED 并返回 502。ToolBox 对流式桌面保持兼容，回传 HTTP 200、上游状态头和一段错误说明；共享执行读取器将错误说明当成了待发布正文。Work 停在 publishing，准入记录要求核对，原生请求为 unknown。没有工具调用、原生终稿或正式助手消息。

按 Jenn 明确选择，使用原发送桌面的「确认放弃并解除暂停」结清这一笔。结清前后 Journal 相同，模型调用计数没有增加。同话题下一笔由 Jenn 主动发送，在恢复的本机模型上正常完成。模型现由测试专用用户服务运行。[现场前后状态](live-502-closeout.json)

在另一个隔离实例用合成 Provider 重现真实 ToolBox 的相同 502/SSE。修复让共享原生响应读取器识别宿主设置的上游状态头，在读取兼容展示正文前进入已有模型错误处理。这样 Work 和准入都能进入 review_required，原生 unknown 保留；原用户行保留，pending_operation 与助手终稿为空。相同请求 ID 重送返回原 Work，上游只接到一次请求。[改前](upstream-error-before.json) · [修复验证](upstream-error-after.json)

本记录只覆盖该错误处理；真人三端续写的结论另行记录。现场持续使用原固定版本。
