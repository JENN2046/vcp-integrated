# Android 16 实体验收

集成提交 `7829b83ccb634c397caa6a168d9fe0d8663cb12e`。设备运行 Android 16（API 36）及系统 WebView `157.0.8103.50`。使用临时测试 APK、USB 回环 HTTPS、当次公有 CA 及合成账号。加载的手机包为 `index-CEYqWIUX.js`，SHA-256 为 `5d53b27dca6f3e1864a5e03776ee5adbff976ac8488254acd4a962823ba252ed`。

## 同一共享 Work

Android 以只读会话加入 Linux 和 Windows 观察的共享话题 `shared_66704ea21249484487b9b697f9eca89c`，先看到空历史。Linux 发出请求后，实体机显示同一个运行中 Work `request_36f6c924891e4df7a383a27762534321` 和原用户消息。放行后 Android 显示该 Work 已完成，用户和助手消息各一条，两个消息 ID 与中央 Journal 顺序一致。中央只记录一个 Work、一次尝试和一次合成 Provider 请求。

[发送前](shared-before.json) · [执行中](shared-held.json) · [完成](shared-completed.json) · [中央终态](shared-completed-server.json)

## 首次配对后立即强停

独立发送夹具使用全新 WebView Profile。首次出现「已连接」后 108 毫秒内完成强停，确认临时进程退出。中央一次性配对已经消耗，尚无任何 Work 或 Provider 调用；冷开及稍后复查均显示待配对。公共话题只读会话也在刚配对不久的快速冷开后回到待配对。此结果限于 Android 测试 WebView 的快速强停窗口；本轮未测量日用浏览器的持久化时间，也未定位会话丢失的内部原因。

[强停时间](first-pair-stop.json) · [冷开](first-pair-reopened.json) · [中央状态](first-pair-server.json) · [公共会话快速冷开](shared-rapid-reopen.json)

## 系统选档、冷开改发与丢回执

Jenn 在 Android DocumentsUI 的合成目录点选 `fixture-note.txt`。PWA 收到系统选择结果。独立服务在交接期间退出，回环转发仍在。恢复前该话题没有 Work 或上传。按原地址和证书从本轮合成 SQLite 做一致备份并恢复服务，原手机会话、话题和已选文件继续可用，之后开始提交。

- 含桌面上下文标记的首次提交上传文件后返回 `409 DESKTOP_CONTEXT_REQUIRED`。原请求的精确查询为空，尚无 Work、Journal、附件关联、Provider 或工具调用。强停冷开保留原文和上传槽，可编辑且可发送。只移除桌面标记后提交一次，确认使用同一个上传 ID，整个用例只创建一个上传。回复完成且附件正文可预览，中央关联与合成文件的 SHA-256 相符。
- 第二次有效提交的真实 `202` 回执在隔离代理截断，代理暂缓此请求的精确查询。冷开后同一请求仍待核对，发送禁用。开放查询并点击「核对 / 同会话重试」，PWA 接受原 Work，显示「已核对云端接受记录，未重新发送」。核对前后 Work、Journal、关联、Provider 和工具计数完全相同。
- 两次有效提交各对应一个已完成 Work 和一次尝试。四条手机消息与中央 Journal 顺序逐项一致。隔离 Provider 共 4 次请求，合成计数工具共 2 次，各 Work 包含工具请求和结果后的回复。

[系统选档](system-file-picker.json) · [收到系统文件](system-file-selected.json) · [明确拒绝](rejected.json) · [冷开保留](draft-reopened.json) · [附件预览](attachment-preview.json) · [丢回执后冷开](lost-reopened.json) · [同请求核对完成](lost-confirmed.json) · [中央终态](final-server.json) · [对账摘要](receipt-assertions.json)

测试 APK 已卸载，两条 USB 回环桥和临时 CDP forward 均已撤销，独立服务已退出。临时 TLS 叶证书私钥已移除，其余合成运行目录移至系统废纸篓。[清理回执](cleanup.json)
