# Android USB 发送验收

此入口使用实体设备上的临时 WebView 安装包 `dev.nativesync.qa.send`。安装包只信任本轮验收的公有 CA，访问指定的 HTTPS USB 回环端口。日用 Chrome 的数据、信任设置与会话无需参与。安装及卸载需要当前设备授权。

在仓库根目录以 Android 36 SDK、build-tools 35.0.0、JDK 和 Node 24+ 运行。设备需解锁并保持临时应用在前台。先启动隔离后端，取其公有 DER 证书，再安装：

```sh
tests/hardware/android-send/build-apk.sh "$public_ca_der" 18443 "$new_apk_dir"
adb install "$new_apk_dir/android-send.apk"
adb reverse tcp:18443 tcp:18443
node tests/hardware/android-send/phone.cjs 18443 start
```

启用隔离后端的单次配对路由后，执行 `phone.cjs 18443 pair`。它操作真实 PWA 配对表单。`pair-stop` 在首次出现「已连接」时立即强停，回报从观察到强停命令完成的时间，再用 `reopen` 和 `probe` 观察冷开。随后用 `select AGENT TOPIC` 选择可发送话题，或用 `select-readonly AGENT TOPIC` 选择只读话题。

`open-picker` 在实体 WebView 中点击网页的文件输入，打开 Android DocumentsUI 的 `NativeSync synthetic fixtures` 目录。确认目录和文件名后，在手机屏幕点击唯一的 `fixture-note.txt`，再用 `state` 核实附件已进入 PWA。测试壳只把自有合成文件 URI 交给 WebView。`compose TEXT` 填入合成文本。既有 `compose TEXT FIXTURE_FILE` 路径构造合成 Web File，适用于网页输入之后的检查。使用 `send` 点击页面发送，`retry` 点击核对，`preview` 打开已提交附件，`capture PREFIX` 记录实体屏幕和当前会话界面字段。截图仅在临时应用位于最前方时读取，存档前裁掉系统状态栏和导航区域。`reopen` 强停再打开同一包并保留其 WebView 数据。隔离后端更换新测试数据库后，可以卸载再安装临时包来创建新的客户端 Profile。

每条命令的 CDP forward 按次分配并回收。验收结束后卸载临时包，移除本轮 reverse 并确认：

```sh
adb uninstall dev.nativesync.qa.send
adb reverse --remove tcp:18443
adb forward --list
adb reverse --list
```
