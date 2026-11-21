# 原 Windows 虚拟机与同一 Work 的三端核对

原 Windows 11 虚拟机使用独立差分盘，正常登录普通账户 `R16Limited`。来宾为 Windows x64 build 22631。实际执行的 Electron 为 44.9.3；原生 CDS 的可执行文件经 SHA-256 核对，连续两次在同一合成根目录启动、随受管父管道关闭并释放实例锁。Windows 的新合成 B Profile 在中央工作完成后加入。

| 观察位置 | 实际结果 |
|---|---|
| Linux A | 发送合成输入，桌面 History 有一条用户消息、一条助手回复 |
| Android 16 | 只读会话先观察同一在途 Work，锁屏、断桥、进程终止后重开，读到同一对消息 |
| Windows B | 原生窗口显示同一对正文，独立从 B 的物理 History 读回两条 ID、角色和内容；取证时同一测试目录的 Electron 和 CDS 均在运行 |
| 中央服务 | Work 为 `request_f59a8de1b7a4461ba14478064ce61f7c`，完成态。实际派发、Provider 调用各 **1**。Journal 序号 1、2 依次对应输入和回复 |

输入 ID 为 `msg_1795231479085_user_8kfqawllov`，回复 ID 为 `reply_request_f59a8de1b7a4461ba14478064ce61f7c`。收回 Windows 合成证据盘后，按顺序对齐三个观察端与中央 Journal 的消息 ID 和角色。Windows 对应的 Work 由中央记录与已落盘的回复 ID 关联。联验使用非流式合成回复，Windows 观察的是已完成工作。

初次 Windows 启动暴露出便携启动器漏生成共享渲染规则，已在 B 的隔离目录补建。随后来宾时钟相对宿主 UTC 慢约八小时，原测试叶证书在来宾看来尚未生效。Windows 用覆盖两端时点的临时 CA 和叶证书严格验证专用回环入口；该入口向原 Linux 协调服务转发时仍验证原证书链。同一服务、同一数据库和 Work 一直保留，Windows 系统 CA 没有改变。

Windows B 从托盘执行原生退出，观察到 `electron-quit`，按本轮测试目录核对 Electron、CDS 和 relay 的剩余进程数为 0；未取得 Windows 数值退出码。Linux A 与协调器正常退出，18443、28443 均已释放。原 Windows 虚拟机留在已登录的普通桌面。

[跨端机器回执](receipt.json) · [Windows 实际窗口](windows-b-same-work.png) · [Linux 实际窗口](linux-same-work.png) · [实体 Android 重开](../android-device/android-reopened.png) · [Linux 选区观察范围](../linux-selection-observations.md)
