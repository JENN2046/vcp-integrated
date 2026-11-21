# Electron 共享检查点重试

同一夹具在旧宿主 `95311dea107f` 和修复版各运行一次。Xvfb 中的 Electron 44.9.3 保持 Chromium 沙箱。A 和 B 使用各自的合成 Profile 和设备身份，连接同一套隔离的 ToolBox 和 SQLite。Provider 只在回环地址响应。

A 从消息菜单选择「压缩前文」。中央 `compact-commit` 返回 HTTP 200 并生成检查点。A 的严格读取到达 `lstat` 和 `open` 之间时，夹具以新 inode 原子替换同字节的合成 `history.json`。实际 `open/fstat` 安全检查拒绝旧 inode 的身份，A 的 IPC 返回 `HISTORY_IDENTITY_CHANGED`。夹具只触发一次，目标文件始终为普通单链接文件。最初现场的无注入 IPC 记录另附在基线 JSON 中。

| 从同一消息菜单再次点击「压缩前文」 | 旧宿主 | 修复版 |
| --- | --- | --- |
| 第二次菜单动作 | 新 intent 和新检查点 | 恢复相同 intent 和检查点 |
| 实际摘要 Provider 请求 | 2 次 | 1 次 |
| 中央 Journal 的检查点 | 2 条 | 1 条，重试前后 Journal 一致 |
| A 本地确认 | 无单独确认字段 | 失败后保持待确认，重试后完成 |

修复版中，A 正常退出后，B 用它原先的 Profile 重开并显示 A 的检查点。B 通过发送按钮提交一条新回复请求。丢失发送回执后，B 再次用原 Profile 重开，找回已完成的同一 Work。发送 POST、中央 Work、原生派发和真实工具写入各一次。经抓取的原生 handler、Provider 首轮与工具续轮输入均恰含一份原检查点，均保留 B 的新输入，均无已压缩旧文。B 的界面显示原检查点、新输入及原回复。

[旧宿主回执](baseline.json) · [修复版回执和实际模型请求](candidate.json)

在已构建的 Linux x64 检出执行 `node tests/integration/run.cjs compact-history-identity`。需要 Node 24、Xvfb 和可启用系统沙箱的 Electron，可用 `TMPDIR`、`XVFB_BIN`、`ELECTRON_BIN` 指定路径。旧宿主复跑使用 `95311dea107f` 的独立检出和相同测试夹具，预期在原 intent 恢复断言处失败。
