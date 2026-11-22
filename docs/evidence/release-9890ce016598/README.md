# 固定候选三端共享单聊收口

候选 `9890ce016598b0814d7ee09fce07766a45356352`，Git tree `49585a495379447f927269922bc84e4a44d748e4`。Linux A 从空话题点击发送一次。原 Windows 11 虚拟机和原 Android 16 手机上的 Firefox PWA 使用各自的隔离资料观察同一个话题。三个客户端均在新进程重开，中央服务在此期间持续运行。

| 核对内容 | 结果 |
|---|---|
| 唯一 Work | `request_f7b2304e20c34928ada744ca1637ab19`，三端均读回 completed |
| 唯一输入 | Journal 1，`msg_1795328083067_user_o0iyw2caho`，正文 46 个 UTF-8 字节 |
| 唯一正式回复 | Journal 2，`reply_request_f7b2304e20c34928ada744ca1637ab19`，正文「合成回复完成。」共 21 个 UTF-8 字节 |
| 执行次数 | 一个 Work、一次尝试、一次派发、一次回环合成 Provider 请求。完成时与三端重开后的中央快照一致 |
| 正文 | Windows 窗口及物理 History、Android 独立 PWA 的消息正文、Linux 物理 History 与中央 Journal 的 SHA-256 逐项一致。Linux Markdown 容器的原始文本每条多一个换行，复核脚本另按正文加一个 LF 验证原始哈希 |

Linux 使用该 Profile 保存的原生 Work 状态，标为 last-known；Windows 用观察端 B 的身份按原 Work ID 做已授权只读查询；Android 从独立窗口的 Work 卡片及消息 DOM 读回，冷开保留同一设备会话。可运行 `node compare.cjs` 从各端原回执重新核对。[三端比对](three-client-comparison.json) · [中央最终快照](central/post-all-reopens.json)

## 构建及取证范围

Linux 从干净检出按锁文件安装并编译，构建后 Git 跟踪文件无差异。Windows 从同一固定 Git 树准备锁定的 x64 依赖、生成 preload、交叉编译 CDS；在原 R16 虚拟机只读基盘的独立差分层中运行。公共依赖下载缓存复用。出于宿主 inotify 配额限制，Linux 合成后端复用空知识库 watcher 夹具。[Linux 构建与哈希](build/README.md) · [PWA HTTPS 资产哈希](build/served-pwa-sha256.txt) · [Windows 构建与运行哈希](windows/build-and-vm.json)

上轮手机临时用户 10 和 PWA 已删除。本轮经 Jenn 确认，在同一台手机的新隔离用户 12 重新安装 Firefox 160.0.1 和真实桌面 PWA。正式资源 `index-COF_fHbg.js` 已从本轮 HTTPS 后端加载。手机强停前后进程 PID 从 24269 变为 26120，冷开为 standalone、非隐私模式，Service Worker 已接管。已按 Jenn 选择保留用户 12 和 PWA，切回机主并撤销 USB 转发。暂存的 Chrome WebAPK 用户 11 未参与。[手机冷开回执](android/04-cold.json)

Linux 和 Windows 的首轮补充取证各有一项可选字段假设错误，已分别改用本机消息行及候选主窗口声明的 preload 路径核对。整个复验沿用同一 Work。原虚拟机已关机，临时差分盘已回收，测试后端已停止；Linux 干净构建树保留。[Linux 说明](linux/README.md) · [Windows 说明](windows/README.md) · [中央清理回执](central/cleanup.txt)

三端重开截图：[Linux](linux/reopened.png) · [Windows](windows/reopened.png) · [Android Firefox PWA](android/04-cold.png)
