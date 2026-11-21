# Android 首次配对立即强停

上轮首次观察到「已连接」后 108 毫秒内完成强停，服务端已消费配对码，冷开却回到配对页。本轮在原手机上，用同一份 PWA、独立测试 Profile 和一次性配对重做对照。[上轮回执](../three-client-candidate/android/first-pair-stop.json)

## 各步的完成条件

1. ToolBox 的 `MobilePortal.pair` 在同一 SQLite 事务中消费一次性配对码并创建会话。提交后，响应通过带有 `Max-Age`、`Secure`、`HttpOnly` 的 Cookie 把会话交给 WebView。[服务端代码](../../../apps/server/Plugin/NativeSync/mobile/portal.js)
2. PWA 等候配对响应，再发起 `GET /mobile/api/session`。服务端接受请求中的 Cookie，页面才设定 `paired` 和 `online`，显示「已连接」。这次查询可以使用 WebView 内存中刚收到的 Cookie。[页面代码](../../../apps/mobile/src/App.vue)
3. 旧测试壳将这个查询直接放行，未观测到其内部自动写盘的具体时刻。修后的隔离壳在 WebView 请求线程调用 `CookieManager.flush()`，等它返回后才放行会话查询。这样，显示「已连接」时，Cookie 已越过 WebView 提供的持久化边界。日志只记录调用完成，不取 Cookie 值。[测试壳](../../../tests/hardware/android-send/TestWindow.java) · [Android API](https://developer.android.com/reference/android/webkit/CookieManager#flush())

## 实机对照

在 Android 16（API 36）、系统 WebView `157.0.8103.50` 上运行。三组都加载 `index-CEYqWIUX.js`，SHA-256 为 `5d53b27dca6f3e1864a5e03776ee5adbff976ac8488254acd4a962823ba252ed`。每组使用全新测试 WebView Profile、独立合成数据库和一枚一次性配对码。看到首次「已连接」后立即执行 `am force-stop`，确认原进程退出，再从同一 Profile 冷开。

| 组别 | 首次已连接至强停完成 | 冷开显示 | 冷开会话查询 |
| --- | ---: | --- | --- |
| 原测试壳 | 83 ms | 服务可达，仍需配对 | HTTP 401 |
| 修后样本 1 | 75 ms | 已连接 | HTTP 200，原会话 |
| 修后样本 2 | 48 ms | 已连接 | HTTP 200，原会话 |

修后两次都采到了原 WebView 进程在强停前写出的 `session_probe_cookie_flush_completed`。强停后、冷开前查询中央 SQLite，两组均只有一条会话和一枚已消费配对码。冷开后，从 WebView 调用带 PWA 能力头的会话接口，返回的 `sessionMarker` 逐组与中央已存在的会话一致，中央计数前后不变。各组均为零 Work 和零合成 Provider 请求。

[筛选后的读回与日志](result.json) · [原测试壳冷开](baseline-cold.png) · [修后样本 1 冷开](candidate-1-cold.png) · [修后样本 2 冷开](candidate-2-cold.png) · [清理回执](cleanup.json)

这些结果覆盖临时 Android 验收壳的强停窗口。普通浏览器和安装式 PWA 有各自的 Cookie 持久化时序，本轮未实测。
