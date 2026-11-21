# Chrome WebAPK 暂存点（2026-11-22）

原 Android 16 的临时用户 NS（11）使用 Chrome 打开隔离 HTTPS PWA，在原网络两次安装均返回 WebApk.Install.InstallResult 桶 6（生成服务请求超时）。没有生成可供本轮冷开的 WebAPK。独立 GET 探针有 DNS 完成与建连事件，未观测到 TLS 和 HTTP 响应；日志没有捕获生成令牌的 POST，无法据此进一步指定该 POST 的失败层。[脱敏探针](transport-probe.json)

Gnirehtet 2.5.1 已安装在临时用户，系统拒绝从 ADB 启动它，VPN 对照尚未完成。暂停时中央配对码、会话、Work、Provider 调用均为零。[中央回执](central-at-pause.json)

已切回机主用户、移除本轮 ADB 转发并停止后端与 USB 中继。保留临时用户及其测试配置供续测。恢复时使用新的隔离后端和有效测试证书，先确认临时用户能连到正式生成服务，再从注册的 WebAPK 桌面入口做首次配对、强停和原 sessionMarker 核对。
