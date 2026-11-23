# Android 实体 Firefox PWA

候选 `a2a13b53555c55ca79844544d8802d61fc0cf3e0`。原实体手机运行 Android 16（API 36）和 Firefox 160.0.1。隔离 Android 用户 12 复用上次安装的 PWA。用户确认安装本轮公开测试 CA 后，经 USB 回环 HTTPS 从原有 Pin 启动。浏览器确认安全上下文、前台独立窗口、普通模式和 Service Worker 接管。JS、CSS、Manifest 及 Service Worker 从这同一页面读取，四项 SHA-256 与中央候选资产清单一致。设备只读 scope 为 `shared:sharedAB:read`。 [已安装入口](installed-launch.txt) · [已加载资产](02-assets.json)

同一手机窗口在中央短停时显示「离线」，服务以合成冷备份恢复后自动显示「已连接」。Firefox 进程、配对标记和已选群组不变。 [在线变化](04-group-timeline.ndjson) · [恢复后会话](05-group-central-rejoined.json)

## 群聊逐位接力

手机先后收到同一个话题的输入和 A、B、C 三条正式回复。按 DOM 读取的消息 ID、角色、正文和 SHA-256 与中央 Journal 一致。强停 Firefox 后重新从安装入口启动，PID 由 6113 变为 8220，原配对会话直接打开原话题，四条正式消息逐项一致。历史区域滚到最新处拍摄，完整顺序见 DOM 回执。 [在线终态](08-group-final.json) · [冷开 DOM](09-group-cold.json) · [冷开截图](09-group-cold.png)

普通页面的执行卡没有呈现这条桌面发起的群 Work。用同一已配对的 PWA，通过产品授权的只读 SSE 获取原 Work 首帧。B 接力完成后为 `dispatched`，已确认回复序号 5、6。Linux 第三位接力的 ACK 丢失期间，该 Work 仍为 `dispatched`，接力状态为 `continuing`，版本为 2，尚未确认序号 7。C 完成后和手机冷开后，原 Work 均为 `completed`，确认回复序号 5、6、7。 [B 后 Work](07-group-B-work.json) · [ACK 丢失期间 Work](07b-group-continue-ack-lost-work.json) · [冷开 Work](09-group-cold-work.json)

## 共享单聊 502 结清、删除与续发

手机先显示一条原用户输入和同 ID 的 `review_required` 执行卡，正式历史没有助手消息。Linux 结清后，原消息仍在，Work 卡变为 `cancelled` 并显示已记录人工核对。Linux 删除原用户消息后，手机自动变为空历史并继续保留原 Work 卡。中央对应 Journal 顺序为原消息 8、删除墓碑 9。 [502](12-single-502.png) · [结清](13-single-closed.json) · [删后空历史](14-single-deleted.png)

Linux 同一话题正常续发后，手机只显示新输入和新助手回复，对应中央 Journal 10、11。新 Work 显示 `completed`，原 Work 仍为 `cancelled`。第二次强停后 Firefox PID 从 8220 变为 11818，原配对自动开回此话题，消息和两个 Work 逐项一致。额外的单聊 SSE 快照查询在 502 阶段返回 HTTP 429，单聊 Work 以 PWA 本身的可见执行卡核对。截图保留设备的可见区域，完整消息正文见 DOM 回执。 [在线](15-single-final.json) · [冷开截图](16-single-cold.png) · [冷开 DOM](16-single-cold.json) · [中央比对](verified.json)

手机已恢复机主用户。隔离用户 12 的 Firefox、原 PWA Pin 和本轮 CA 留在隔离用户；CA 下载文件与 USB 转发已清理。 [清理回执](cleanup.json)
