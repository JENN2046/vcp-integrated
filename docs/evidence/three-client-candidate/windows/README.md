# Windows 候选首开与重开

候选为 `7829b83ccb634c397caa6a168d9fe0d8663cb12e`。在原 R16 Windows 11 测试虚拟机基盘的独立差分层，以普通测试账户运行 Windows x64 原生 Electron 44.9.3 和 CDS。QEMU 确认原基盘为只读，来宾仅通过受限转发访问本次 Linux 回环服务。来宾时钟通过本次 QEMU 的 RTC 启动参数对齐，两次运行均用临时 CA 严格校验同一个 HTTPS 服务，得到 HTTP 200。

Linux A 在同一合成话题提交一次。Windows B 在该 Work 完成后，以全新的 B Profile 首开话题，正常退出，再用同一 Profile 启动新进程并重新打开话题。两次窗口均显示用户输入及助手回复，Windows 物理 History 中仅有同一对消息。消息 ID、角色、正文字节数和 SHA-256 与同场实体 Android 记录相符，ID 与 Linux History 及中央 Journal 一致。

| 检查项 | 结果 |
| --- | --- |
| Windows Electron 主进程 PID | 首开 9348，重开 5180 |
| 原生 CDS | 两次各有一个运行实例，二进制摘要相同 |
| 关闭 | 两次退出码均为 0，按测试目录核对 Electron 与 CDS 进程均归零 |
| 中央 Work | `request_36f6c924891e4df7a383a27762534321`，完成态，派发与 Provider 总调用均为 1 |
| Journal | 第 1 条为原输入，第 2 条为原回复，Windows 重开后序号与 Provider 计数保持一致 |

首轮夹具通过 Electron 标准输入发窗口控制指令时超时。保留该次失败回执。正式复验仅把夹具命令传递改为在本次隔离目录读取文件，产品源码和同一中央 Work 均沿用。本轮 Windows 测试来宾已正常关机，合成回执与截图从测试证据盘导出。

[首开回执](first.json) · [首开窗口](first.png) · [重开回执](reopened.json) · [重开窗口](reopened.png) · [三端核对](three-client-comparison.json) · [Windows 重开后中央记录](../build-linux/work-post-windows-reopen.json) · [首次夹具超时](initial-harness-timeout.json)
