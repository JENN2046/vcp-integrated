# Windows 原虚拟机验证

固定源码为 `9890ce016598b0814d7ee09fce07766a45356352`。原 R16 Windows 11 x64 测试虚拟机经 KVM 启动，Windows 以 `R16Limited` 普通合成测试账户运行。QEMU 查询确认原 QCOW2 基盘和输入介质以只读方式打开，来宾写入独立 QCOW2 差分盘，UEFI 和 TPM 使用该批次的临时状态。网络仅桥接本批次主机回环 HTTPS，使用本次合成 CA 做进程级证书验证。

桌面源码由固定 Git 树导出。依赖按候选 `apps/desktop/package-lock.json` 以 `npm ci --ignore-scripts --os=win32 --cpu=x64 --prefer-offline` 安装，使用 npm 的公共缓存。主要窗口使用与锁文件同版本的发行包 Electron 44.9.3 x64，按发行清单验证压缩包摘要。Windows 启动驱动复用已验证的公共 Node 24.15.0 x64。由候选源码运行桌面 `build:preloads` 生成共享渲染规则、Agent 保存模块和沙盒 preload。Windows CDS 从同一固定树以 Rust 1.96.1 和 MinGW 重新交叉构建，Cargo 使用锁文件与公共离线缓存，附带匹配的 native authority sidecar。凭据和用户配置均使用本次独立合成 Profile。

[Windows 构建和原虚拟机范围](build-and-vm.json)

## 首开与重开通过

Windows B 在独立合成 Profile 中打开共享话题 `shared_0842d8c75e70433ab4f24e9588e2189a`，显示 Linux A 提交的输入与回复。第一次正常退出后，以同一 Profile 启动新 Electron 进程并重开同一话题。进程 PID 分别为 2452 和 9628，退出码均为 0，两次退出后测试路径上的 Electron 与 CDS 进程均归零。

两个进程的窗口都显示且只显示原来的一对消息。消息 ID、角色、UTF-8 字节数及正文 SHA-256 与各自物理 History、Linux A 的 History 和中央 Journal 完全一致。Work 终态通过 Windows B 合成身份对 `/api/v1/sync/shared/work` 的只读 GET 核对，两次均返回 `request_f7b2304e20c34928ada744ca1637ab19`、`completed`。渲染器状态接口同时确认所处话题和连接在线。Windows 记录到的发送 IPC 数为 0，三端重开后中央仍为一份 Work、一次派发、一次 Provider 调用，Journal 序号仍为 1、2。

实际进程路径上的 Electron 和 CDS、Electron require cache 中的 5 个主进程模块、Chromium 调试协议返回的 3 个已加载渲染模块源码，均经过摘要校验。来宾的 3 个 `@vcp/core-rules` 文件及 桌面相对加载的 History ESM 和包声明（共 4 个文件）也与固定 Git 树一致。沙盒 preload 由候选中主窗口明确设置的路径核对，来宾文件摘要等于本轮生成物，渲染器通过对应 preload API 报告已就绪。

初次夹具在看到终态后尝试从 Chromium 偏好接口取 preload 路径，因该字段缺失而提前退出。复验通过候选主窗口实际声明的路径取摘要，使用一个全新 B Profile 从头做首读和重开，沿用同一中央 Work。来宾随后正常关机，临时差分盘、证据盘、传输介质及该批次合成 Profile 已回收。

- [首开回执](first.json) · [首开截图](first.png)
- [重开回执](reopened.json) · [重开截图](reopened.png)
- [同 Profile 与便携载荷校验](closeout.json) · [与中央及 Linux History 比对](central-comparison.json)
- [初次取证夹具失败](initial-fixture-error.json) · [三端重开后中央快照](../central/post-all-reopens.json)
