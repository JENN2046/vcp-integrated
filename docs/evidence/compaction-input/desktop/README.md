# 共享桌面手动压缩与重开

**PASS** · 基于 `96b1114d47e2b651aaa2c77d46f0aac36304260e` 的修复候选 · Linux x64 · Electron 44.9.3 · Node 24.22.1

运行真实 VCPChat 桌面与 VCPToolBox，使用隔离资料目录、共享数据库和 loopback 合成 Provider。通过桌面消息右键菜单点击「压缩前文」。先通过真实共享执行入口完成两次可控轮次，检查两份原生续跑证明及存档助手正文，再通过共享消息接口分别编辑和删除。压缩请求使用原生流式完成链路。摘要文字为确定性的合成响应，只验证请求内容、提交和重开后读取。

- 压缩前，桌面 History 有 5 条有效消息。原始 Journal 有 8 条，包括编辑前记录、编辑操作及删除墓碑。Provider 实际接收 5 条来源消息，按原始顺序保留两个不同 ID 的同文消息、编辑后正文及两次发送的用户输入。已编辑和已删除回复的两份原生存档正文均未进入摘要请求。
- `compact-prepare` 和 `compact-commit` IPC 均成功。服务端仅提交 1 个 checkpoint，Journal 序号为 9。两份原生续跑证明与同一个 checkpoint ID 及 Journal 序号绑定。回执记录完整 ID、序号及条目哈希。压缩后原 History 的 5 条消息和 Journal 的 8 条记录逐字段保持相同。
- 桌面正常退出并用同一资料目录重开。checkpoint 卡片仍可见，物理 History 与关闭前相同。
- 重开后从桌面点击发送两次。首次请求在 checkpoint 后传入本轮用户输入，第二次请求在 checkpoint 后传入首次用户输入、首次回复、本轮用户输入。原生上下文选择器、真实模型 Handler 与 Provider 捕获相互对应。两个 Work 均收到独立的 admission receipt，各 dispatch 1 次且完成。历史中一直只有 1 个 checkpoint。最终 History 和 Journal 对应同一组新增消息 ID。

同目录上层的对照证据分别记录修复前后的输入和其他核验路径。

## 复跑

在 `vcp-integrated` 根目录，以 Node 24 执行 `node tests/integration/run.cjs compact-e2e`。使用仓库已有的桌面依赖、CDS、服务器原生插件和 mobile 构建，并提供 Xvfb 与可启动的 Chromium 沙箱。可用 `TMPDIR`、`XVFB_BIN`、`ELECTRON_BIN` 指定本地隔离运行位置。本次使用工作区的临时运行目录、从发行版软件包解包的 Xvfb，以及使用本机已安装 Chromium 沙箱辅助程序的隔离 Electron 副本。

[运行证据](receipt.json) · [手动菜单](manual-menu.png) · [提交后](checkpoint-committed.png) · [重开后](checkpoint-reopened.png) · [真实发送完成](next-send-complete.png)
