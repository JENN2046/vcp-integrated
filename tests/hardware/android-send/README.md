# Android USB 发送验收

此入口使用实体设备上的临时 WebView 安装包 `dev.nativesync.qa.send`。安装包只信任本轮验收的公有 CA，访问指定的 HTTPS USB 回环端口。日用 Chrome 的数据、信任设置与会话无需参与。安装及卸载需要当前设备授权。

在仓库根目录以 Android 36 SDK、build-tools 35.0.0、JDK 和 Node 24+ 运行。设备需解锁并保持临时应用在前台。先启动隔离后端，取其公有 DER 证书，再安装：

```sh
tests/hardware/android-send/build-apk.sh "$public_ca_der" 18443 "$new_apk_dir"
adb install "$new_apk_dir/android-send.apk"
adb reverse tcp:18443 tcp:18443
node tests/hardware/android-send/phone.cjs 18443 start
```

启用隔离后端的单次配对路由后，执行 `phone.cjs 18443 pair`。它操作真实 PWA 配对表单。随后用 `select AGENT TOPIC` 选择测试话题，`compose TEXT [FIXTURE_FILE]` 可填入合成文本及附件。附件通过实际网页文件输入控件交给应用，测试脚本构造合成 Web File。使用 `send` 点击页面发送，`retry` 点击核对，`preview` 打开已提交附件，`capture PREFIX` 记录实体屏幕和当前会话界面字段。截图仅在临时应用位于最前方时读取，存档前裁掉系统状态栏和导航区域。`reopen` 强停再打开同一包并保留其 WebView 数据。隔离后端更换新测试数据库后，可以卸载再安装临时包来创建新的客户端 Profile。

每条命令的 CDP forward 按次分配并回收。验收结束后卸载临时包，移除本轮 reverse 并确认：

```sh
adb uninstall dev.nativesync.qa.send
adb reverse --remove tcp:18443
adb forward --list
adb reverse --list
```
