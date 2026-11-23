# a2a13b53555c 带存量库的三端版本收口

固定候选 `a2a13b53555c55ca79844544d8802d61fc0cf3e0`，Git tree `74d0c6dd8fd55b216e9c7f2bf359ca953099a565`。Linux 采用干净 detached 检出按锁文件安装及编译；Windows 从相同树导出，编译 Windows CDS、生成 preload 并在原 R16 虚拟机中启动。原 Android 16 的隔离用户 12 打开已安装 Firefox PWA，以本次合成只读身份观察同一服务。现场模型仅为本地回环合成 Provider。

| 项目 | 实际结果 |
| --- | --- |
| 存量 v1 Work | 旧宿主停在甲已确认、乙尚未派发的位置，SQLite 一致性备份保留 Journal 1、2。新版冷开副本核对原 Work、执行者、两条消息与回执，接管后只追加乙的正式回复（序号 3）。三端中央从这一份续完旧 Work 的库启动；现场结束时旧 Work 和三条记录一致。 |
| schema 4 顺序接力 | Linux 发起 → Windows 接管并继续 → Linux 接回。第二次继续已写入中央，成功回执在传输中被截断。Linux 强停重开后重试相同操作 ID，丙只执行一次，模型按顺序读到甲、乙各一份正式回复。同一 Work 在 Journal 4–7 完成。 |
| 三端观察 | Windows 原窗口在同一话题在线收到丙，随后重开同一 Profile 验证。手机版群聊界面显示四条正式消息；桌面发起的群 Work 没有单列执行卡，Work ID 和完成状态另在同一只读会话的 SSE 回执确认。手机强停冷开后四条消息 ID、角色、正文仍一致。 |
| 共享单聊 502、结清和删除 | 第一次请求返回 502，只有原输入（序号 8），Work 待核对。Linux 原生界面确认放弃，原生 unknown 保留；右键删除追加同一 ID 的墓碑（序号 9）。三端均观察到删除。后续新 Work 完成一次，三端最终都只有新输入与回复（序号 10、11）。 |
| 真正从备份恢复 | 旧宿主明确拒绝 schema 4 最终冷库副本。将 schema 3 备份恢复到独立目录，用同一旧宿主启动，读回原 Work 的第一个边界，再继续乙并结算。此回退恢复点只包含当时已经发生的工作。 |

[三端逐项对账](three-client-comparison.json) · [旧 Work 升级、备份与恢复方法](upgrade/README.md) · [旧宿主打开最终库及恢复回执](upgrade/rollback-final.json) · [中央执行与上下文核对](central/verified.json)

Linux 构建清单共 32 项，SHA-256 为 `192d91c81238d7eb95182df4149e40d5c0bbc2766e03ee25a8373276a171b7d3`。8 项 PWA HTTPS 响应均与构建字节相同。[构建清单](build/build-sha256.txt) · [Linux 工具链与固定树](build/source.json) · [Windows 构建和虚拟机范围](windows/build-and-vm.json) · [实际服务的 PWA 哈希](build/served-pwa-sha256.txt)

现场的 `NETWORK_UNAVAILABLE` 出现在暂停中央切换带库副本时。恢复原地址和绑定后，Linux 用同一 Profile 重开后取回原话题，手机保留原配对自动重连。Linux 首次 502 结清点击没有发出 HTTP，确认原复选框已选中后，只有一次成功结清。Windows 来宾最初受到 RTC 偏差影响，按原虚拟机使用的本地时钟启动后通过了严格 TLS 校验。手机单聊额外 SSE 查询一次返回 429；单聊状态与正文由实际 PWA 卡片、DOM 和中央交叉核对。[Linux 及中央记录](central/README.md) · [Windows 记录](windows/README.md) · [手机记录](android/README.md)

**截图**　[Linux 丢回执后重开](linux/linux-group-ack-reopened.png) · [Windows 在线收到丙](windows/07-group-C-online-terminal.png) · [手机群聊冷开](android/09-group-cold.png) · [手机删除后正常续发并冷开](android/16-single-cold.png)

在仓库根目录可运行 `python3 tests/release-a2a13b53555c/verify-release.py docs/evidence/release-a2a13b53555c` 重算三端和回退比对。原虚拟机已正常关机，测试后端已停止，手机切回机主，保留隔离用户、Firefox PWA 和该用户的限期测试 CA。本批 Windows 差分盘、冷备份和固定构建检出保留供复查。[完整运行入口](../../../tests/release-a2a13b53555c/README.md)
