# 手机上参与共享群聊并邀请乙

在固定产品版本 `c1b8ffc6272f` 上，原 Android 16 手机用户 12 的 Firefox PWA 获得测试共享空间的读取与执行权限。Jenn 在邀请制群聊中亲自发送「大家好，晚上开心吗」，再从成员下拉框选择乙并点击一次「邀请」。Linux 隔离桌面全程打开同一群聊。

| 动作 | 中央实际执行 | 手机与桌面所见 |
| --- | --- | --- |
| 发送普通消息 | HTTP 202，发言计划为空，甲、乙的 Provider 调用均为 0 | 两端都只有一条用户消息，消息 ID 与正文一致，末尾换行保留。 |
| 邀请乙 | HTTP 202，独立邀请绑定原用户消息，计划仅有乙。Handler 与本地合成 Provider 在用户角色中各收到一次原文，甲调用 0 次、乙调用 1 次。 | 两端自动出现同一条署名乙的正式回复「乙：收到邀请。这是隔离测试回复。」。Journal 只有用户原文和乙的回复。 |

[中央发言计划和派发回执](central/central-verified.json) · [手机上的两次点击与终态消息](android/04-history-2-actions-2.json) · [桌面 History、DOM 与 Journal 的对照](linux/completed-comparison.json) · [桌面截图](linux/completed-observed.png)

实机还暴露了两处显示问题。仅保存用户消息时，提示写了「云端已接受 · 回复已保存」，此时还没有 Agent 回复。本轮手机终态原样布局的历史可视区仅约 18 CSS px，屏幕难以读全已经抵达的正文。邀请在约半秒内完成，采样期间未捕获可见的分段预览。[发送后提示](android/02-history-1-actions-1.json) · [终态原样截图](android/05-terminal-original-layout.png) · [实机布局测量](android/terminal-layout-as-observed.json)

手机已切回机主，隔离用户保留 PWA 与限期测试 CA。桌面 Electron 和 CDS 已正常退出。 [手机清理回执](android/cleanup.json) · [桌面清理回执](linux/cleanup.json)
