# PWA 共享单聊未派发恢复回执

使用 Node 24.22.1 在隔离的 loopback 运行 VCP integrated 当前工作树的 MobilePortal、共享准入和 ToolBox 请求边界。测试从 PWA HTTP 配对与发消息进入，子进程在指定位置收到 SIGKILL。两次独立进程重启均挂载原合成 SQLite，并以原浏览器会话和请求 ID 重放同一 HTTP 提交。Provider 为 loopback 合成响应。

| 强停位置或边界 | 首次重启 | 首次重启结束 | 再次重启 | 原进程／首次／再次的 Provider 调用 |
|---|---|---|---|---|
| Work 已开始，尚未登记 native request | queued | completed | completed | 0／1／0 |
| native request 已 prepared，派发意图仍为 0 | queued | completed | completed | 0／1／0 |
| 派发意图已持久化，尚未进入 ToolBox | review_required | review_required | review_required | 0／0／0 |
| ToolBox 已进入 Provider 边界，无终稿 | review_required | review_required | review_required | 1／0／0 |
| PWA HTTP 取消成功 | cancelled | cancelled | cancelled | 0／0／0 |
| 合成准入主体错绑 | review_required | review_required | review_required | 0／0／0 |
| 合成原用户消息身份错绑 | review_required | review_required | review_required | 0／0／0 |
| 普通非共享话题，Work 已开始 | review_required | review_required | review_required | 0／0／0 |

每个场景两次重放均获得 HTTP 202、原 Work ID 和 `replayed: true`。两个恢复场景各保留原用户 Journal 行，并追加唯一一条属于原 Work 的 assistant 消息。其余场景的 Journal 始终只有原用户行。取消记录在两次启动间保持终态。

从仓库根目录执行 `node tests/shared-single-review/mobile-undispatched.cjs`，脚本打印每次启动和重放后的账本投影，结束后回收隔离运行目录。

[逐次强停、原请求重放和 Journal 回执](recovery.json) · [恢复逻辑差异](host.patch) · [复审中的改前对照](../shared-single-review/ordinary.json)
