# 同一 Work 的实体端联验

此入口使用真实 ToolBox、真实 VCPChat 和只在回环监听的合成 Provider。用各端独立的测试 Profile 和一次性只读手机会话。设备在线、认证和手工观察需要现场确认。

## 启动

在 Linux x64 上安装仓库依赖，并构建手机页面及 Linux CDS。使用 Node 24，在两个终端执行：

```sh
node tests/hardware/coordinator.cjs
node tests/hardware/linux-desktop.cjs .runs/hardware/run-<id>
```

第一条命令报告 `ready.json`、`status.json` 和本次 CA 的路径。第二条命令在真实 Linux 显示上用新 Profile 打开合成话题。两者各自保留标准输入用于本次验收。

HTTPS 固定为 `https://127.0.0.1:18443`。实际 Android 可对这一端口使用授权的 `adb reverse`，Windows 可使用授权的同号回环转发。Windows 用同版源码及其原生 Electron，并用 `prepare-windows.cjs` 从本次 `seed/desktopB` 准备新 Profile。对 Windows 的 Chromium 和主进程也使用仅当前进程生效的叶证书指纹与 CA，例如给现有 Electron 夹具设 `NS_HOST`、`VCPCHAT_APP_DATA_DIR`、`VCPCHAT_E2E_TEST=1`、`NODE_EXTRA_CA_CERTS` 和 `NS_CERT_FINGERPRINT`。本次 Windows 会话只观察目标话题。将合成 seed、公有 CA 与叶证书通过获授权的临时通道送到 Windows 测试目录，然后从 Windows checkout 根目录执行：

若使用源码光盘和便携 Electron，先安装与 Windows 匹配的锁定依赖，并运行完整的桌面构建入口。`build:preloads` 同时生成浏览器直接加载的共享规则、Agent 保存模块和沙盒 preload。CDS 使用同一源码构建的 Windows x64 EXE 和匹配的 authority sidecar。

```powershell
npm --prefix apps/desktop run build:preloads
node tests/hardware/prepare-windows.cjs $seed $newProfile
$env:NS_HOST = (Resolve-Path 'apps/desktop').Path
$env:VCPCHAT_APP_DATA_DIR = $newProfile
$env:VCPCHAT_E2E_TEST = '1'
$env:NODE_EXTRA_CA_CERTS = $publicCaPem
$env:NS_CERT_FINGERPRINT = node -e "const fs=require('node:fs'); const {X509Certificate}=require('node:crypto'); console.log(new X509Certificate(fs.readFileSync(process.argv[1])).fingerprint256)" $publicLeafPem
& 'apps/desktop/node_modules/electron/dist/electron.exe' '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1' '--disable-background-networking' 'tests/integration/electron.cjs'
```

Windows 正式打开候选前，用与该进程相同的 CA 对回环 HTTPS 发一次请求，并检查来宾 UTC 是否在测试 CA 和叶证书的有效期内。宿主调整时区后，正在运行的来宾仍可能报告不同的 UTC。本次用单独的回环 TLS 前置覆盖两个测试时点；前置对原服务仍验证原 CA，Windows 只信该进程的测试 CA，无需系统导入。

变量 `$seed`、`$newProfile`、`$publicCaPem` 和 `$publicLeafPem` 使用 Windows 本机的绝对路径，在测试专用 PowerShell 中设置。打开 `Synthetic lost receipt` 的 `Sponsor target existing topic`。

临时 CA 只签发本次回环地址，公有 PEM 和 DER 供测试客户端作进程内或一次性环境的信任配置。CA 私钥签发后即移除，服务器启动后移除叶证书私钥文件。Android 可以用专用测试 WebView 的应用网络安全配置引入该 CA，保留既有浏览器、账号会话和系统 CA 设置。

在协调终端输入 `arm-pair` 后，手机有 90 秒访问 `https://127.0.0.1:18443/__hardware/pair`。每次启用只允许一次 GET，路由关闭后重新启用才可再次使用。它申请 `sharedAB` 只读一次性配对，并在同源 HTTPS 跳转中预填现有 PWA 表单。使用者须在手机页面明确确认。配对值在 PWA 中清除 URL fragment，并且不会写入命令输出或协调状态。

## 观察与收尾

1. 确认每端到场后，在 Linux 终端输入 `send` 一次。协调终端的 `status` 与磁盘 `status.json` 给出 Work、原消息 ID、Journal 和 Provider 调用数。
2. Linux 终端输入 `mark` 记录独立草稿、消息选区、滚动状态和本机持久 History。手机确认同一在途 Work 后，可按验收计划锁屏、移除本次回环桥或结束本次测试应用。
3. 在协调终端输入 `release`。协调器只会放行仍在执行的一份 Work。现成夹具为非流式，测试的是在途状态与持久终态。默认后端时限为 120 秒，离线步骤应在这个窗口内完成。协调器保存 `work-held.json` 与 `work-completed.json`，Linux 端 `record`、`capture` 可留存完成态。检查各观察端原消息、回复和 Journal 序号。
4. 如需留证，先拷贝经过核对的合成观察摘要或截图。退出 Windows 测试 Profile，移除本次 Android 转发与测试 WebView，在 Linux 终端输入 `stop` 后再在协调终端输入 `stop`。协调器关闭 ToolBox 和 Provider，并回收本次 `.runs/hardware/run-*` 中的合成数据库、证书、Profile 和运行日志。
