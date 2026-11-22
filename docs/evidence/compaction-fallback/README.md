# 压缩模型备用与坏检查点恢复

桌面验收使用集成基线 `de203be6673649b9c69be8c8d385f4adeec0e3fa`。作者 VCPChat 固定参考为 `8a937038e789d303423c174b0b196492e7b18fa1`，核对范围为压缩模型设置、请求尝试和有效 History 窗口。作者提交是行为参考；桌面回执来自集成宿主。

各用例通过带沙箱的 Electron 从原生消息菜单或发送按钮进入，连接真实 VCPToolBox 和 SQLite，共享 History 通过原生投影落盘。所有模型响应、历史与工具输入均由本地回环夹具生成。

| 用例 | 基线实测 | 候选实测 |
| --- | --- | --- |
| 主摘要模型 HTTP 404 | 主模型 1 次，备用 0 次。ToolBox 封装为 SSE 后，桌面把错误正文作为检查点写入 Journal 和本机 History。 | ToolBox 响应为 HTTP 200、`X-VCP-Upstream-Status: 404`。备用接到相同正文和独立请求 ID，中央只准备、提交各 1 次。重开后两个真实模型请求各收到 1 个原检查点。 |
| 主摘要模型 HTTP 401 / 403 | 两个状态分别运行，主模型各 1 次。桌面误提交各自的 SSE 错误正文。 | ToolBox 响应头分别保留 401 和 403。各取消唯一准备，History 和 Journal 保持原样，备用调用 0 次。 |
| 主模型输出片段后断流 | Provider 连接断开，ToolBox 返回 `STREAM_READ_ERROR`。只有 1 次主模型调用，准备取消，原 Journal 与 History 完整保留。 | 同样只有 1 次主模型调用，备用调用 0 次。未完成摘要片段没有进入检查点。 |
| 重开前已有较旧有效检查点和较新坏检查点 | 原始 History 保留两条记录，下一次请求选择较新的错误检查点，较旧有效检查点和两者之间的普通消息没有进入模型。 | 下一次请求在真实 handler 和 Provider 两处都含 1 个较旧有效检查点和夹层对话，错误检查点出现 0 次。原始投影记录与 Journal 前缀完整保留。 |
| 中央提交成功后切断压缩 ACK | A 进程异常退出后从原 Profile 恢复。同一意图与检查点核对成功，中央 Work 关联和 Journal 前缀一致。B 重开后接管同一 Work，Provider 收到带同一检查点的续轮。摘要、工具副作用各一次。 | 同样找回原意图、原检查点和原 Work。重试提交使用同一请求正文 SHA-256；恢复期间 Journal 未增加。B 实际续轮仍使用原 Work，摘要和工具副作用各 1 次。 |

回执保留 Provider 请求、SSE、IPC、加载源码 SHA-256 和 SQLite 读出的身份或水位。坏检查点用例从合成 Journal 引入一条与历史误提交格式相同的记录，保留介于好坏检查点之间的普通消息，经过真实重开和正常发送路径验收。原同端 `compact-e2e` 和 History inode 竞争恢复 `compact-history-identity` 也各在 Electron 复跑通过。

## 复跑

按仓库 README 安装锁定依赖并构建宿主产物。在 `vcp-integrated` 根目录用 Node 24 运行。每个场景打印隔离的原始证据路径。

```sh
for case in 404 401 403 unknown history ack; do
    node tests/integration/run.cjs "compact-fallback-$case"
done
```

基线对照在 `de203be` 的分离 worktree 使用同一套测试文件和该版本的本地包。基线预期在 404、401、403 和坏检查点用例触发新断言，其余两项通过。可用 `TMPDIR` 和 `XVFB_BIN` 指定隔离输出根和 Xvfb 路径。本次本机接近 inotify 上限，两组运行都使用 `NS_FIXTURE_POLL_WATCHERS=1`，由隔离 ToolBox 的测试预加载把 Chokidar 切到轮询并停用本批无关的 RAG 参数热加载监听。原生目录监听、Electron/CDS、执行、同步和落盘继续运行。

[基线回执](baseline.json) · [候选回执](candidate.json)

[404 备用检查点在 A 原 Profile 重开后的画面](404-checkpoint-reopened.png) · [丢回执后 B 恢复原 Work 的画面](ack-original-work-recovered.png)

备用模型留空时沿用单模型。明确的 HTTP 400、404、422、429 允许切换一次；其中 404 经过上表的完整桌面实测，其余三个状态覆盖在桌面服务测试。提交入参记录选用的模型，V1 共享元数据合同保持原样。核对实际模型请用本轮 Provider 请求回执。

桌面压缩、流式读取及中断测试共 67 项通过。原生宿主套件 308 项通过，默认跳过的 6 项旧 A 端兼容用例用旧版 Electron 生成的隔离 Profile 单独补跑通过；协作套件 60 项通过。主备模型设置专项通过，完整设置金测中有两项涉及既有的 `suveiHumanAuthorization` 字段差异，在改前基线同样失败。

404、401、403、断流和历史窗口五组使用已冻结的压缩代码，运行时工具桥接仍为 `8ed616f`。实际执行工具的丢 ACK 用例已在 `33e9e43` 的工具桥接上复跑，其加载文件 SHA-256 与最终工作树一致。
