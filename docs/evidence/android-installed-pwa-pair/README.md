# Android 已安装 PWA 首次配对与冷开

Android 16 原手机的临时 Android 用户 10 使用独立浏览器数据和测试 CA。该用户的 Chrome 157 两次安装 WebAPK 超时，本次通过 Firefox 160.0.1 的「添加应用到主屏幕」安装。Android 登记的启动动作是 Firefox 的 PWA_LAUNCHER。改前、改后从同一个已安装入口启动同源应用，页面在非隐私窗口运行，display-mode 为 standalone，Service Worker 已接管。日用用户的 Chrome 未参与。[桌面安装记录](firefox-pwa-pinned.txt) · [安装后未配对截图](firefox-installed-unpaired.png) · [Chrome 安装回执](chrome-webapk-install.json)

两次实测各使用空的隔离数据库、一枚新配对码。测试在已安装页面内提交真实配对表单，在该页首次显示「已连接」时立即强停临时用户的 Firefox，并确认原进程退出。耗时从主机观察到文字开始，至强停结束。随后从相同的桌面启动入口冷开，核对新进程、页面显示、会话接口与中央数据库。

| 样本 | 强停耗时 | 冷开页面与接口 | 冷开后已用配对码 / 会话 |
| --- | ---: | --- | --- |
| 改前 | 121 ms | 服务可达，401；稍后复查仍为 401 | 1 / 1 |
| 改后 | 82 ms | 已连接，200；原 sessionMarker | 1 / 1 |

改前使用上轮固定 PWA 的 `index-CEYqWIUX.js`，中央仍有原会话，已安装应用却无法读回。改后实际加载 `index-iPv5fQP8.js`。冷开的第一次会话查询也返回 401，应用随后自动完成设备签名校验，再次查询获得 200。冷开前中央唯一会话标识与冷开后页面返回值均为 `0033c1eb7f0a3c67dbc2f1700e9ee85f038bc1a1a8bad6ace19d3fa2184293c9`。本轮没有发消息，两个样本的 Work 和 Provider 调用均为零。[改前强停](before/firefox-first-pair-force-stop.json) · [改前冷开](before/firefox-installed-cold.json) · [改后强停](after/candidate-first-pair-force-stop.json) · [改后冷开](after/candidate-installed-cold.json) · [冷开 HTTP 顺序](after/routes.ndjson) · [强停后中央记录](after/central-at-stop.json) · [冷开后中央记录](after/central-after-cold.json)

## 修复范围

新配对在发送配对表单前，用 IndexedDB 的严格持久化事务保存浏览器生成的不可导出私钥。服务端在消费原配对码的事务中，将公钥绑定到该会话。冷开先走原 Cookie 路径；缺少有效会话时，用设备私钥签署绑定源地址的一次性挑战。服务端校验并原子消费挑战，为原行轮换 HttpOnly Cookie，保留 ID、权限、话题和到期时间。已有有效 Cookie 继续按原方式使用；未登记设备公钥的旧配对无法补办丢失的 Cookie。[产品差异](product.patch)

服务端回归覆盖有效期、撤销、重新认证、跨源及重放。浏览器回归使用真实 IndexedDB 和 WebCrypto 检查持久化、恢复、失败的身份切换及清除。原有移动提交恢复测试 12 项通过。[服务端](tests/server-pair-recovery.tap) · [Firefox](tests/browser-firefox.tap) · [Chromium](tests/browser-chromium.tap) · [原有恢复测试](tests/existing-recovery.tap)

[改前冷开截图](before/firefox-installed-cold.png) · [改后冷开截图](after/candidate-installed-cold.png)

手机已切回原用户。临时用户及其 Firefox、PWA、测试 CA 已移除，本轮 USB 转发和测试服务均已关闭。[清理回执](cleanup.json)
