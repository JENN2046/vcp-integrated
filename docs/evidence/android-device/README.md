# 实体 Android 的同 Work 恢复

在 Android 16 实体机上，新装的隔离 WebView 只信任本轮临时 CA，通过 USB 回环访问同一构建的 HTTPS PWA。用真实配对 UI 兑换一次性只读授权，页面显示服务可达且浏览器上下文安全。

Linux 桌面 A 发送一条合成输入。手机看见原输入和正在运行的 Work。手机电源状态读回 `Dozing` 后，移除测试端口的 ADB reverse，并强制停止临时应用、确认其进程已退出；此时服务端仍是同一个 running Work。手机离线期间释放合成 Provider 的回复，服务端完成工作。重开应用，原只读会话恢复，手机看到相同 Work 和与 Linux History、中央 Journal 逐条匹配的输入及回复。两次观察之间，Provider 总调用数为 1。这个用例使用非流式回复。

Linux 草稿保持。已有用户消息的选择文本在终态渲染后变空，且布局变成无溢出。此次观察不足以证明可滚动话题的阅读位置保持。Windows 未列入该次双端回执。

测试结束后已卸载 `dev.nativesync.qa.three`，并核对其调试 forward 及测试 reverse 已移除。手机系统 CA 和日用浏览器配置未作修改。

[工作、消息、Journal 序号及界面回执](receipt.json) · [手机观察运行中工作](android-held.png) · [手机重开后读回终态](android-reopened.png)
