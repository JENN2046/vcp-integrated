# 工具 Work 重启复核

使用 Node 24、独立 ToolBox 进程、真实 NativeSync HTTP 接口和 SQLite、回环合成模型及原生插件桥。Counter 在测试目录写入并 fsync，再按场景返回或挂起。对测试子进程发送 SIGKILL，然后用同一数据目录启动新进程。

| 场景 | 实测结果 |
| --- | --- |
| 既有普通工具路径 | Counter 已写、回执未返回时杀进程。重开后同一执行进入 review_required，原 invocation 仍为 started。用原提交重试后，Counter、provider、Journal 和 attempts 持平。见 [baseline.json](baseline.json)。 |
| safe-tools-v1，副作用结果未知 | 截断已提交的 HTTPS admission 回包，按请求标识找到同一 Work。Counter 落盘后，压缩、B 移交及续代均被拒。重启后 Work 为 review_required，原生请求为 unknown，原 invocation 仍为 started。同一提交返回幂等回执，重发原生 HTTP 请求返回 409。重开后压缩、移交、续代仍被拒。独立查询确认一个 Work、一次 Counter、一次 provider、一个用户 Journal，工具结果归档和压缩意图均为空。见 [unknown.json](unknown.json)。 |
| safe-tools-v1，原生回执已持久化 | Counter 已返回，暂停检查点提交后杀进程。重开后保持 awaiting_compaction，原 Work、原生请求、工具调用、Journal 和归档证明保持一致。新压缩输入读取到唯一关联的原生工具结果。Counter 和 provider 仍各一次。测试随后取消了压缩意图。见 [known.json](known.json)。 |

合成 provider 和 Counter 的结果适用于该工具与测试窗口。started 表示已记录原生派发意图，副作用结果仍待核对。

在集成工作区运行下列命令。预备资产沿用集成测试的本地后端依赖、Vexus addon 和 Mobile build。若系统临时目录配额不足，可把 TMPDIR 指向已有的可执行本地测试目录。

```bash
node tests/ordinary-tools/run.cjs bd7f62d02bb551ad2a391b5f6dff58ba51f055e7
node tests/tool-work-recovery/run.cjs
node tests/tool-work-recovery/run.cjs --known-receipt
```

测试结束时回收临时服务器进程、合成 HTTPS 私钥和运行盒。JSON 保留判定数据及实际加载文件的哈希。
