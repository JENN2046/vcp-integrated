# 普通本机与共享单聊附件路径实测

三份独立 Electron Profile 在 Xvfb 下运行。普通本机 L 与共享 A 用同一 UTF-8 合成文件、同一提示词和主聊天发送按钮。共享 B 重开后在同一话题续问。测试只替换文件选择结果，保存附件、聊天请求、IPC、ToolBox 处理及 History 均由实际程序执行。模型端点是回环合成 Provider。

| 运行 | 普通 L 附件 URI／History 路径 | 共享 A 附件 URI／History 路径 | 共享 B 附件 URI／History 路径 |
| --- | --- | --- | --- |
| [基线，默认工具策略](native-attachment-baseline.json) | 有／有 | 有／有 | 无／无 |
| [基线，显式禁工具](native-attachment-baseline-forbidden.json) | 有／有 | 有／有 | 无／无 |
| [候选，默认工具策略](native-attachment-candidate.json) | 有／有 | 有／无 | 无／无 |
| [候选，显式禁工具](native-attachment-candidate-forbidden.json) | 有／有 | 无／无 | 无／无 |

- L 和 A 的每轮请求分别采集 renderer 的原生编排输出、主进程收到的 `sendToVCP` IPC、ToolBox handler 入参以及 Provider 实际收到的用户消息。renderer 与 IPC 快照逐字段相同，各层以同一请求 ID 对齐。
- B 续问由服务端接手，桌面没有组装模型请求或调用 `sendToVCP`。A 退出后，测试移走选择的源文件和 A 缓存，B 的下载缓存保持禁用。B 的 handler 和 Provider 中仍各有一次完整附件正文，标签为 `synthetic-continuity.txt`。共享端只有 A 的一次上传、一个附件链接及三个上传步骤，共四条 Journal 消息。
- 显式禁工具组通过共享 Agent 配置保存 `[[VCPToolUse=Forbidden]]`。请求进入 handler 时含该指令，Provider 收到的系统消息中该指令已被 ToolBox 消费。候选同一 ToolBox 实例内的补充探针向允许与禁用请求返回同样的合成工具语法。允许请求执行计数工具一次，收到工具回执后第二次调用 Provider。禁用请求执行零次，也没有第二次 Provider 调用。
- JSON 只保留合成消息、路径类别及验收元数据，临时目录替换为 `<isolated-run>`。候选回执记录 renderer 实际加载的三个模块哈希。修订号标识候选改动所基于的提交。

用 Node 24 和 Xvfb 运行。基线两组在 `95e3f56` 上设置 `NS_ATTACHMENT_PATH_BASELINE=1`，显式禁工具组另设置 `NS_ATTACHMENT_TOOLS_FORBIDDEN=1`。

```sh
node tests/shared-attachment-continuation/run.cjs
NS_ATTACHMENT_TOOLS_FORBIDDEN=1 node tests/shared-attachment-continuation/run.cjs
```

## 谁加入路径，谁消费路径

桌面原生 [chatContextPipeline.js](../../../apps/desktop/modules/chat/chatContextPipeline.js) 从 Agent 的 `agentDataPath` 和话题 ID 生成 History 提示行，从 FileManager 保存的 `src/internalPath` 生成附件标题。缓存 URI 指向 A Profile 里的副本，用户选择的源文件另有路径。文件提取、上传和跨端关联均在这行模型提示之外完成。IPC 会规整消息字段，但两个路径此时已成为字符串正文。ToolBox 收到的包与回环 Provider 实收包可按同一请求 ID 对照。[Provider 系统消息与附件标题摘录](provider-fields.json)

本机工具可以用实际文件路径定位原文件；FileFetcherServer 可在处理工具参数时解析 `file://`。本机 FileOperator 的 UpdateHistory 读取并写回指定 JSON；直接写 A 的共享投影无法形成中央 Journal 操作。共享桌面首轮现在从原生组包的自动系统前缀中省去该投影路径，保留话题创建时间和用户自己写的路径。普通本机单聊保留现有约定。[工具消费者实测及范围](consumers.md)

共享 A 在组装出的系统提示显式包含 `[[VCPToolUse=Forbidden]]` 时，已内联正文的普通 `text/plain` 附件使用显示名。工具可用时保留文件 URI。关闭工具提示注入只影响路由，不能据此移除定位符。修复从生成标题处生效；原消息中的用户文字、实时文件引用、媒体读取所需路径、History 和 CAS 都继续按原生路径处理。

基线复跑需在 `95e3f56` 的隔离检出中提供本次的 `tests/shared-attachment-continuation` 夹具及已构建依赖，保持产品源码固定。四组发送均使用同一份 67 字节合成文件；另有 22 项桌面组包等定向测试、12 项上下文及附件边界测试通过。原生宿主套件 309 项通过、6 项需要外部历史夹具而跳过，协作套件 60 项通过。
