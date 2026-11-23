# 原 R16 Windows 11 虚拟机

Windows B 在原 R16 测试虚拟机以普通合成账户 `R16Limited` 登录。来宾是 Windows 11 x64 build 22631。QEMU 实际启用了 KVM，原 QCOW2 基盘及输入 ISO 为只读，本轮使用独立写盘以及 UEFI、TPM 副本。网络只转发本轮主机回环 HTTPS。首次以 UTC 启动来宾时，Windows 按本地时钟解释 RTC，TLS 预检拒绝。隔离虚拟机改用 `base=localtime,clock=host` 后，依靠本轮合成 CA 校验同一 HTTPS 服务。Windows 系统证书存储未变更。

固定源码 `a2a13b53555c55ca79844544d8802d61fc0cf3e0` 由 `git archive` 导出。依赖按 Windows x64 锁文件安装，生成桌面 preload。CDS 由同一固定树使用 Rust 1.96.1 与独立 MinGW 交叉编译，随匹配的 authority sidecar 启动。Windows 实际运行 Electron 44.9.3 x64、CDS，以及候选桌面的接力相关模块。两次 Electron 的三个已加载主进程文件及 Chromium 实际解析的面板模块均核对源码 SHA-256。构建环境、二进制摘要和设备状态见 [构建与虚拟机回执](build-and-vm.json)。

## 同一群聊 Work 在线可见并可重开

中央从旧库备份升级后，Windows 原进程 PID 9568 仍在同一 Relay group 查看空话题。Linux A 提交后，Windows B 看到原输入、A 正式回复与第 2 位待接管状态。Windows B 使用真实鼠标输入点击「接管到本端」和「本端继续执行」，两次操作返回成功，同一 Work `request_3f478177daa64fd1b83567bab7787f4a` 的 executorVersion 变为 1。B 正式回复保存后，窗口显示第 3 位待接棒。 [空话题](01-group-online-empty.png) · [A 已回复](02-group-after-A.png) · [B 接管](03-group-B-takeover.png) · [B 已回复](04-group-B-reply.png)

B 保持同一窗口和话题在线。A 接回时，B 自然看到同一 Work 的 executorVersion 2，先显示第 3 位处理中，再于 05:00:10.873 UTC 显示 `RELAY_C_FINAL` 和同一 Work 的 `completed`。从 B 点击继续到 C 出现，B 无刷新、核对、换题或重启操作。原窗口的物理 History 含用户输入和 A、B、C 三条正式回复。 [等待 C](05-group-waiting-C.png) · [C 在线到达](06-group-C-live.png) · [完成 3/3](07-group-C-online-terminal.png) · [在线物理 History](history-live.json)

PID 9568 从托盘执行退出，退出码为 0。同一 Profile 启动后的 PID 4244 自动回到原群，仍显示同一已完成 Work 和相同四条消息。两次读取的物理 History SHA-256 都为 `ec4d44cb1120883f58b6fdd8a27c67a2a9dc96b00b9e667db586c4e3f2cc5880`。 [重开后的真实窗口](08-group-C-reopened.png) · [重开物理 History](history-reopened.json)

## 502 结清、删除和下一条新回复

重开后的同一 Windows 进程保持 `Synthetic shared / One history` 在线。原请求收到一次 Provider HTTP 502 后，B 自动看到原用户消息 `msg_1795410148688_user_rpgk5zbiun` 和「共享后端 · 结果需要核对」。物理 History 只有该用户消息。A 结清原 Work 时，B 的核对提示消失，原用户消息保留。A 随后删除原输入，B 的当前窗口和物理 History 一起变为空。 [待核对](10-single-original-visible.png) · [结清后仍有原输入](11-single-settled-input-retained.png) · [删除后窗口](12-single-deleted.png) · [待核对 History](history-review.json) · [空 History](history-deleted.json)

同一进程随后自动显示新输入 `SYNTHETIC_502_NEXT_INPUT` 和正式回复 `SYNTHETIC_502_NEXT_FINAL`。B 的 DOM、物理 History 与中央 Journal seq10、11 的 ID 和正文一致。 [新回复窗口](13-single-new-reply.png) · [新回复 History](history-single.json) · [Windows 事件](windows-events.jsonl) · [逐项机器核验](verified.json)

Windows 两次 Electron 均正常退出，最后一次退出码为 0。来宾经 ACPI 正常关机。原基盘和之前的差分盘保留，本轮合成差分盘和隔离运行资产保留在 `.runs/r4-win/` 供回查。
