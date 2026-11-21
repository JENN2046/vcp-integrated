# 共享群聊取消剩余接力

在固定顺序 A、B、C 中，A 已写入 History，B 正在回复，C 尚未开始。基线 `2c88e4aad704` 的「取消剩余接力」按钮会同时中断 B。本批把共享 PWA 的这个动作对齐原生桌面队列。截止位置由服务端持久认领成员步骤的时刻决定；原始发言计划、Work 和成员请求 ID 继续可查。

候选用例中，丢失取消回执后重开页面并重试，A、B、C 的 Provider 请求数仍为 **1、1、0**。A 和 B 的完整回复各写入一次，C 的尝试数为 0。群聊执行显示「剩余接力已取消」，共享准入在已执行成员完成后结算并释放话题。同一话题的下一轮三位成员均能正常发言。[基线回执](primary/baseline.json) · [候选回执](primary/finish.json) · [最终界面](primary/finish-owner-after.png)

- **审批与权限。** B 等待人工审批时，取消后续成员会保留原审批。批准后的工具接收端计数为 1。只读会话可观察 B 和 C 的状态；新命令按 Cookie 会话、共享话题执行权限及原 Work 所有者校验。[审批与旧版全停回执](compat/shared-approval-and-legacy.json)
- **断流与重启。** B 中断时，A 的正式回复仍在，C 仍未派发，B 进入待核查。接纳取消时会在同一事务中保存当前成员已经公开的临时正文前缀，最多 64 KiB。ToolBox 强停后，两端重开可凭原成员请求 ID 核对该前缀，界面标明其后可能存在缺口。成功提交正式回复后释放临时副本。[断流回执](primary/cut.json) · [强停回执](primary/crash.json) · [重开截图](primary/crash-owner-after.png)
- **派发边界。** 成员正在准备但尚未认领时可以随队列取消；最后一位已认领时返回没有剩余接力。已发起的原生子任务依照自己的回执收尾。宿主回归还覆盖第一位发言前取消，以及 Journal 已提交而步骤回执未写完时重开。
- **兼容。** 新能力 `group-cancel-remaining-v1` 对应 `POST /mobile/api/executions/:id/cancel-remaining`。旧版整轮中止接口保留。新版 PWA 连旧服务端显示「中止本轮群聊」，并使用原接口。Linux 原生 Electron 的队列控制和普通本机单聊均已实测。[新 PWA 搭配旧服务端](compat/legacy-host-current-pwa.json) · [原生桌面与本机单聊](compat/README.md)

[宿主完整差异](host.patch) · [前后对照及复跑命令](primary/README.md)。验证使用隔离的 Linux Electron、Chromium 移动视口、真实 ToolBox 与回环合成 Provider。本批原生宿主测试 207/207，协作测试 53/53。
