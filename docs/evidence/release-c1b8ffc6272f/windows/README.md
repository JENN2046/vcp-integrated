# Windows R16 验证

Windows 11 x64 使用原 R16 虚拟机和 R16Limited 测试账号。原基盘以只读方式打开。本轮的差分盘、固件变量、TPM、测试 Profile 和介质已回收。来宾经 ACPI 正常关机。 [关机事件](vm-shutdown.json)

从固定提交导出源码，清洁安装 Windows x64 锁定依赖，生成 chat preload，并通过 MinGW 从同一 Git 树构建 CDS。Electron 使用已校验的 44.9.3 Windows x64 发行包。两个完成回执中的 Electron 和 CDS 执行路径及摘要与构建相符。主进程 require.cache 和渲染进程 CDP 证明实际加载了 15 个文件，摘要逐一匹配 Git 树。Windows Electron 的 web preferences 未返回 preload 字段。报告中的 preload 摘要采用候选 BrowserWindow 源码明确配置的路径，并用真实渲染启动和调用 preload API 的结果交叉核对。 [构建与虚拟机范围](build-and-vm.json)

PID 2680 在发送前打开目标话题，随后观察到两条可见消息与同一 Work。采集器在取 preload 路径时退出，原因和原进程的观察摘要均已留存。修正采集器后，使用同一 B Profile 对既有终态作完整采集和冷重开，PID 分别为 9340 和 6040。两次均正常退出，Electron 和 CDS 进程归零。三个观察进程的发送 IPC 均为零。

- [发送前回执](ready.json) · [截图](before.png)
- [原进程的终态观察](initial-observation.json) · [采集器错误](collector-first-error.json)
- [完整终态回执](first.json) · [截图](first.png)
- [冷重开回执](reopened.json) · [截图](reopened.png)
- [同 Profile 核对](closeout.json) · [中央 Journal 对照](central-comparison.json)
