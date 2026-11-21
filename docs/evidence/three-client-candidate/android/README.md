# Android 16 实体验收

集成提交 `7829b83ccb634c397caa6a168d9fe0d8663cb12e`。设备运行 Android 16（API 36）及系统 WebView `157.0.8103.50`。使用临时测试 APK、USB 回环 HTTPS、当次公有 CA 及合成账号。加载的手机包为 `index-CEYqWIUX.js`，SHA-256 为 `5d53b27dca6f3e1864a5e03776ee5adbff976ac8488254acd4a962823ba252ed`。

## 同一共享 Work

Android 以只读会话加入 Linux 和 Windows 观察的共享话题 `shared_66704ea21249484487b9b697f9eca89c`，先看到空历史。Linux 发出请求后，实体机显示同一个运行中 Work `request_36f6c924891e4df7a383a27762534321` 和原用户消息。放行后 Android 显示该 Work 已完成，用户和助手消息各一条，两个消息 ID 与中央 Journal 顺序一致。中央只记录一个 Work、一次尝试和一次合成 Provider 请求。

[发送前](shared-before.json) · [执行中](shared-held.json) · [完成](shared-completed.json) · [中央终态](shared-completed-server.json)

## 首次配对后立即强停

独立发送夹具使用全新 WebView Profile。首次出现「已连接」后 108 毫秒内完成强停，确认临时进程退出。中央一次性配对已经消耗，尚无任何 Work 或 Provider 调用；冷开及稍后复查均显示待配对。公共话题只读会话也在刚配对不久的快速冷开后回到待配对。此结果限于 Android 测试 WebView 的快速强停窗口；本轮未测量日用浏览器的持久化时间，也未定位会话丢失的内部原因。

[强停时间](first-pair-stop.json) · [冷开](first-pair-reopened.json) · [中央状态](first-pair-server.json) · [公共会话快速冷开](shared-rapid-reopen.json)
