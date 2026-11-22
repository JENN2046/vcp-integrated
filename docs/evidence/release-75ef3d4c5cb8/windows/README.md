# Windows 原 R16 虚拟机验证

固定源码 `75ef3d4c5cb8a880772342209841a40104127ba3`。在原 R16 Windows 11 x64 虚拟机使用 KVM 和 `R16Limited` 普通测试账户运行。原基盘以只读方式打开，来宾写入本轮差分盘，UEFI 和 TPM 使用临时副本。来宾网络只转发本轮主机回环 HTTPS，证书信任仅作用于测试进程。

桌面用 `git archive` 导出固定树，按 Windows x64 锁文件安装依赖并生成 preloads。Electron 为经发行摘要验证的 44.9.3 x64，Windows CDS 用 Rust 1.96.1 和 MinGW 从同一固定树重新交叉构建，保留匹配的 authority sidecar。两次实际执行的 Electron、CDS 和生成的聊天 preload 均与准备的构建摘要匹配。5 个已加载主进程模块和 4 个已加载渲染模块均匹配固定 Git 树，其中包括 `topicRiverQuote.mjs`。本轮同一 Work 使用纯文本。

Windows B 在 Linux A 提交之前打开共享话题 `shared_b2fc37dab9684d0daa26fc28360dc1e3`，随后显示提交和回复。首次正常退出后，同一隔离 Profile 以新 Electron 进程重开同一话题。两次均以已授权的 Windows B 身份通过只读 GET 得到 Work `request_f409661e94b945c4b9a834047a56fac0` 的 `completed` 终态。可见 DOM 的两条消息与 Windows 物理 History 相符，Windows History、Linux History 和中央 Journal 的消息 ID、角色、UTF-8 字节数及正文 SHA-256 均一致。观察到的发送 IPC 为 0。中央仍为一份 Work、一次派发、一次合成 Provider 调用及 Journal 序号 1、2。

两次 Electron PID 分别为 3632 和 7140，退出码均为 0，测试路径上的 Electron 与 CDS 在每次退出后归零。两次分别捕获的窗口截图具有相同 SHA-256。来宾未给最初的无分区证据盘分配盘符，已通过独立 MBR/FAT32 USB 结果盘导出证据。来宾正常关机，本轮差分盘、测试 Profile 和介质已回收。

- [构建与虚拟机范围](build-and-vm.json)
- [首开回执](first.json) · [首开截图](first.png)
- [重开回执](reopened.json) · [重开截图](reopened.png)
- [同 Profile 核对](closeout.json) · [中央和 Linux 对照](central-comparison.json)
