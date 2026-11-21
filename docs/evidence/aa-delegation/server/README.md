# AgentAssistant 共享委托服务端实测

在 Linux x64、Node 24 下启动真实 VCPToolBox。测试目录只使用已跟踪的宿主源码、独立数据库、AgentAssistant 正常插件发现及合成 Agent 配置。模型请求由回环 HTTP Provider 应答。父 Work 模型与子任务模型使用不同模型名，Provider 分别记录父轮数、无助手历史的子任务首轮和后续心跳轮。测试同时核对原生插件中的委托 ID、共享任务 ID、调用记录和派生请求 ID。

| 场景 | 基线 | 候选 |
|---|---|---|
| 子任务首轮尚未返回，重交原始请求 | 找回同一 Work。父 Work 已完成，原生 AgentAssistant 仍在运行，共享 Work 无子任务 | 找回同一 Work。父模型已结束，共享 Work 仍保留原子任务运行状态 |
| 子任务正常完成 | 原生任务完成，有两轮子模型请求 | 原始子任务完成，返回可核验报告。父模型两轮，原生委托一次，子模型两轮 |
| 子任务活跃时停止 | 共享停止入口返回 404。测试通过原生管理面板 API 结束基线任务 | 观察端请求被拒绝。发起端停止被接纳，重试返回同一状态，原生任务最终取消 |
| 子模型请求尚未返回时强停 ToolBox | 重启后原 Work 仍显示完成，共享 Work 无原生任务状态 | 同一 Work 进入待核查，同一子任务保持 `unknown`。重启和重交均未新增模型请求或 Journal 写入 |
| 强停后读取先前成功的报告 | 共享 Work 无报告绑定 | 返回相同 Work、任务 ID 和报告哈希，没有新增模型请求 |

基线与候选均观测到三次首轮派发、四次子模型请求、六次父模型请求。失败前后的状态以共享 HTTP 读接口、原生管理接口和只读账本交叉核对。回执保留合成运行的 ID、状态、计数和所加载源码的哈希。[基线回执](before.json) · [候选回执](after.json)

## 复跑

先按仓库 README 安装 Node 24 依赖并构建，再运行：

```sh
node tests/aa-delegation/run.cjs 5d5421c1e5e0dc3085dbd2683838ade385372eeb docs/evidence/aa-delegation/server/before.json
node tests/aa-delegation/run.cjs --candidate docs/evidence/aa-delegation/server/after.json
```
