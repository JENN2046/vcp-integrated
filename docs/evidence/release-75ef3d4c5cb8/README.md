# 75ef3d4c5cb8 三端共享单聊收口

固定 Git 提交 `75ef3d4c5cb8a880772342209841a40104127ba3`，源码树 `fc9ca39fb3dc087d8a2a3758286a50c8373cb2a6`。Linux 从空话题点击发送一次。原 Windows 11 R16 虚拟机和原 Android 16 手机隔离用户 12 中的已安装 Firefox PWA 观察同一话题。三端分别退出进程并重开，中央服务在此期间持续运行。所有模型响应来自回环合成 Provider。

| 核对项 | 结果 |
|---|---|
| 共享话题 | `shared_b2fc37dab9684d0daa26fc28360dc1e3` |
| Work | `request_f409661e94b945c4b9a834047a56fac0`，重开后均为 completed |
| Journal 1，用户 | `msg_1795365334745_user_ync7f96m43`，正文为 `Send-recovery compare 02: accept exactly once.`，46 个 UTF-8 字节 |
| Journal 2，助手 | `reply_request_f409661e94b945c4b9a834047a56fac0`，正文为「合成回复完成。」，21 个 UTF-8 字节 |
| 执行次数 | 1 个 Work，1 次尝试，1 次派发，Provider 总计 1 个请求。完成时与三端重开后的中央快照一致 |

在本目录使用 `node compare.cjs` 即可从中央与三端原始回执重算结果。Linux 通过原生状态接口读回该 Profile 上次确认的 Work，另从消息 DOM 与物理 History 核对消息。其 Markdown DOM 每条多一个结尾换行，验证脚本用原文加一个 LF 重算原始哈希。Windows 由 B 身份查询中央 Work，在本机 DOM 与 History 核对内容。手机由独立 PWA 的 Work 卡片及消息行核对；冷启动后仍是同一只读会话。[逐项比对](three-client-comparison.json) · [Journal 正文摘要](central/post-all-reopens-message-hashes.json) · [完成态](central/work-completed.json) · [重开后](central/post-all-reopens.json)

Linux 分别安装三套锁定依赖并从源码构建 CDS、Vexus、preload 与 PWA。Windows 从同一固定树准备 x64 依赖、交叉编译并在原虚拟机的临时差分盘上运行。8 个 PWA 文件的实际 HTTPS 响应和本轮产物逐一匹配。Linux 运行时复用隔离空知识库 watcher 夹具。[32 项构建哈希](build/build-sha256.txt) · [Linux 源码与工具链](build/source.txt) · [Linux 重开时加载的原生组件](build/linux-reopened-native.json) · [Windows 构建与虚拟机](windows/build-and-vm.json) · [PWA 线上回环资产](build/served-pwa-sha256.txt)

三端重开截图和现场回执：[Linux 截图](linux/reopened.png) · [Linux 回执](linux/reopened-readback.json) · [Windows 截图](windows/reopened.png) · [Windows 回执](windows/reopened.json) · [手机截图](android/04-cold.png) · [手机回执](android/04-cold.json)

Android 已切回机主，保留用户 12 及原 Firefox PWA，USB 转发已回收。本轮测试 CA 仅导入该隔离用户，有效至台北时间 2026-11-24 00:31:07。Chrome WebAPK 继续暂存。[手机清理回执](android/cleanup.json)

Windows 原虚拟机已正常关机，差分盘与合成 Profile 已回收。来宾首次证据盘没有分配盘符，重开回执与截图经第二块临时盘原样导出。Linux 两次 Electron 均正常退出；测试后端、回环端口、隔离显示及运行期数据已回收。固定构建检出保留供复核。[Windows 收尾](windows/README.md) · [中央收尾](central/cleanup.txt)
