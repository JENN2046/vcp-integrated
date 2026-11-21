# 长回复流式联验与 Windows 阅读位置对照

在同一版 VCPChat 和 ToolBox 上，Linux A 通过原生发送按钮提交长回复请求。两场正式实测都用 32 条合成旧历史起步，每场一条 Work、一次 Provider 调用、21 个非空 SSE delta。每段 7 帧，首段累计 658 字符，中段 1,316，终段 1,974。中央 Journal 在每一场各增加序号 33 的输入和序号 34 的回复。

## 三端实测

Windows B 和实体 Android 在 A 发送前均已打开同一话题。Android 在可见的只读页面看到首段 7 帧的正文。设备实际进入 Dozing 后，移除该应用的 USB 回环桥并强制停止测试进程，服务端继续生成中段和终稿。重新接桥、打开原 Profile 并解锁后，手机恢复了同一 Work，对本机页面 34 条消息的 ID 和正文逐条核对，与中央 Journal 一致。最终回复的 UTF-8 大小为 5,670 字节，SHA-256 为 `cd28f31d692275ef1a5f3a56cea3e4ca1386e5a60a598d99d4f7a11ab00f2a02`。临时手机应用、测试转发和调试连接已移除。[三端回执](physical-run.json) · [手机首段](android-first.png) · [手机恢复后](android-reopened.png)

这一场 Windows 从第 28–31 条附近移动到第 25–29 条附近，Jenn 确认手动滚动过。该场 Windows 观测器启动时遇到 CDS 文件锁，未取得完整选区轨迹。无法据此将位移归因于终态刷新。[发送前](windows-before.png) · [终态](windows-completed.png)

## Windows 独立对照

补跑使用独立数据和 Work。Windows 使用同一原虚拟机上的普通测试账户。VNC viewer 临时切为只读，Electron 使用真实鼠标事件拖选旧消息。宿主在发送前从来宾取回两次一致的基线快照，核对选区偏移、文本哈希、草稿、CDS 和可滚动距离，此时 Work 和 Provider 调用均为 0。之后 Windows 只观察，Linux 提交一次。在来宾实际 transcript DOM 中依次观测到三个段尾标记，读取完成的 Windows History，核对输入和回复 ID、角色及正文 SHA-256。

| 核对项 | 结果 |
|---|---|
| 选区 | 第 30 条旧消息 `hardware-seed-30` 的 UTF-16 偏移始终为 `[1,12]`。512 份采样的文本哈希相同，原文本节点保持连接。 |
| 阅读位置 | 首个可见锚始终是第 27 条，其顶部相对视口为 −42.78125 CSS px。最大测得位移 **0 CSS px**。实际 scrollTop 为 3,427；最大可滚位置从 3,656 增加到 4,828。 |
| 草稿 | 48 字符的未发送草稿在全部采样中哈希一致。固定基线后未记录到滚轮或滚动快捷键。 |
| 终态与退出 | Provider 调用一次、工作尝试一次、History 共 34 条；回复 ID 和全文摘要与本场 Journal 相符。Windows Electron 正常退出，CDS 已退出。 |

首、中、终段标记均出现在真实 Windows DOM。读者停在旧消息处，窗口可见区域保留旧正文。观测总长约 131 秒，包含发送前及终态后的稳定窗口；512 个采样点中，511 个含分段标记观测，第一个为固定基线后的即时快照。[机器回执](windows-control.json) · [来宾原始观测轨迹](windows-trace.jsonl.gz) · [发送前](control-immediately-before.png) · [首段](control-first.png) · [中段](control-middle.png) · [终态](control-stable.png)

准备独立对照时还发生一次操作失误：停止观测器的测试命令意外进入另一份隔离 B 输入框并被接纳。它产生了单独的 `review_required` Work，原生请求有派发记录，无助手终稿。该次未通过预检，未重放；其 Provider 计数器只统计匹配的测试输入，不能据此推断全部调用为零。后续夹具在准入前拒绝观察端的发送，正式对照在全新数据上完成。[准备阶段异常回执](setup-incident.json)

本次没有复现受控条件下的自动跳动或选区丢失。改动仅涉及隔离测试与证据，保留既有产品渲染行为。原 Windows 虚拟机保持已登录，VNC viewer 已恢复可操作。新系统安装保持暂停。
