# 固定候选三端现场夹具

中央在同一 ToolBox、SQLite、测试 CA 和回环 Provider 上承载两个共享话题。设备 A、B 的桌面数据从同一合成目录注册表分别生成，手机配对只授予 `shared:sharedAB:read`。本目录的代码属于验收驱动。原生 Electron 主进程、渲染器、ToolBox 与 PWA 从指定候选检出和构建产物加载。

从固定提交 `a2a13b53555c55ca79844544d8802d61fc0cf3e0` 的独立检出，用 Node 24 安装依赖并重新构建。创建权限 0700 的新运行目录，并把本轮新生成的测试 CA PEM、CA DER、回环叶证书和叶私钥分别保存为 `hardware-ca.pem`、`hardware-ca.der`、`leaf.pem`、`leaf.key`。启动 `node tests/release-a2a13b53555c/central.cjs <candidate> <run>`。需要防止合成目录监视超额时设置 `NS_FIXTURE_POLL_WATCHERS=1`。中央对 `https://127.0.0.1:18443/mobile/` 提供候选 PWA。Windows 与实体 Android 使用各自隔离环境的回环转发。

中央命令 `arm-pair` 开启只用一次、90 秒有效的配对入口 `/__hardware/pair`。配对码通过同源 TLS 跳转交给手机，不写入回执。中央命令 `record <label>` 保存 Journal、Work、原生请求、Provider 和选定 HTTP 结果。

Linux A 在真实 Linux 显示器运行 `node tests/release-a2a13b53555c/linux.cjs <candidate> <run>`。命令 `group` 与 `single` 切换话题，`record <label>` 抓取画面、原生 History 与渲染状态。Windows B 用候选的 `tests/hardware/prepare-windows.cjs` 导入独立 Profile。两端先进入群聊，已安装的手机 PWA 同时打开对应话题。

1. Linux A 发 `group-start`，A 正式提交后录制中央 `group-first` 并确认 B/PWA 看见 A。
2. Windows B 点「接管到本端」「本端继续执行」。确认 B 正式提交并录制中央 `group-second`，等待 PWA 看见 B。
3. Linux A 发 `takeover` 与 `continue`。夹具截断第二次成功 Continue 的响应；确认中央 200 和成功持久写入，录制中央 `group-lost`。
4. Linux A 发 `crash-reopen`，待 UI 显示等待本端执行后录制中央 `group-reopened` 与 Linux `group-ack-reopened`，再发 `continue`。完成后录制中央 `group-completed` 与 Linux `group-complete`。Windows/PWA 记录最终群聊。
5. 三端切到普通单聊。Linux A 发 `single-first`。确认 502 且待人工核对后录制中央 `single-review`，Windows/PWA 观察原用户行。
6. Linux A 发 `settle`，录制中央 `single-settled`。Linux A 发 `delete`，确认删除后录制中央 `single-deleted` 与 Linux `single-deleted`，用 `reopen` 验证后录制 Linux `single-deleted-reopened`。Windows/PWA 观察删除。
7. Linux A 发 `single-next`，完成后录制 Linux `single-next`，Windows/PWA 读回最终两条。按顺序停止桌面、PWA、中央。中央退出写入最终状态与 Provider 上下文。

使用 `node tests/release-a2a13b53555c/verify-central.cjs <run>` 核对中央与 Linux 证据。公开回执可以保存内容全为合成数据的 JSON 和画面。认证配置、临时数据库和叶私钥留在隔离测试运行目录。

### 同一现场加入旧 Work 与回退

配对、取得设备绑定后暂停中央，保留独立的合成冷种子、原有 TLS 和 Profile。旧版服务端采用 `git archive af17c99 apps/server` 导出，使用锁定依赖。以独立 scratch 目录运行：

```bash
node tests/release-a2a13b53555c/upgrade.cjs prepare "$CANDIDATE" "$OLD_CHECKOUT" "$SCRATCH" "$COLD_SEED" "$EVIDENCE/upgrade.json"
```

旧原生模块在冷种子副本中创建 v1 Work，发布第一位回复并以 SQLite backup 保留 `before-v2.sqlite`。新版从该备份的另一副本续完旧 Work。协调器从 `candidate-with-stored-work.sqlite` 恢复，继续使用同一三端绑定。启用新版接力后，在独立副本上演练回退：

```bash
node tests/release-a2a13b53555c/upgrade.cjs rollback "$CANDIDATE" "$OLD_CHECKOUT" "$SCRATCH" "$SCHEMA4_SQLITE_BACKUP" "$EVIDENCE/rollback.json"
```

两阶段分别写入独立文件，以避免覆盖已留存的快照。
