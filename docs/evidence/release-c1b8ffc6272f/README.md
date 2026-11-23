# c1b8ffc6272f 共享单聊三端交付验证

固定提交 `c1b8ffc6272f64626fc6465434372bcb632aabe4`，Git tree `81b3497e17deba0313b0edd7123067dafdb11cda`。Linux 从独立干净检出构建，Windows 从同一 Git 树导出、按锁文件安装 Windows x64 依赖并编译 CDS，手机使用原 Android 16 隔离用户 12 已安装的 Firefox PWA。模型服务仅监听回环地址。三端先打开同一空话题，由 Linux 实际点击发送一次。

| 端 | 重开结果 | 运行版本核对 |
| --- | --- | --- |
| Linux | 原进程 1779328 正常退出，新进程 1785234 从原 Profile 读回两条消息与已完成的 Work。 | 两次采集均核对 5 个已加载主进程模块、6 个渲染模块，以及运行中的 Electron、CDS 和服务端加载的 Vexus、SQLite。 |
| Windows | 原 R16 虚拟机的观察窗口在发送前就位。原 B Profile 完整终态采集和冷重开时 PID 分别为 9340、6040。 | 15 个实际加载的 JS 摘要与固定源码相符。首次观察在采集 preload 路径时遇到空值；再次采集保留同一 Work，preload 按 BrowserWindow 配置文件的摘要和可用 IPC 核对。[原始故障与补采方法](windows/README.md) |
| Firefox PWA | 只读设备看到了在途和完成态。强停并用原 PWA 的安装入口冷开，PID 由 32433 变为 5416，仍是原话题和配对会话。 | 两次均从 Firefox Debugger 读取正在执行的模块源，189,721 个 UTF-8 字节逐字节匹配回环 HTTPS 响应和本次构建。 |

**同一笔 Work** 为 `request_2699fc38ef4b4db6bce39676572afb8e`。Journal 序号 1 是用户原文 `Send-recovery compare 02: accept exactly once.`，序号 2 是助手正文「合成回复完成。」。三端逐条核对消息 ID、角色和正文；Linux Markdown 显示层附加的单个 LF 单独验证。中央完成后和所有端重开后的快照完全一致：1 个 Work、1 次尝试、1 次派发、本地 Provider 1 个请求，状态为 completed。

在此目录运行 `python3 compare.py` 可从保存的回执重算结果。[逐项对账](three-client-comparison.json) · [在途](central/work-held.json) · [重开后中央记录](central/reopened-facts.json)

**手机实际运行的 JS** 为 `index-Cuf1bKRk.js`，SHA-256 为 `163525d2fd59f47c752b13a0c52218abad4f6665340d2ee3784364a262937420`。旧产物 `index-Bsu6-SLg.js` 的摘要不同；新包包含人工结清文案。首次联网与冷开各取得一份调试器源回执；离线预检只取得文件名。本轮实发用例是正常完成的单聊，502 文案的实机行为见[此前的同笔结清对照](../mobile-work-closeout/README.md)。[首次运行模块](android/02-loaded-module.json) · [冷开运行模块](android/06-cold-loaded-module.json) · [8 项实际 HTTPS 资产](central/served-assets.json) · [29 项构建摘要](build/SHA256SUMS)

**重开截图**　[Linux](linux/reopened.png) · [Windows](windows/reopened.png) · [Android](android/05-cold.png)

Linux 桌面选择专项 37/37；额外运行的桌面聊天内核套件为 607/631，其余 24 项在直接父提交中按用例名及位置复现。[构建与回归范围](build/README.md)

Windows 已正常关机并回收本轮差分盘。Android 已切回机主，用户 12 保留原安装入口和限期测试 CA。ToolBox 正常退出；采集协调器仍持有回环监听，留存证据后已终止并确认关闭。隔离 Linux 显示器已退出。[Windows 关机](windows/vm-shutdown.json) · [手机收尾](android/cleanup.json) · [中央收尾](central/shutdown.json)
