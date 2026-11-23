# a2a13b53555c 同库三端验收

固定提交 `a2a13b53555c55ca79844544d8802d61fc0cf3e0`。Linux、Windows B、实体 Android 安装版 PWA 通过各自回环接到同一合成 ToolBox。中央从已迁移并完成旧 v1 Work 的冷副本恢复，沿用 18443、测试 TLS、原配对会话、桌面 Profile 和两个测试话题 ID。恢复时 schema 3、旧群正式三行。新增三成员 Work 后升至 schema 4。复查确认旧 Work 与其 Journal 直到现场结束保持逐字段一致。

| 阶段 | 中央与 Linux |
| --- | --- |
| 真实顺序接力 | Linux A、Windows B、Linux A 分别执行 A、B、C。原 Work 完成，Journal seq 4–7 恰一条输入及三条正式回复。 |
| 丢失 Continue ACK | Linux 第三位 Continue 持久成功，TLS 夹具截断 HTTP 200 响应正文；Linux Electron SIGKILL 后同 Profile 重开，仍是原 Work、同原 History、两次模型调用。手动再次点继续重用原操作 ID 后只发起 C 一次。 |
| C 的原生上下文 | ToolBox Handler 和回环 Provider 中，A、B 的正式回复各只有一份，按原顺序进入 C。各自绑定中央的消息 ID、时间戳与内容 SHA-256。 |
| 普通单聊 502 | 首次 Provider HTTP 502 留用户行 seq 8、一个待核对 Work 和原生 unknown。确认放弃后 Work cancelled、准入 abandoned，未知请求与 Journal 保持。原作者用右键菜单和确认框删除 seq 8，中央同 ID 墓碑 seq 9；Linux 重开为空。 |
| 同题下一轮 | 新 Work 完成，seq 10 和 11 为新输入与回复。整轮 Provider 调用次序 A、B、C、502、200，无工具调用。 |

Windows B 自原窗口观察 A/C，同 Profile 正常重开后读回群聊原 Work 和四条物理 History。Android 原安装 PWA 保留只读配对，群聊及单聊均在线观察、强停冷开后回读。群聊正规消息由 PWA 显示，原 Work 状态使用同权限只读 SSE 核对。Windows 和 Android 各自的回执与本目录中央历史对照。

Linux 在中央暂停期间启动时显示 NETWORK_UNAVAILABLE，重新启动同 Profile 后恢复。502 的确认区最初一次点击没有发出结清 HTTP；随后一次未能等待到启用的确认按钮。用同 Profile 重开，等状态面板稳定、确认选中复选框后再次按原生按钮，取得唯一一次结清 HTTP 200，并保留原现象截图。

ToolBox 与 Linux 最后进程正常退出。候选冷库无 WAL/SHM，`quick_check=ok`，schema 4，共 11 条 Journal。测试叶私钥已清除。冷数据库及其独立回退副本留在隔离运行目录。

- [中央与 Linux 自动核对](verified.json)
- [最终中央数据](final-status.json)
- [原生运行加载来源与验证](verified-loaded.json)
- [最终冷库检查](final-database-check.json)
- [Linux ACK 丢失后重开](../linux/linux-group-ack-reopened.png)
- [Linux 单聊删除确认](../linux/linux-single-delete-confirmation.png)
- [Windows B](../windows/README.md)
- [实体 Android PWA](../android/README.md)
