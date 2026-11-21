# 本地单聊的工具返回处自动中断

隔离验收使用 Linux x64、启用沙箱的 Electron 44.9.3、原生聊天数据服务和独立 VCPToolBox 进程。模型端是只监听回环的合成 SSE 服务。桌面使用一次性 Profile，测试通过真实发送按钮开始单聊。没有点击停止按钮。

测试先等部分回复出现在桌面上，再放行模型的工具请求。ToolBox 执行一次普通计数插件并记录结果。合成模型保持后续响应打开，直到 Toolbox 中断请求关闭它。测试记录真实 HTTP 中断收据、ToolBox 返回的 SSE 终态、压缩请求进入代理时的物理 History、压缩模型输入和接续模型输入。重开桌面后再次核对 History、快照数量和工具执行次数。

## 基线

- 角色分隔开启。工具返回后，桌面向 ToolBox 发出一次 `POST /v1/interrupt` 并收到 HTTP 200。上游流在未正常结束时被关闭。ToolBox 随后只发送了普通的 `[DONE]`，History 将该部分回复标记为 `completed`。压缩模型收到请求时，该条 History 已落盘。后续产生一个快照并接续一次。普通工具只运行一次。 [基线收据](baseline-role-divider-on.json)
- 角色分隔关闭。ToolBox 发送了一个完整原生工具返回批次，并开始等待下一轮模型响应。验收在 8 秒内未观察到中断请求或压缩，直到关闭隔离进程才断开上游。 [基线收据](baseline-role-divider-off.json)

## 修复后

角色分隔开启和关闭均通过。普通工具的返回批次先抵达桌面，随后只发出一次针对原请求的 `POST /v1/interrupt`。ToolBox 返回 HTTP 200，并关闭尚未发送终稿的上游连接。原 SSE 流在工具返回之后只发出一个空正文的 `interrupted` 终态，紧跟一个 `[DONE]`。

压缩请求进入回环代理时，物理 History 已包含原用户消息及原请求 ID 对应的 `interrupted` 部分回复。压缩模型使用这份历史生成一个快照，接续模型输入使用该快照，接续回复单独记录为 `completed`。重开原 Profile 后四条消息完全一致，本地入场持久记录的未结条目和租约均为 0。ToolBox 只留下一个普通工具成功记录，AA 执行次数和共享 Work、Journal、共享压缩意图行数均为 0。

- [开启角色分隔的收据](candidate-role-divider-on.json)
- [关闭角色分隔的收据](candidate-role-divider-off.json)
- [工具执行前的实时部分回复](provider-prefix-live.png)
- [重开后保留的工具回执、压缩快照和接续回复](checkpoint-reopened.png)

## 重跑

在已构建的集成仓库根目录，使用 Node 24、Xvfb 和可用的 Electron 系统沙箱。

```sh
node tests/integration/run.cjs local-stream-interrupt
VCP_TEST_STREAM_ROLE_DIVIDER=0 node tests/integration/run.cjs local-stream-interrupt
```

可用 `TMPDIR`、`XVFB_BIN`、`ELECTRON_BIN` 指定本机路径。运行结束后关闭 Electron、ToolBox 和 Xvfb，保留命令输出指向的完整合成运行证据目录。仓库收据保留相关已加载的源码哈希、HTTP/SSE 事件、History 内容摘要和计数。

完整合成运行目录由本批次保留在仓库的忽略目录 `.runs/local-interrupt-tmp` 下，供复核或在后续资源整理时回收。
